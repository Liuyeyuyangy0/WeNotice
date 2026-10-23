'use strict';

/**
 * WeFlow / AstrWeChat 本地 HTTP API 数据源适配器。
 *
 * 能力：
 *  - 连通性与 Token 校验（/health + /api/v1/sessions）
 *  - SSE 实时推送（/api/v1/push/messages），断线指数退避重连
 *  - 心跳看门狗（长时间无数据视为断线）
 *  - 连接不稳定时自动降级为「会话轮询」拉取新消息
 */

const { EventEmitter } = require('events');
const { net } = require('electron');

const RECONNECT_BASE_MS = 1200;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 75000;

class WeFlowSource extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.status = { state: 'idle', message: '未启动', since: Date.now() };
    this.req = null;
    this.response = null;
    this.watchdog = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.retry = 0;
    this.manualStop = true;
    this.polling = false;
    this.seen = new Map(); // sessionId -> lastTimestamp
    this.lastDataAt = 0;
    this.gotFirstEvent = false;
  }

  get sourceConfig() {
    const cfg = this.getConfig() || {};
    return cfg.source || {};
  }

  get baseUrl() {
    return String(this.sourceConfig.baseUrl || '').replace(/\/+$/, '');
  }

  get token() {
    return String(this.sourceConfig.token || '').trim();
  }

  setStatus(state, message) {
    this.status = { state, message, since: Date.now(), at: Date.now() };
    this.emit('status', this.status);
  }

  async test() {
    const cfg = this.sourceConfig;
    if (!this.baseUrl) return { ok: false, error: '未填写 API 地址（默认 http://127.0.0.1:5031）' };
    const health = await this._json('/health', { timeout: 6000 });
    if (!health.ok) {
      return {
        ok: false,
        error: `无法连接 ${this.baseUrl}：${health.error || `HTTP ${health.status}`}。请确认 AstrWeChat / WeFlow 已启动并开启「API 服务」。`
      };
    }
    let sessionCount = null;
    let tokenValid = null;
    let wxReady = null;
    let wxError = '';
    if (this.token) {
      const sessions = await this._json('/api/v1/sessions?limit=500', { timeout: 8000, auth: true });
      if (sessions.ok) {
        tokenValid = true;
        wxReady = true;
        sessionCount = extractSessions(sessions.data).length;
      } else if (sessions.status === 401 || sessions.status === 403) {
        tokenValid = false;
      } else {
        // 认证已通过（非 401/403），但服务端拒绝返回会话：最常见的是 AstrWeChat 还没完成微信连接
        tokenValid = true;
        wxReady = false;
        wxError = describeSessionsFailure(sessions);
      }
    }
    let pushReady = null;
    try {
      pushReady = await this._probeStream();
    } catch (_err) {
      pushReady = false;
    }
    return {
      ok: tokenValid !== false && wxReady !== false,
      baseUrl: this.baseUrl,
      health: health.data,
      tokenValid,
      wxReady,
      sessionCount,
      pushReady,
      error:
        tokenValid === false
          ? 'Access Token 无效（请从 AstrWeChat 设置中复制最新 Token）'
          : wxReady === false
            ? wxError
            : '',
      hint: pushReady === false ? 'SSE 推送暂不可用：请确认已开启「主动推送」，否则将使用轮询回退。' : ''
    };
  }

  async connect() {
    this.stop();
    this.manualStop = false;
    this.retry = 0;
    this.gotFirstEvent = false;
    const cfg = this.sourceConfig;
    if (!cfg.baseUrl) {
      this.setStatus('no-config', '未配置 API 地址');
      return { ok: false, error: '未配置 API 地址' };
    }
    this.setStatus('connecting', '正在连接本地 API…');

    const health = await this._json('/health', { timeout: 5000 });
    if (!health.ok) {
      this.setStatus('error', health.error || `HTTP ${health.status}`);
      return { ok: false, error: health.error };
    }

    if (this.token) {
      const sessions = await this._json('/api/v1/sessions?limit=1', { timeout: 6000, auth: true });
      if (sessions.status === 401 || sessions.status === 403) {
        this.setStatus('error', 'Access Token 无效，请重新复制 Token');
        return { ok: false, error: 'token-invalid' };
      }
      if (!sessions.ok) {
        const message = describeSessionsFailure(sessions);
        this.setStatus('error', message);
        return { ok: false, error: message };
      }
    }

    this.setStatus('connecting', '已连通 API，正在建立实时推送…');
    this._openStream();
    return { ok: true };
  }

  stop() {
    this.manualStop = true;
    this._clearStream();
    this._stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this._isStoppedStatus()) this.setStatus('idle', '已停止监听');
  }

  _isStoppedStatus() {
    return ['idle', 'no-config', 'error'].includes(this.status.state);
  }

  _clearStream() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.req) {
      try {
        this.req.abort();
      } catch (_err) {
        /* noop */
      }
      this.req = null;
    }
    this.response = null;
  }

  _openStream() {
    this._clearStream();
    if (this.manualStop) return;
    const cfg = this.sourceConfig;
    const qs = this.token ? `?access_token=${encodeURIComponent(this.token)}` : '';
    const url = `${this.baseUrl}/api/v1/push/messages${qs}`;
    const req = net.request({ method: 'GET', url, redirect: 'manual' });
    this.req = req;
    if (this.token) req.setHeader('Authorization', `Bearer ${this.token}`);
    req.setHeader('Accept', 'text/event-stream');
    req.setHeader('Cache-Control', 'no-cache');

    let settled = false;
    let buffer = '';
    let eventName = '';
    let dataLines = [];

    const fail = (err) => {
      if (settled) return;
      settled = true;
      this.lastDataAt = Date.now();
      const fatal = err && err.fatal;
      this._clearStream();
      if (this.manualStop) return;
      if (fatal) {
        this.setStatus('error', err.message);
        this._stopPolling();
        return;
      }
      this._scheduleReconnect(err.message);
    };

    req.on('response', (res) => {
      this.response = res;
      if (res.statusCode === 401 || res.statusCode === 403) {
        fail(Object.assign(new Error('Access Token 无效，无法建立实时推送'), { fatal: true }));
        return;
      }
      if (res.statusCode !== 200) {
        res.on('data', () => {});
        res.on('end', () => fail(new Error(`推送接口返回 HTTP ${res.statusCode}`)));
        return;
      }

      this.retry = 0;
      this.lastDataAt = Date.now();
      this.setStatus('connected', '已连接 · 实时推送');
      if (this.polling) this._stopPolling();

      this.watchdog = setInterval(() => {
        if (this.manualStop) return;
        if (Date.now() - this.lastDataAt > HEARTBEAT_TIMEOUT_MS) {
          fail(new Error('推送连接超时（长时间无数据）'));
        }
      }, 15000);

      res.on('data', (chunk) => {
        this.lastDataAt = Date.now();
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line) {
            if (dataLines.length) {
              const text = dataLines.join('\n');
              dataLines = [];
              this._handleSsePayload(text, eventName);
            }
            eventName = '';
          } else if (line.startsWith(':')) {
            // comment / heartbeat
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      });

      res.on('end', () => fail(new Error('推送连接已结束')));
      res.on('error', (err) => fail(err));
    });

    req.on('error', (err) => fail(err));
    req.end();
  }

  _handleSsePayload(text, eventName) {
    if (!text) return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_err) {
      return;
    }
    const evt = Object.assign({}, payload);
    if (eventName && !evt.event) evt.event = eventName;
    if (!evt.event) evt.event = 'message.new';
    this.gotFirstEvent = true;
    this.lastDataAt = Date.now();
    this.emit('message', evt);
  }

  _scheduleReconnect(reason) {
    if (this.manualStop) return;
    const cfg = this.sourceConfig;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(1.8, this.retry));
    this.retry += 1;
    this.setStatus('reconnecting', `${reason || '连接中断'}，${(delay / 1000).toFixed(1)}s 后重连（第 ${this.retry} 次）`);
    if (this.retry >= 2 && cfg.pollFallback !== false) this._startPolling();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualStop) this._openStream();
    }, delay);
  }

  _startPolling() {
    if (this.polling) return;
    this.polling = true;
    const intervalSec = Math.max(10, Number(this.sourceConfig.pollIntervalSec) || 25);
    this.setStatus('reconnecting', `实时推送不稳定，已启用轮询回退（每 ${intervalSec}s）`);
    this._pollOnce();
    this.pollTimer = setInterval(() => this._pollOnce(), intervalSec * 1000);
  }

  _stopPolling() {
    this.polling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async _pollOnce() {
    if (this.manualStop) return;
    const sessions = await this._json('/api/v1/sessions?limit=300', { timeout: 10000, auth: true });
    if (!sessions.ok) return;
    const list = extractSessions(sessions.data);
    for (const session of list) {
      const id = String(session.username || session.id || '');
      if (!id) continue;
      const lastTimestamp = Number(session.lastTimestamp || 0);
      const seen = this.seen.get(id);
      if (seen === undefined) {
        // 首次轮询：把当前最后一条作为基线，避免拉取全部历史
        this.seen.set(id, lastTimestamp);
        continue;
      }
      if (lastTimestamp <= seen) continue;
      const pull = await this._json(
        `/api/v1/sessions/${encodeURIComponent(id)}/messages?since=${seen}&limit=200`,
        { timeout: 12000, auth: true }
      );
      if (!pull.ok) continue;
      const messages = extractMessages(pull.data);
      let maxTs = seen;
      for (const msg of messages) {
        const ts = Number(msg.createTime || 0);
        if (ts <= seen) continue;
        if (ts > maxTs) maxTs = ts;
        this.emit('message', mapPolledMessage(msg, session, id));
      }
      this.seen.set(id, maxTs);
      this.lastDataAt = Date.now();
    }
    if (this.status.state !== 'connected') {
      this.setStatus('connected', '已连接 · 轮询模式');
    }
  }

  /**
   * 回填最近消息：遍历最近活跃的会话，拉取 since 之后的消息。
   * 返回与 SSE 事件同构的数组，供主进程统一做分类/去重/入库。
   */
  async fetchRecent(options = {}) {
    const hours = Math.max(1, Math.min(72, Number(options.hours) || 12));
    const maxSessions = Math.max(1, Math.min(80, Number(options.maxSessions) || 30));
    const perSession = Math.max(1, Math.min(50, Number(options.perSession) || 15));
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const sres = await this._json('/api/v1/sessions?limit=300', { timeout: 10000, auth: true });
    if (!sres.ok) return [];
    const sessions = extractSessions(sres.data)
      .filter((s) => Number(s.lastTimestamp || 0) >= since)
      .sort((a, b) => Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
      .slice(0, maxSessions);
    const events = [];
    for (const session of sessions) {
      const id = String(session.username || session.id || '');
      if (!id) continue;
      const pull = await this._json(
        `/api/v1/sessions/${encodeURIComponent(id)}/messages?since=${since}&limit=${perSession}`,
        { timeout: 12000, auth: true }
      );
      if (!pull.ok || !pull.data) continue;
      const meta = pull.data.meta || {};
      const ownerId = String(meta.ownerId || '');
      const name = String(meta.name || session.displayName || session.nickname || id);
      const sessionType = meta.type === 'group' || id.endsWith('@chatroom')
        ? 'group'
        : id.startsWith('gh_') || meta.type === 'channel'
          ? 'official'
          : 'private';
      for (const msg of extractMessages(pull.data)) {
        const timestamp = Number(msg.timestamp || msg.createTime || 0);
        if (!timestamp || timestamp < since) continue;
        const senderId = String(msg.sender || msg.senderUsername || '');
        const content = String(msg.content != null ? msg.content : msg.parsedContent || '');
        events.push({
          event: 'message.new',
          sessionId: id,
          sessionType,
          rawid: String(msg.platformMessageId || msg.serverId || `${id}-${timestamp}`),
          sourceName: String(msg.accountName || session.displayName || name),
          senderUsername: senderId,
          groupName: sessionType === 'group' ? name : '',
          content,
          timestamp,
          isSend: Boolean(ownerId && senderId === ownerId),
          mediaType: guessMediaType(content),
          fromHistory: true
        });
      }
    }
    return events;
  }

  async _probeStream() {
    const qs = this.token ? `?access_token=${encodeURIComponent(this.token)}` : '';
    const url = `${this.baseUrl}/api/v1/push/messages${qs}`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        try {
          req.abort();
        } catch (_err) {
          /* noop */
        }
        resolve(value);
      };
      const req = net.request({ method: 'GET', url, redirect: 'manual' });
      if (this.token) req.setHeader('Authorization', `Bearer ${this.token}`);
      req.setHeader('Accept', 'text/event-stream');
      req.on('response', (res) => {
        const ok = res.statusCode === 200;
        res.on('data', () => finish(ok));
        res.on('end', () => finish(ok));
      });
      req.on('error', () => finish(false));
      req.end();
      setTimeout(() => finish(false), 3500);
    });
  }

  /** 通用 JSON GET，统一返回 {ok, status, data, error} */
  _json(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let req;
      try {
        req = net.request({ method: 'GET', url, redirect: 'manual' });
      } catch (err) {
        done({ ok: false, status: 0, error: err.message });
        return;
      }
      if (options.auth !== false && this.token) req.setHeader('Authorization', `Bearer ${this.token}`);
      req.setHeader('Accept', 'application/json');
      const timer = setTimeout(() => {
        try {
          req.abort();
        } catch (_err) {
          /* noop */
        }
        done({ ok: false, status: 0, error: '请求超时' });
      }, options.timeout || 8000);

      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            done({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode} ${text.slice(0, 160)}` });
            return;
          }
          try {
            done({ ok: true, status: res.statusCode, data: text ? JSON.parse(text) : null });
          } catch (err) {
            done({ ok: false, status: res.statusCode, error: `响应不是 JSON：${err.message}` });
          }
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          done({ ok: false, status: 0, error: err.message });
        });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, status: 0, error: err.message });
      });
      req.end();
    });
  }
}

/**
 * 把 /api/v1/sessions 的失败信息翻译成用户能照做的中文提示。
 * 典型场景：AstrWeChat 的 HTTP API 已经连通、Token 也正确，但还没完成
 * 「微信连接」（未配置微信 ID / 数据库密钥），此时服务端返回 500。
 */
function describeSessionsFailure(res) {
  const raw = String((res && res.error) || '').trim();
  const body = raw.replace(/^HTTP\s+\d+\s*/, '');
  if (/微信ID|微信 ID|配置微信|未连接|数据库/.test(raw)) {
    return 'AstrWeChat 尚未完成微信连接：请打开 AstrWeChat → 左侧「微信连接」完成微信 ID/数据库密钥获取并点「连接数据库」，然后再回来重试。';
  }
  if (res && res.status === 500) {
    return `AstrWeChat 服务端暂时无法提供会话数据（${body || 'HTTP 500'}）。请检查 AstrWeChat「运行日志」或确认微信客户端已登录。`;
  }
  return `无法读取会话列表：${body || '未知错误'}。请确认 AstrWeChat 已正常启动并开启「API 服务」。`;
}

function extractSessions(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.sessions)) return data.sessions;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function extractMessages(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function mapPolledMessage(msg, session, sessionId) {
  const sessionType = sessionId.endsWith('@chatroom')
    ? 'group'
    : sessionId.startsWith('gh_')
      ? 'official'
      : 'private';
  return {
    event: 'message.new',
    sessionId,
    sessionType,
    rawid: String(msg.serverId || msg.localId || `${sessionId}-${msg.createTime || Date.now()}`),
    sourceName: String(msg.senderUsername || session.displayName || session.nickname || ''),
    groupName: sessionType === 'group' ? String(session.displayName || session.nickname || sessionId) : '',
    content: String(msg.parsedContent || msg.content || ''),
    timestamp: Number(msg.createTime || Math.floor(Date.now() / 1000)),
    mediaType: String(msg.mediaType || 'text'),
    isSend: Boolean(msg.isSend)
  };
}

function guessMediaType(content) {
  const text = String(content == null ? '' : content);
  if (/^\[(图片|动画表情)\]$/.test(text)) return 'image';
  if (/^\[视频\]$/.test(text)) return 'video';
  if (/^\[语音\]$/.test(text)) return 'voice';
  if (/^\[(文件|文档|压缩包)\]$/.test(text)) return 'file';
  return 'text';
}

module.exports = { WeFlowSource, extractSessions, extractMessages };
