'use strict';

/**
 * QQ 数据源：通过 OneBot 11 协议（WebSocket 服务端模式）接收 QQ 消息。
 *
 * 推荐搭配 NapCatQQ（https://github.com/NapNeko/NapCatQQ）：它在 QQNT 上跑一个
 * OneBot 11 服务端，暴露 WebSocket 地址（默认 ws://127.0.0.1:3001）。
 * 本模块只做「只读接收」，不发送任何 QQ 消息。
 */

const { EventEmitter } = require('events');

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;
const CONNECT_TIMEOUT_MS = 12000;

function normalizeBaseUrl(value) {
  const str = String(value || '').trim();
  if (!str) return '';
  if (/^wss?:\/\//i.test(str)) return str.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(str)) return str.replace(/^http/i, 'ws').replace(/\/+$/, '');
  return `ws://${str.replace(/\/+$/, '')}`;
}

/** 把 OneBot 11 的 message（字符串 CQ 码或消息段数组）转成纯文本。 */
function renderOneBotMessage(message) {
  const parts = [];
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue;
      const type = String(seg.type || '');
      const data = seg.data || {};
      if (type === 'text') parts.push(String(data.text || ''));
      else if (type === 'at') parts.push(`@${data.name || data.qq || ''}`.trim() || '@');
      else if (type === 'image') parts.push('[图片]');
      else if (type === 'face') parts.push('[表情]');
      else if (type === 'mface') parts.push('[表情]');
      else if (type === 'record') parts.push('[语音]');
      else if (type === 'video') parts.push('[视频]');
      else if (type === 'file') parts.push('[文件]');
      else if (type === 'json' || type === 'xml') parts.push('[卡片消息]');
      else if (type === 'forward') parts.push('[聊天记录]');
      else if (type === 'reply') {
        /* 引用回复本身不展示 */
      } else if (type === 'dice' || type === 'rps') parts.push('[互动表情]');
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  let text = String(message || '');
  // 去 CQ 码：保留 at/文本，其余转占位符
  text = text
    .replace(/\[CQ:at,[^\]]*qq=([^,\]]+)[^\]]*\]/g, '@$1')
    .replace(/\[CQ:image[^\]]*\]/gi, '[图片]')
    .replace(/\[CQ:face[^\]]*\]/gi, '[表情]')
    .replace(/\[CQ:mface[^\]]*\]/gi, '[表情]')
    .replace(/\[CQ:record[^\]]*\]/gi, '[语音]')
    .replace(/\[CQ:video[^\]]*\]/gi, '[视频]')
    .replace(/\[CQ:file[^\]]*\]/gi, '[文件]')
    .replace(/\[CQ:json[^\]]*\]/gi, '[卡片消息]')
    .replace(/\[CQ:xml[^\]]*\]/gi, '[卡片消息]')
    .replace(/\[CQ:forward[^\]]*\]/gi, '[聊天记录]')
    .replace(/\[CQ:reply[^\]]*\]/gi, '')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/\s+/g, ' ');
  return text.trim();
}

function guessMediaType(message) {
  const text = renderOneBotMessage(message);
  if (/^\[图片\]$/.test(text)) return 'image';
  if (/^\[语音\]$/.test(text)) return 'voice';
  if (/^\[视频\]$/.test(text)) return 'video';
  if (/^\[文件\]$/.test(text)) return 'file';
  return 'text';
}

class QqSource extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.socket = null;
    this.state = 'disabled';
    this.message = '未启用';
    this.retry = 0;
    this.stopped = true;
    this.selfId = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.pendingTest = null;
  }

  get cfg() {
    const config = this.getConfig() || {};
    return config.qq || {};
  }

  get baseUrl() {
    return normalizeBaseUrl(this.cfg.wsUrl || 'ws://127.0.0.1:3001');
  }

  setStatus(state, message) {
    this.state = state;
    this.message = message || '';
    this.emit('status', { state, message: this.message, selfId: this.selfId || '' });
    if (this.pendingTest && (state === 'connected' || state === 'error')) {
      const resolve = this.pendingTest;
      this.pendingTest = null;
      resolve({ state, message: this.message });
    }
  }

  connect() {
    const cfg = this.cfg;
    if (!cfg.enabled) {
      this.setStatus('disabled', 'QQ 数据源未启用');
      return { ok: false, error: 'QQ 数据源未启用' };
    }
    const url = this.baseUrl;
    if (!url) {
      this.setStatus('error', '未配置 QQ OneBot WebSocket 地址');
      return { ok: false, error: '未配置 WebSocket 地址' };
    }
    this.stopped = false;
    this.retry = 0;
    this._open();
    return { ok: true, url };
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_err) {
        /* noop */
      }
      this.socket = null;
    }
    this.setStatus('disabled', '已断开');
  }

  _open() {
    const cfg = this.cfg;
    let url = this.baseUrl;
    if (cfg.token) url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(cfg.token)}`;

    this.setStatus(this.retry > 0 ? 'reconnecting' : 'connecting', this.retry > 0 ? '正在重连 QQ 数据源…' : '正在连接 QQ 数据源…');
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.setStatus('error', `无法创建 WebSocket：${err.message || err}`);
      this._scheduleReconnect();
      return;
    }
    this.socket = socket;

    this.connectTimer = setTimeout(() => {
      if (this.socket === socket && this.state !== 'connected') {
        try {
          socket.close();
        } catch (_err) {
          /* noop */
        }
        this.setStatus('error', '连接 QQ OneBot 超时：请确认 NapCat 已启动并开启 WebSocket 服务端');
        this._scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.retry = 0;
      this.selfId = null;
      this.setStatus('connecting', '已连接 OneBot 服务，等待机器人账号信息…');
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      let data;
      try {
        data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch (_err) {
        return;
      }
      this._handleEvent(data);
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.setStatus('error', 'QQ 数据源连接错误：请确认 NapCat 地址/Token');
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      if (this.stopped) return;
      if (this.state !== 'error') this.setStatus('reconnecting', 'QQ 数据源已断开，准备重连…');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.retry += 1;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.8, this.retry - 1), RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this._open();
    }, delay);
  }

  _handleEvent(data) {
    if (!data || typeof data !== 'object') return;
    if (data.post_type === 'meta_event') {
      if (data.meta_event_type === 'lifecycle' && data.sub_type === 'connect') {
        this.selfId = data.self_id || null;
        this.setStatus('connected', `QQ 数据源已连接${this.selfId ? `（账号 ${this.selfId}）` : ''}`);
      }
      return;
    }
    if (data.post_type !== 'message') return;
    const evt = this._normalize(data);
    if (evt) this.emit('message', evt);
  }

  _normalize(event) {
    const messageType = event.message_type || (event.group_id ? 'group' : 'private');
    const selfId = String(event.self_id || '');
    const userId = String(event.user_id || '');
    if (selfId && userId && selfId === userId) return null; // 自己发的消息
    if (event.post_type === 'message_sent') return null;
    const rawid = String(event.message_id || `${userId}-${event.time || Date.now()}`);
    const sender = (event.sender && (event.sender.card || event.sender.nickname)) || userId;
    const content = renderOneBotMessage(event.message);
    if (!content) return null;
    const isGroup = messageType === 'group';
    const groupId = isGroup ? String(event.group_id || '') : '';
    const sessionId = isGroup ? `qq-group-${groupId}` : `qq-private-${userId}`;
    const groupLabel = isGroup ? `QQ 群 ${groupId}` : '';
    return {
      event: 'message.new',
      sessionId,
      sessionType: isGroup ? 'group' : 'private',
      rawid,
      sourceName: String(sender),
      senderUsername: String(sender),
      groupName: groupLabel,
      content,
      timestamp: Number(event.time) || Math.floor(Date.now() / 1000),
      isSend: false,
      mediaType: guessMediaType(event.message)
    };
  }

  /** 测试连接：连上并等待 OneBot lifecycle，最多 waitMs 毫秒。 */
  test(waitMs = 8000) {
    const url = this.baseUrl;
    if (!this.cfg.enabled) return Promise.resolve({ ok: false, error: 'QQ 数据源未启用', hint: '在设置 → QQ 数据源里打开「启用 QQ 消息接收」' });
    if (!url) return Promise.resolve({ ok: false, error: '未配置 WebSocket 地址' });
    return new Promise((resolve) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pendingTest = null;
        try {
          socket.close();
        } catch (_err) {
          /* noop */
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, url, error: '连接超时：请确认 NapCat 已启动并开启 WebSocket 服务端' }), waitMs);

      this.pendingTest = (st) => {
        if (st.state === 'connected') finish({ ok: true, url, selfId: this.selfId || '', message: st.message });
        else if (st.state === 'error') finish({ ok: false, url, error: st.message });
      };

      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        finish({ ok: false, url, error: err.message || String(err) });
        return;
      }
      this._testSocket = socket;
      socket.addEventListener('message', (event) => {
        if (finished) return;
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
          if (data && data.post_type === 'meta_event') {
            if (data.meta_event_type === 'lifecycle') {
              this.selfId = data.self_id || null;
              finish({ ok: true, url, selfId: String(data.self_id || ''), message: 'OneBot 握手成功' });
            }
          }
        } catch (_err) {
          /* ignore */
        }
      });
      socket.addEventListener('error', () => finish({ ok: false, url, error: 'WebSocket 连接失败：检查地址/端口/Token' }));
      socket.addEventListener('close', () => {
        if (!finished) finish({ ok: false, url, error: '连接被关闭：检查 Token 是否正确' });
      });
    });
  }
}

module.exports = { QqSource, normalizeBaseUrl, renderOneBotMessage };
