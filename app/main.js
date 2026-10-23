'use strict';

const { app, BrowserWindow, Notification, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { Store } = require('./lib/store');
const { WeFlowSource } = require('./lib/source');
const { DemoSource } = require('./lib/demo');
const { AIClassifier } = require('./lib/ai');
const AstrWechat = require('./lib/astr');
const { evaluate, CATEGORIES, normalizeRule, RULE_TEMPLATES, normalizeText } = require('./lib/rules');
const { humanizeContent } = require('./lib/content');

// 启动诊断日志（仅当设置了 WENOTICE_BOOT_LOG 时生效，用于排查打包/启动问题）
const BOOT_LOG = process.env.WENOTICE_BOOT_LOG || '';
function bootLog(message) {
  if (!BOOT_LOG) return;
  try {
    fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch (_err) {
    /* noop */
  }
}
bootLog(`bootstrap: packaged=${app.isPackaged} argv=${JSON.stringify(process.argv)}`);

// ---------------------------------------------------------------------------
// 运行环境
// ---------------------------------------------------------------------------

const argv = process.argv.slice(1);
const getArg = (name, fallback = '') => {
  const prefix = `--${name}=`;
  const hit = argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const SHOT_PATH = getArg('shot', '');
const SHOT_DELAY = Number(getArg('shot-delay', '5200')) || 5200;
const SHOT_SELECT = getArg('select', '');
const SHOT_CLICK = getArg('click', '');
const SHOT_JS = getArg('shot-js', '');
const OPEN_PAGE = getArg('page', '');
const IS_SHOT = Boolean(SHOT_PATH);

if (!app.isPackaged) {
  const devData = process.env.WENOTICE_DATA_DIR || path.join(__dirname, '..', '.data');
  try {
    fs.mkdirSync(devData, { recursive: true });
  } catch (_err) {
    /* noop */
  }
  app.setPath('userData', devData);
}
app.setAppUserModelId('com.wenotice.filter');

const ASSET_DIR = path.join(__dirname, 'assets');
const APP_ICON = path.join(ASSET_DIR, 'icon.png');
const TRAY_ICON = path.join(ASSET_DIR, 'tray.png');

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let store = null;
let source = null;
let demo = null;
let ai = null;
let paused = false;
let demoActive = false;
let isQuitting = false;
let stateBroadcastTimer = null;
let trayRefreshTimer = null;
const lastNotifiedAt = new Map(); // sessionId -> ms
const notifyHistory = []; // 最近一分钟的通知时间戳
let lastFocusId = '';

const MERGE_MAP_LIMIT = 300;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function config() {
  return store ? store.config : {};
}

function categoryLabel(category) {
  return (CATEGORIES[category] && CATEGORIES[category].label) || '其他';
}

function makeRecord(evt, origin, opts = {}) {
  if (!evt || typeof evt !== 'object') return null;
  if (evt.event && evt.event !== 'message.new' && evt.event !== 'message.revoke') return null;

  const normalized = humanizeContent(evt.content);
  const content = normalizeText(normalized.text);
  const kind = normalized.kind;
  const sessionId = String(evt.sessionId || evt.talker || 'unknown');
  const sessionType = normalizeSessionType(evt, sessionId);
  const groupName = evt.groupName ? String(evt.groupName) : '';
  const sender = String(evt.sourceName || evt.sender || '');
  const sessionName = groupName || sender || sessionId;
  const event = kind === 'revoke' ? 'message.revoke' : evt.event || 'message.new';
  const rawid = String(evt.rawid || evt.serverId || `${sessionId}:${evt.timestamp || nowSeconds()}:${hash(content)}`);
  const id = `${event}:${rawid}`;

  if (!content && !evt.mediaType) return null;

  const verdict = evaluate(
    {
      content,
      kind,
      sender,
      sessionName,
      groupName,
      sessionId,
      sessionType,
      mediaType: evt.mediaType ? String(evt.mediaType) : 'text',
      isSend: Boolean(evt.isSend),
      event
    },
    { rules: store.rules, config: store.config }
  );

  const record = {
    id,
    source: origin,
    sessionId,
    sessionType,
    sessionName,
    groupName,
    sender,
    content,
    kind,
    url: normalized.url || '',
    rawContent: kind === 'text' ? '' : String(evt.content || '').slice(0, 1500),
    mediaType: evt.mediaType ? String(evt.mediaType) : 'text',
    event,
    timestamp: Number(evt.timestamp || nowSeconds()),
    receivedAt: Date.now(),
    fromHistory: Boolean(opts.fromHistory),
    category: verdict.category,
    categoryLabel: categoryLabel(verdict.category),
    level: verdict.action,
    reason: verdict.reason,
    ruleName: verdict.ruleName || '',
    ruleId: verdict.ruleId || '',
    read: Boolean(opts.fromHistory),
    favorite: false,
    ignored: false,
    ai: null,
    isDemo: origin === 'demo'
  };

  if (store.history.some((m) => m.id === record.id)) return null;
  store.addMessage(record);
  return record;
}

function normalizeSessionType(evt, sessionId) {
  const raw = String(evt.sessionType || '').toLowerCase();
  if (['group', 'chatroom'].includes(raw)) return 'group';
  if (['private', 'friend', 'single'].includes(raw)) return 'private';
  if (['official', 'official_account', 'public'].includes(raw)) return 'official';
  if (['system', 'service', 'helper'].includes(raw)) return 'system';
  if (sessionId.endsWith('@chatroom')) return 'group';
  if (sessionId.startsWith('gh_')) return 'official';
  return 'private';
}

function hash(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex').slice(0, 12);
}

function getStats() {
  const inbox = store.history.filter((m) => m.level !== 'ignore');
  const unread = inbox.filter((m) => !m.read && !m.ignored).length;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const today = inbox.filter((m) => Number(m.timestamp || 0) * 1000 >= todayMs).length;
  return { total: store.history.length, inbox: inbox.length, unread, today };
}

function isDndActive() {
  const cfg = config().notify || {};
  if (!cfg.dndEnabled) return false;
  const [sh, sm] = String(cfg.dndStart || '22:30').split(':').map(Number);
  const [eh, em] = String(cfg.dndEnd || '08:00').split(':').map(Number);
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = (sh || 0) * 60 + (sm || 0);
  const end = (eh || 0) * 60 + (em || 0);
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function isImportantCategory(category) {
  return ['notice', 'mention', 'security', 'finance', 'logistics', 'schedule', 'work', 'file'].includes(category);
}

function canNotify(record) {
  if (paused || demoActive === null) return false;
  if (!config().notify || config().notify.desktop === false) return false;
  if (record.level !== 'notify') return false;
  if (isDndActive()) return false;
  if (config().notify.onlyImportant && !isImportantCategory(record.category)) return false;

  const mergeWindow = Number(config().notify.mergeWindowSec || 0) * 1000;
  const sessionKey = record.sessionId;
  const last = lastNotifiedAt.get(sessionKey) || 0;
  if (mergeWindow > 0 && record.receivedAt - last < mergeWindow) return false;
  lastNotifiedAt.set(sessionKey, record.receivedAt);
  if (lastNotifiedAt.size > MERGE_MAP_LIMIT) {
    const oldestKey = lastNotifiedAt.keys().next().value;
    lastNotifiedAt.delete(oldestKey);
  }

  const maxPerMinute = Number(config().notify.maxPerMinute || 0);
  if (maxPerMinute > 0) {
    const cutoff = Date.now() - 60000;
    while (notifyHistory.length && notifyHistory[0] < cutoff) notifyHistory.shift();
    if (notifyHistory.length >= maxPerMinute) return false;
    notifyHistory.push(Date.now());
  }
  return true;
}

function showDesktopNotification(record) {
  if (paused) return;
  if (!canNotify(record)) return;
  if (!Notification.isSupported()) return;
  const cfg = config().notify || {};
  const sessionTitle = record.groupName || record.sender || record.sessionName;
  const bodyPrefix = record.groupName && record.sender ? `${record.sender}：` : '';
  const body = `${bodyPrefix}${truncate(record.content || `[${record.mediaType || '消息'}]`, 120)}`;
  const notification = new Notification({
    title: `${record.categoryLabel} · ${truncate(sessionTitle, 30)}`,
    body,
    icon: APP_ICON,
    silent: cfg.sound === false,
    timeoutType: 'default'
  });
  notification.on('click', () => {
    showWindow();
    lastFocusId = record.id;
    sendEvent({ type: 'focus', id: record.id });
  });
  notification.show();
}

function truncate(text, max) {
  const str = String(text || '').replace(/\s+/g, ' ').trim();
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// ---------------------------------------------------------------------------
// 消息入站
// ---------------------------------------------------------------------------

function ingestEvent(evt, origin, opts = {}) {
  const record = makeRecord(evt, origin, opts);
  if (!record) return null;

  sendEvent({ type: 'messages:add', payload: record });
  if (!opts.fromHistory) showDesktopNotification(record);
  scheduleStateBroadcast();
  if (!opts.fromHistory) maybeClassifyWithAI(record);
  return record;
}

function maybeClassifyWithAI(record) {
  if (!ai || !ai.enabled) return;
  if (record.event === 'message.revoke' || record.isSend) return;
  if (record.level === 'notify') return; // 已提醒的不重复判定
  const mode = ai.config.mode || 'fallback';
  if (mode === 'unknown-only' && !['普通聊天', '媒体消息'].includes(record.reason)) return;

  ai.classify({
    sessionName: record.groupName || record.sender,
    sender: record.sender,
    content: record.content
  }).then((result) => {
    if (!result || !result.notice) return;
    if (record.level === 'notify') return;
    record.level = 'notify';
    record.category = result.category;
    record.categoryLabel = categoryLabel(result.category);
    record.reason = `AI 辅助 · ${result.reason || '语义判定为通知'}`;
    record.summary = result.summary || '';
    record.ai = result;
    store.updateMessage(record.id, record);
    sendEvent({ type: 'messages:patch', payload: record });
    showDesktopNotification(record);
    scheduleStateBroadcast();
  }).catch(() => {
    /* 静默降级 */
  });
}

// ---------------------------------------------------------------------------
// 数据源 / 演示模式
// ---------------------------------------------------------------------------

function startDemo(options = {}) {
  stopSource();
  demoActive = true;
  if (store) store.dropDemoMessages();
  if (!demo) {
    demo = new DemoSource();
    demo.on('message', (evt) => ingestEvent(evt, 'demo'));
  }
  demo.start({ fast: options.fast === true });
  source.setStatus('demo', '演示模式 · 样例消息流');
  broadcastState();
}

function stopDemo() {
  if (demo) demo.stop();
  demoActive = false;
}

function stopSource() {
  if (source) source.stop();
}

async function startSource() {
  stopDemo();
  const cfg = config().source || {};
  if (!cfg.baseUrl) {
    source.setStatus('no-config', '未配置 API 地址');
    return { ok: false, error: '未配置 API 地址' };
  }
  if (!cfg.token) {
    source.setStatus('no-config', '尚未填写 Access Token');
    return { ok: false, error: '尚未填写 Access Token' };
  }
  return source.connect();
}

let sourceStarting = false;

/**
 * 完整启动流程（打开应用 / 保存设置 / 手动重连时调用）：
 *  1) 检查是否配置了 API 地址与 Token；
 *  2) 本地 API 不可达且允许自动拉起时，定位并启动 AstrWeChat；
 *  3) 轮询 /health 等待 API 就绪（最多 30s），再建立 SSE 实时推送。
 */
async function ensureSourceReady() {
  const cfg = config().source || {};
  if (!cfg.baseUrl) {
    source.setStatus('no-config', '未配置 API 地址');
    return { ok: false, error: '未配置 API 地址' };
  }
  if (!cfg.token) {
    source.setStatus('no-config', '尚未填写 Access Token');
    return { ok: false, error: '尚未填写 Access Token' };
  }
  if (sourceStarting) return { ok: false, error: '正在启动中' };
  sourceStarting = true;
  try {
    const base = AstrWechat.normalizeBaseUrl(cfg.baseUrl);
    const health = await AstrWechat.probeHealth(base, 2500);
    if (!health.ok) {
      if (cfg.autoLaunchAstrWechat === false) {
        source.setStatus('error', `AstrWeChat 未运行（已关闭自动启动）：${health.error || ''}`);
        return { ok: false, error: health.error || 'not-running' };
      }
      const running = await AstrWechat.isRunning();
      if (!running) {
        source.setStatus('launching', 'AstrWeChat 未运行，正在自动启动…');
        const exePath = await AstrWechat.findAstrWechat(cfg.astrwechatPath);
        if (!exePath) {
          source.setStatus('error', '未找到 AstrWeChat，请先安装，或在设置里手动指定 AstrWeChat.exe 路径');
          return { ok: false, error: 'astrwechat-not-found' };
        }
        const launched = await AstrWechat.launchAstrWechat(exePath);
        if (!launched.ok) {
          source.setStatus('error', launched.error || '启动 AstrWeChat 失败');
          return { ok: false, error: launched.error };
        }
      } else {
        source.setStatus('launching', 'AstrWeChat 已在运行，正在等待本地 API 就绪…');
      }
      const waited = await AstrWechat.waitForHealth(base, {
        timeoutMs: 30000,
        intervalMs: 1200,
        onTick: (sec) => source.setStatus('launching', `正在等待 AstrWeChat 本地 API 就绪…（${sec}s）`)
      });
      if (!waited.ok) {
        const stillRunning = await AstrWechat.isRunning();
        source.setStatus(
          'error',
          stillRunning
            ? 'AstrWeChat 已在运行，但本地 API 未响应：请在 AstrWeChat「设置」中开启 API 服务，并确认地址与端口一致'
            : `AstrWeChat 启动失败（${waited.error || '超时'}），请手动打开 AstrWeChat 后重试`
        );
        return { ok: false, error: 'health-timeout' };
      }
    }
    return startSource();
  } finally {
    sourceStarting = false;
  }
}

let backfilled = false;

/**
 * 连接成功后回填最近一段消息（默认 12 小时）。
 * 这样应用第一次连上时就能看到最近的公告/验证码，而不是空列表；
 * 回填的消息不会触发桌面通知，只进入列表。
 */
async function maybeBackfillRecent() {
  if (backfilled) return;
  if (!source || typeof source.fetchRecent !== 'function') return;
  const cfg = config().source || {};
  if (cfg.backfillRecent === false) return;
  backfilled = true;
  const hours = Math.max(1, Math.min(72, Number(cfg.backfillHours) || 12));
  try {
    source.setStatus('connected', '已连接 · 正在回填最近消息…');
    const events = await source.fetchRecent({ hours, maxSessions: 30, perSession: 15 });
    let added = 0;
    for (const evt of events) {
      if (ingestEvent(evt, 'weflow', { fromHistory: true })) added += 1;
    }
    if (source.status.state === 'connected') {
      source.setStatus('connected', `已连接 · 实时推送${added ? ` · 已回填 ${added} 条` : ''}`);
    }
    broadcastState();
  } catch (_err) {
    /* 回填失败不影响实时推送 */
  }
}

function onSourceStatus(status) {
  sendEvent({ type: 'source:status', payload: status });
  scheduleStateBroadcast();
  scheduleTrayRefresh();
  if (status.state === 'connected') {
    maybeBackfillRecent();
  } else if (status.state === 'error' || status.state === 'no-config') {
    backfilled = false;
  }
}

// ---------------------------------------------------------------------------
// 广播 / 事件
// ---------------------------------------------------------------------------

function sendEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('we:event', payload);
}

function statePayload() {
  return {
    config: store.config,
    rules: store.rules,
    status: source ? source.status : { state: 'idle', message: '未启动' },
    paused,
    demo: demoActive,
    stats: getStats(),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    dataDir: store.dataDir,
    lastFocusId,
    categories: CATEGORIES,
    templates: RULE_TEMPLATES
  };
}

function broadcastState() {
  sendEvent({ type: 'state', payload: statePayload() });
}

function scheduleStateBroadcast() {
  if (stateBroadcastTimer) return;
  stateBroadcastTimer = setTimeout(() => {
    stateBroadcastTimer = null;
    broadcastState();
    scheduleTrayRefresh();
  }, 250);
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

function trayImage() {
  const img = nativeImage.createFromPath(TRAY_ICON);
  return img.isEmpty() ? nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 }) : img;
}

function scheduleTrayRefresh() {
  if (trayRefreshTimer) return;
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null;
    refreshTray();
  }, 400);
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const stats = getStats();
  const status = source ? source.status : { state: 'idle', message: '未启动' };
  const statusText =
    status.state === 'connected'
      ? '● 已连接，正在监听'
      : status.state === 'demo'
        ? '● 演示模式'
        : status.state === 'reconnecting'
          ? `● 重连中：${truncate(status.message, 28)}`
          : status.state === 'connecting'
            ? '● 正在连接…'
            : `● ${truncate(status.message || '未连接', 30)}`;

  const menu = Menu.buildFromTemplate([
    { label: `WeNotice${stats.unread ? ` · ${stats.unread} 条未读` : ''}`, enabled: false },
    { label: statusText, enabled: false },
    { type: 'separator' },
    {
      label: '打开通知中心',
      click: () => showWindow()
    },
    {
      label: paused ? '恢复提醒' : '暂停提醒',
      type: 'checkbox',
      checked: paused,
      click: () => {
        paused = !paused;
        broadcastState();
        scheduleTrayRefresh();
      }
    },
    {
      label: '演示模式',
      type: 'checkbox',
      checked: demoActive,
      click: () => {
        if (demoActive) {
          stopDemo();
          broadcastState();
        } else {
          startDemo();
        }
        scheduleTrayRefresh();
      }
    },
    { type: 'separator' },
    { label: '设置…', click: () => openSettings() },
    { label: '退出 WeNotice', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`WeNotice · ${stats.unread} 条未读`);
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        showWindow();
      }
    });
    tray.on('double-click', () => showWindow());
    refreshTray();
    bootLog(`tray created: imageEmpty=${trayImage().isEmpty()} destroyed=${tray.isDestroyed()}`);
  } catch (err) {
    bootLog(`tray FAILED: ${err.message}`);
    console.error('[tray] 创建托盘失败:', err.message);
  }
}

let trayHintShown = false;

/** 第一次最小化到托盘时，用系统气泡提示图标在哪，避免用户以为窗口丢了。 */
function showTrayHint() {
  if (trayHintShown) return;
  trayHintShown = true;
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.displayBalloon({
      icon: trayImage(),
      title: 'WeNotice 已最小化到系统托盘',
      content: '仍在后台监听微信消息。点任务栏右下角「^」里的 WeNotice 图标即可恢复；可在 设置 → 应用 关闭「最小化到托盘」。'
    });
  } catch (_err) {
    /* 个别系统不支持气泡，忽略 */
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0b0d12',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    title: 'WeNotice',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('console-message', (...args) => {
    if (app.isPackaged) return;
    const first = args[0];
    if (first && typeof first === 'object' && first.message) {
      console.log(`[renderer:${first.level}] ${first.message} (${first.sourceId}:${first.lineNumber})`);
    } else {
      const [, level, message, line, sourceId] = args;
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_SHOT) {
      setTimeout(captureAndQuit, SHOT_DELAY);
    }
  });

  mainWindow.on('close', (event) => {
    if (isQuitting || IS_SHOT) return;
    if (config().app && config().app.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('minimize', (event) => {
    if (isQuitting || IS_SHOT) return;
    const appCfg = config().app || {};
    if (appCfg.minimizeToTray === false) return;
    if (!tray || tray.isDestroyed()) return;
    event.preventDefault();
    mainWindow.hide();
    showTrayHint();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  if (OPEN_PAGE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => sendEvent({ type: 'open-page', page: OPEN_PAGE }), 400);
    });
  }
}

async function captureAndQuit() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      app.exit(1);
      return;
    }
    if (SHOT_SELECT) {
      try {
        await mainWindow.webContents.executeJavaScript(
          `(function(){var el=document.querySelector(".msg-card"); if(!el) return false; el.click(); return true;})()`
        );
        await new Promise((resolve) => setTimeout(resolve, 600));
      } catch (_err) {
        /* noop */
      }
    }
    if (SHOT_CLICK) {
      for (const selector of SHOT_CLICK.split('|').filter(Boolean)) {
        try {
          await mainWindow.webContents.executeJavaScript(
            `(function(){var el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; el.click(); return true;})()`
          );
          await new Promise((resolve) => setTimeout(resolve, 350));
        } catch (_err) {
          /* noop */
        }
      }
    }
    if (SHOT_JS) {
      try {
        await mainWindow.webContents.executeJavaScript(SHOT_JS);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } catch (err) {
        console.error('[shot] js 执行失败:', err.message);
      }
    }
    bootLog('capturing page…');
    const image = await mainWindow.webContents.capturePage();
    bootLog('capture done');
    const target = path.isAbsolute(SHOT_PATH) ? SHOT_PATH : path.join(process.cwd(), SHOT_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, image.toPNG());
    console.log(`[shot] saved ${target} (${image.getSize().width}x${image.getSize().height})`);
  } catch (err) {
    console.error('[shot] 截图失败:', err.message);
  } finally {
    isQuitting = true;
    app.exit(0);
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openSettings() {
  showWindow();
  sendEvent({ type: 'open-page', page: 'settings' });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('app:state', () => statePayload());

  ipcMain.handle('msgs:query', () => store.history.slice());

  ipcMain.handle('msgs:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const id = String(payload.id || '');
    const patch = payload.patch || {};
    const allowed = {};
    for (const key of ['read', 'favorite', 'ignored']) {
      if (typeof patch[key] === 'boolean') allowed[key] = patch[key];
    }
    const updated = store.updateMessage(id, allowed);
    if (updated) {
      sendEvent({ type: 'messages:patch', payload: updated });
      scheduleStateBroadcast();
    }
    return updated;
  });

  ipcMain.handle('msgs:readall', () => {
    const changed = store.markAllRead();
    for (const msg of store.history) {
      if (msg.read) sendEvent({ type: 'messages:patch', payload: msg });
    }
    scheduleStateBroadcast();
    return { changed };
  });

  ipcMain.handle('msgs:clear', () => {
    store.clearHistory();
    sendEvent({ type: 'messages:reset' });
    scheduleStateBroadcast();
    return { ok: true };
  });

  ipcMain.handle('msgs:export', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出通知记录',
      defaultPath: path.join(app.getPath('documents'), `WeNotice-通知记录-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const payload = {
      app: 'WeNotice',
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      total: store.history.length,
      messages: store.history
    };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath: result.filePath };
  });

  ipcMain.handle('cfg:save', async (_event, payload) => {
    const patch = payload && payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
    const before = JSON.stringify(store.config.source || {});
    store.saveConfig(patch);
    applyAutoLaunch();
    broadcastState();
    scheduleTrayRefresh();
    const after = JSON.stringify(store.config.source || {});
    if (before !== after && !demoActive) {
      await ensureSourceReady();
    }
    return { config: store.config };
  });

  ipcMain.handle('rules:save', (_event, payload) => {
    const list = Array.isArray(payload && payload.rules) ? payload.rules : [];
    const normalized = list.map((rule, index) => {
      const clean = normalizeRule(rule);
      if (!clean.id) clean.id = `rule-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
      return clean;
    });
    store.saveRules(normalized);
    broadcastState();
    return { rules: normalized };
  });

  ipcMain.handle('rules:reset', () => {
    const rules = RULE_TEMPLATES.map((rule, index) => {
      const clean = normalizeRule(rule);
      clean.id = `rule-template-${index}`;
      return clean;
    });
    store.saveRules(rules);
    broadcastState();
    return { rules };
  });

  ipcMain.handle('src:test', async () => {
    const result = await source.test();
    return result;
  });

  ipcMain.handle('src:reconnect', async () => {
    stopDemo();
    broadcastState();
    return ensureSourceReady();
  });

  ipcMain.handle('app:pause', (_event, payload) => {
    paused = payload && typeof payload.value === 'boolean' ? payload.value : !paused;
    broadcastState();
    scheduleTrayRefresh();
    return { paused };
  });

  ipcMain.handle('demo:toggle', (_event, payload) => {
    const want = payload && typeof payload.value === 'boolean' ? payload.value : !demoActive;
    if (want && !demoActive) {
      startDemo({ fast: false });
    } else if (!want && demoActive) {
      stopDemo();
      broadcastState();
      scheduleTrayRefresh();
    }
    return { demo: demoActive };
  });

  ipcMain.handle('demo:simulate', () => {
    const samples = [
      { groupName: '产品研发部', sender: '陈立', content: '@所有人 线上环境出现告警，请相关同学 10 分钟内上线处理。', sessionType: 'group' },
      { groupName: '', sender: '招商银行', content: '【招商银行】您的账户收到一笔转账 ￥1,280.00，请查收。', sessionType: 'private' },
      { groupName: '家长群', sender: '班主任王老师', content: '明天上午 9 点线上家长会，请准时参加。', sessionType: 'group' },
      { groupName: '', sender: '顺丰速运', content: '您的快递已放置丰巢柜，取件码 8631，24 小时内有效。', sessionType: 'official' }
    ];
    const pick = samples[Math.floor(Math.random() * samples.length)];
    const record = ingestEvent(
      {
        event: 'message.new',
        sessionId: `simulate-${Date.now()}`,
        sessionType: pick.sessionType,
        rawid: `sim-${Date.now()}`,
        sourceName: pick.sender,
        groupName: pick.groupName,
        content: pick.content,
        timestamp: nowSeconds(),
        mediaType: 'text'
      },
      'demo'
    );
    return { ok: Boolean(record), record };
  });

  ipcMain.handle('ai:test', async () => ai.test());

  ipcMain.handle('app:openpath', async () => {
    await shell.openPath(store.dataDir);
    return { ok: true };
  });
  ipcMain.handle('app:quit', () => {
    isQuitting = true;
    app.quit();
  });

  ipcMain.on('win:min', () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.on('win:max', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('win:close', () => {
    if (!mainWindow) return;
    if (config().app && config().app.closeToTray) mainWindow.hide();
    else {
      isQuitting = true;
      app.quit();
    }
  });
}

function applyAutoLaunch() {
  const enabled = Boolean(config().app && config().app.launchAtStartup);
  try {
    const settings = { openAtLogin: enabled };
    if (!app.isPackaged) {
      settings.path = process.execPath;
      settings.args = [path.join(__dirname)];
    }
    app.setLoginItemSettings(settings);
  } catch (err) {
    console.error('[autolaunch]', err.message);
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => bootLog(`uncaughtException: ${err && err.stack}`));
process.on('unhandledRejection', (err) => bootLog(`unhandledRejection: ${err && (err.stack || err)}`));
bootLog('before single-instance lock');

if (!IS_SHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  bootLog('registering whenReady');
  app.whenReady().then(async () => {
    bootLog('app ready');
    store = new Store(path.join(app.getPath('userData'), 'data')).load();
    bootLog(`store loaded: ${store.dataDir}`);
    source = new WeFlowSource(config);
    source.on('status', onSourceStatus);
    source.on('message', (evt) => ingestEvent(evt, 'weflow'));
    ai = new AIClassifier(config);

    registerIpc();
    createWindow();
    bootLog('window created');
    if (!IS_SHOT) createTray();
    applyAutoLaunch();

    const cfg = config().source || {};
    if (hasFlag('demo') || cfg.demoMode || (IS_SHOT && !hasFlag('no-demo'))) {
      startDemo({ fast: true });
    } else if (cfg.autoConnect !== false && cfg.baseUrl && cfg.token) {
      ensureSourceReady();
    } else {
      source.setStatus('no-config', cfg.token ? '已停止监听（自动连接已关闭）' : '尚未配置 AstrWeChat Access Token');
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && (isQuitting || !config().app || !config().app.closeToTray)) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (demo) demo.stop();
    if (source) source.stop();
    if (store) store.flushNow();
  });
}
