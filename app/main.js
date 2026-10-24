'use strict';

const { app, BrowserWindow, Notification, Tray, Menu, ipcMain, dialog, shell, nativeImage, globalShortcut, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

const { Store } = require('./lib/store');
const { WeFlowSource } = require('./lib/source');
const { DemoSource } = require('./lib/demo');
const { QqSource } = require('./lib/qqsource');
const { AIClassifier } = require('./lib/ai');
const AstrWechat = require('./lib/astr');
const { evaluate, CATEGORIES, normalizeRule, RULE_TEMPLATES, normalizeText } = require('./lib/rules');
const { humanizeContent } = require('./lib/content');
const { parseSchedule } = require('./lib/schedule');

// 启动诊断日志：默认写入 userData/boot.log（便于用户反馈问题），可用 WENOTICE_BOOT_LOG 覆盖路径。
// 注意：userData 在下面“运行环境”里可能被重定向，所以日志路径要延迟到重定向之后再解析。
let BOOT_LOG = process.env.WENOTICE_BOOT_LOG || '';
function resolveBootLog() {
  if (!BOOT_LOG) BOOT_LOG = path.join(app.getPath('userData'), 'boot.log');
  return BOOT_LOG;
}
function bootLog(message) {
  try {
    const file = resolveBootLog();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
      fs.writeFileSync(file, '');
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch (_err) {
    /* 无法写日志时静默（只读目录等） */
  }
}

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
// 启动器托盘模式：托盘图标由 WeNotice.exe（C# 启动器）负责显示，应用通过本地控制接口配合。
// 背景：本机/部分 Windows 环境下 Electron 的 Tray 注册后系统不显示图标（见 docs/TRAY.md），
// 而原生 WinForms 托盘正常，因此把托盘交给启动器更可靠。
const LAUNCHER_TRAY = hasFlag('launcher-tray');
const TEST_MINIMIZE = hasFlag('test-minimize');
const TEST_ENABLE_API = hasFlag('test-enable-api');
const TEST_TOKEN_FORMAT = hasFlag('test-token-format');

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

bootLog(
  `bootstrap: packaged=${app.isPackaged} userData=${app.getPath('userData')} argv=${JSON.stringify(process.argv)}`
);

const ASSET_DIR = path.join(__dirname, 'assets');
const APP_ICON = path.join(ASSET_DIR, 'icon.png');
// Windows 托盘优先用多尺寸 ICO（16/24/32/48/64/128/256），高 DPI 下更稳；缺 ICO 时回退 PNG
const TRAY_ICON_ICO = path.join(ASSET_DIR, 'tray.ico');
const TRAY_ICON = fs.existsSync(TRAY_ICON_ICO) ? TRAY_ICON_ICO : path.join(ASSET_DIR, 'tray.png');

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let store = null;
let source = null;
let qqSource = null;
let demo = null;
let ai = null;
let paused = false;
let demoActive = false;
let isQuitting = false;
let stateBroadcastTimer = null;
let trayRefreshTimer = null;
let lastFocusId = '';
let qqStatus = { state: 'disabled', message: 'QQ 数据源未启用' };
const lastNotifiedAt = new Map(); // sessionId -> ms
const notifyHistory = []; // 最近一分钟的通知时间戳

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
    const patched = store.updateMessage(record.id, { read: true });
    if (patched) {
      sendEvent({ type: 'messages:patch', payload: patched });
      scheduleStateBroadcast();
    }
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
// 日程闹钟
// ---------------------------------------------------------------------------

const REMINDER_TICK_MS = 20000;
let reminderTimer = null;

function scheduleConfig() {
  return (config() && config().schedule) || {};
}

function reminderTriggerAt(reminder) {
  if (!reminder) return Infinity;
  const advance = Math.max(0, Number(reminder.advanceMin != null ? reminder.advanceMin : scheduleConfig().advanceMin || 0));
  return Number(reminder.dueAt) - advance * 60000;
}

function formatReminderClock(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reminderStats() {
  const list = store.reminders.filter((r) => r.status !== 'canceled');
  const pending = list.filter((r) => r.status === 'pending');
  const next = pending.slice().sort((a, b) => reminderTriggerAt(a) - reminderTriggerAt(b))[0] || null;
  return {
    reminders: list,
    pendingCount: pending.length,
    firedCount: list.filter((r) => r.status === 'fired').length,
    next
  };
}

function buildReminder(record, opts = {}) {
  const dueAt = Number(opts.dueAt);
  const baseId = (record && record.id) || crypto.randomBytes(8).toString('hex');
  return {
    id: `rem-${String(baseId).replace(/[^a-zA-Z0-9:_-]/g, '').slice(-48)}-${Date.now().toString(36)}`,
    messageId: record ? record.id : opts.messageId || '',
    title: String(opts.title || (record ? record.content : '')).slice(0, 200),
    sessionName: record ? record.groupName || record.sender || record.sessionName : opts.sessionName || '',
    sender: record ? record.sender || '' : opts.sender || '',
    categoryLabel: (record && record.categoryLabel) || '日程安排',
    dueAt,
    advanceMin: Math.max(0, Number(opts.advanceMin != null ? opts.advanceMin : scheduleConfig().advanceMin || 0)),
    status: 'pending',
    createdAt: Date.now(),
    firedAt: 0,
    source: opts.source || 'auto',
    isDemo: Boolean(opts.isDemo)
  };
}

function notifyReminderChange(reminder) {
  sendEvent({ type: 'alarms:changed', payload: reminderStats() });
  if (reminder) sendEvent({ type: 'alarms:patch', payload: reminder });
  scheduleStateBroadcast();
  scheduleTrayRefresh();
}

/**
 * 日程消息入站时：尝试从文本里识别时间，自动建闹钟。
 * 只在非历史回填消息上做（回填的老消息也不该突然弹闹钟），识别失败也不影响消息本身。
 */
function maybeAutoSchedule(record) {
  const cfg = scheduleConfig();
  if (!cfg.enabled || cfg.autoCreate === false) return null;
  if (!record || record.event === 'message.revoke' || record.isSend) return null;
  if (record.category !== 'schedule') return null;
  if (record.fromHistory && !record.isDemo) return null;
  if (store.findReminderByMessage(record.id)) return null;

  const parsed = parseSchedule(record.content, new Date());
  if (!parsed.ok || !parsed.dueAt) return null;
  if (parsed.dueAt < Date.now() - 60000) return null;

  const reminder = buildReminder(record, {
    dueAt: parsed.dueAt,
    advanceMin: cfg.advanceMin,
    source: 'auto',
    isDemo: record.isDemo
  });
  store.addReminder(reminder);
  record.reminderId = reminder.id;
  record.dueAt = parsed.dueAt;
  store.updateMessage(record.id, { reminderId: reminder.id, dueAt: parsed.dueAt });
  sendEvent({ type: 'messages:patch', payload: record });
  sendEvent({
    type: 'toast',
    message: `⏰ 识别到日程：${formatReminderClock(parsed.dueAt)}，已自动设闹钟（提前 ${reminder.advanceMin} 分钟）`
  });
  notifyReminderChange(reminder);
  return reminder;
}

function showReminderNotification(reminder) {
  if (!Notification.isSupported()) return;
  const sound = config().notify && config().notify.sound !== false && scheduleConfig().sound !== false;
  const notification = new Notification({
    title: `⏰ 日程提醒 · ${truncate(reminder.sessionName || '日程', 26)}`,
    body: `${formatReminderClock(reminder.dueAt)}\n${truncate(reminder.title, 140)}`,
    icon: APP_ICON,
    silent: !sound,
    timeoutType: 'never'
  });
  notification.on('click', () => {
    store.updateReminder(reminder.id, { status: 'done', doneAt: Date.now() });
    if (reminder.messageId) {
      const patched = store.updateMessage(reminder.messageId, { read: true });
      if (patched) sendEvent({ type: 'messages:patch', payload: patched });
      lastFocusId = reminder.messageId;
    }
    showWindow();
    if (reminder.messageId) sendEvent({ type: 'focus', id: reminder.messageId });
    notifyReminderChange(store.getReminder(reminder.id));
  });
  notification.show();
}

function fireDueReminders() {
  const now = Date.now();
  let changed = false;
  for (const reminder of store.reminders) {
    if (reminder.status !== 'pending' || reminder.firedAt) continue;
    if (reminder.isDemo && !demoActive) continue;
    if (reminderTriggerAt(reminder) > now) continue;
    store.updateReminder(reminder.id, { status: 'fired', firedAt: now });
    showReminderNotification(reminder);
    changed = true;
  }
  if (changed) notifyReminderChange(null);
}

function startReminderTimer() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(fireDueReminders, REMINDER_TICK_MS);
  setTimeout(fireDueReminders, 1500);
}

function createReminderFromMessage(messageId, opts = {}) {
  const record = store.getMessage(messageId);
  if (!record) return { ok: false, error: '消息不存在' };
  if (store.findReminderByMessage(messageId)) return { ok: false, error: '这条消息已经有闹钟了' };
  const parsed = parseSchedule(record.content, new Date());
  const dueAt = Number(opts.dueAt || (parsed.ok ? parsed.dueAt : 0));
  if (!dueAt || Number.isNaN(dueAt)) return { ok: false, error: '时间无效' };
  const reminder = buildReminder(record, {
    dueAt,
    advanceMin: opts.advanceMin != null ? opts.advanceMin : scheduleConfig().advanceMin,
    source: 'manual',
    isDemo: record.isDemo
  });
  store.addReminder(reminder);
  store.updateMessage(record.id, { reminderId: reminder.id, dueAt });
  sendEvent({ type: 'messages:patch', payload: store.getMessage(record.id) });
  notifyReminderChange(reminder);
  return { ok: true, reminder };
}

function startDemoRemindersCleanup() {
  if (store) store.clearDemoReminders();
}

// ---------------------------------------------------------------------------
// AstrWeChat 本地配置（自动读取 Access Token）
// ---------------------------------------------------------------------------

function astrConfigPath() {
  const base = app.getPath('appData');
  return path.join(base, 'weflow', 'WeFlow-config.json');
}

/**
 * AstrWeChat 用 Electron safeStorage（Windows 上是 DPAPI）保存 httpApiToken：
 * 配置文件里的值可能是 `safe:<base64>`；口令模式下是 `lock:<密文>`。
 * 直接把这个字符串当 Token 用会 401，所以这里先尝试还原成明文。
 * 返回 { ok, token, encrypted, reason }，reason 用于界面给出可操作的提示。
 */
function decodeAstrToken(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, token: '', encrypted: false, reason: 'empty' };
  if (value.startsWith('safe:')) {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return { ok: false, token: '', encrypted: true, reason: 'unavailable' };
      }
      const buf = Buffer.from(value.slice(5), 'base64');
      const plain = safeStorage.decryptString(buf);
      if (!plain || !plain.trim()) return { ok: false, token: '', encrypted: true, reason: 'decrypt-failed' };
      return { ok: true, token: plain.trim(), encrypted: true, reason: 'ok' };
    } catch (err) {
      return { ok: false, token: '', encrypted: true, reason: 'decrypt-failed', error: String(err && err.message) };
    }
  }
  if (value.startsWith('lock:')) {
    return { ok: false, token: '', encrypted: true, reason: 'password-mode' };
  }
  return { ok: true, token: value, encrypted: false, reason: 'plain' };
}

function readAstrConfig() {
  try {
    const file = astrConfigPath();
    const exists = fs.existsSync(file);
    const base = { file, exists, port: 5031, host: '127.0.0.1', apiEnabled: false, pushEnabled: false };
    if (!exists) {
      return Object.assign(base, { ok: false, error: '未找到 AstrWeChat 配置文件', token: '', tokenReason: 'no-file' });
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const decoded = decodeAstrToken(data.httpApiToken);
    if (!decoded.ok) {
      bootLog(`astr token decode: reason=${decoded.reason}${decoded.error ? ` (${decoded.error})` : ''}`);
    }
    return Object.assign(base, {
      ok: true,
      token: decoded.token,
      tokenEncrypted: decoded.encrypted,
      tokenReason: decoded.reason,
      tokenRawLength: typeof data.httpApiToken === 'string' ? data.httpApiToken.length : 0,
      tokenLooksEncrypted: typeof data.httpApiToken === 'string' && /^(safe|lock):/.test(data.httpApiToken.trim()),
      port: Number(data.httpApiPort) || 5031,
      host: data.httpApiHost || '127.0.0.1',
      apiEnabled: Boolean(data.httpApiEnabled),
      pushEnabled: Boolean(data.messagePushEnabled)
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err), token: '', tokenReason: 'invalid-json' };
  }
}

/**
 * AstrWeChat 重启后 Token 可能变化。连接前自动读取它本机配置里的 httpApiToken 并同步，
 * 免去用户每次手动复制。设置里可关闭（source.autoTokenSync = false）。
 *
 * 注意：不能盲目覆盖——AstrWeChat 可能把 Token 加密成 safe:/lock:，解密失败或 Token 无效时
 * 覆盖会破坏用户本来能用的 Token。因此这里先用 /api/v1/sessions 验证，通过才落盘。
 */
let lastTokenSync = { at: 0, ok: false, reason: 'never' };

async function syncTokenFromAstrConfig() {
  const cfg = config().source || {};
  const report = (value) => {
    lastTokenSync = Object.assign({ at: Date.now() }, value);
    return value;
  };
  if (cfg.autoTokenSync === false) return report({ ok: false, reason: 'disabled' });

  const astr = readAstrConfig();
  if (!astr.ok) {
    bootLog(`token sync skipped: ${astr.error}`);
    return report({ ok: false, reason: 'no-config', error: astr.error });
  }
  if (!astr.token) {
    bootLog(`token sync skipped: token unavailable (${astr.tokenReason})`);
    return report({ ok: false, reason: astr.tokenReason || 'no-token' });
  }

  const base = AstrWechat.normalizeBaseUrl(cfg.baseUrl || `http://${astr.host}:${astr.port}`);
  const probe = await AstrWechat.probeSessions(base, astr.token, 3000);
  if (!probe.ok) {
    bootLog(`token sync skipped: probe failed (${probe.reason}${probe.status ? ` ${probe.status}` : ''})`);
    return report({ ok: false, reason: probe.reason || 'probe-failed', error: probe.error, status: probe.status, tokenEncrypted: astr.tokenEncrypted });
  }

  if (cfg.token === astr.token) {
    bootLog('token sync: unchanged');
    return report({ ok: true, reason: 'unchanged', tokenEncrypted: astr.tokenEncrypted });
  }
  store.saveConfig({ source: { token: astr.token } });
  bootLog(`token sync: updated from AstrWeChat config (${astr.tokenEncrypted ? 'decrypted' : 'plain'})`);
  return report({ ok: true, reason: 'updated', tokenEncrypted: astr.tokenEncrypted });
}

function maskSecret(value) {
  const str = String(value || '');
  if (!str) return '';
  if (str.length <= 8) return '****';
  return `${str.slice(0, 4)}…${str.slice(-4)}`;
}

/** 生成用于本地 API 的随机 Token（默认 16 位字母数字，足够本机使用）。 */
function randomToken(length = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let token = '';
  for (let i = 0; i < length; i += 1) token += alphabet[bytes[i] % alphabet.length];
  return token;
}

/**
 * 一键开启 AstrWeChat 的本地 API + 主动推送。
 *
 * AstrWeChat 1.5.0 并没有「设置 → API 服务」这样的独立页面，开关藏在「Bridge」页的
 * 「启动 AstrWeChat / 保存并启动」流程里（内部会 httpApiEnabled=true、messagePushEnabled=true
 * 并生成 httpApiToken）。很多用户会卡在这一步，所以这里直接改它的配置文件再重启它。
 */
async function enableAstrApi() {
  const log = [];
  const push = (msg) => {
    log.push(msg);
    bootLog(`astr-enable: ${msg}`);
  };
  const fail = (error) => ({ ok: false, error, log });

  const astr = readAstrConfig();
  if (!astr.ok) {
    return fail(`未找到 AstrWeChat 配置文件（${astr.error}）。请先安装并打开一次 AstrWeChat，完成微信连接后再试。`);
  }
  const cfg = config().source || {};
  const base = AstrWechat.normalizeBaseUrl(cfg.baseUrl || `http://${astr.host}:${astr.port}`);

  try {
    if (await AstrWechat.isRunning()) {
      push('AstrWeChat 正在运行，先停止它以写入 API 配置（约 3 秒）…');
      const stopped = await AstrWechat.stopAstrWechat();
      if (!stopped.ok) {
        return Object.assign(fail(stopped.error || '停止 AstrWeChat 失败'), {
          needElevation: Boolean(stopped.elevated),
          hint: stopped.elevated
            ? 'AstrWeChat 以管理员权限运行，普通权限的 WeNotice 无法结束它。可以：① 托盘右键退出 AstrWeChat 后再点一次；② 设置 → 应用 → 「以管理员身份重启 WeNotice」，重启后再点。'
            : '请手动退出 AstrWeChat 后再点一次「一键开启 AstrWeChat API」。'
        });
      }
      push('AstrWeChat 已停止');
    }

    const file = astrConfigPath();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.httpApiHost = data.httpApiHost || '127.0.0.1';
    data.httpApiPort = Number(data.httpApiPort) || 5031;
    data.httpApiEnabled = true;
    data.messagePushEnabled = true;
    // 一键开启时始终写入一个新的随机 Token。AstrWeChat 退出/重启后约定直接读取配置值，
    // 本应用也按该值读取，避免加密存储在不同机器/上下文下无法还原导致 401。
    const token = randomToken(16);
    data.httpApiToken = token;

    try {
      fs.copyFileSync(file, `${file}.wenotice-bak`);
    } catch (_err) {
      /* 备份失败不阻塞 */
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    push(`已写入 API 配置：启用 API 服务 + 主动推送（端口 ${data.httpApiPort}）`);

    const exePath = await AstrWechat.findAstrWechat(cfg.astrwechatPath);
    if (!exePath) {
      return fail(`配置已写入，但没有找到 AstrWeChat.exe。请手动打开 AstrWeChat 后回来点「重新连接」。`);
    }
    push('正在重新启动 AstrWeChat…');
    const launched = await AstrWechat.launchAstrWechat(exePath);
    if (!launched.ok) return fail(launched.error || '启动 AstrWeChat 失败');
    const waited = await AstrWechat.waitForHealth(base, {
      timeoutMs: 45000,
      intervalMs: 1200,
      onTick: (sec) => push(`等待 AstrWeChat 本地 API 就绪…（${sec}s）`)
    });
    if (!waited.ok) {
      return fail(`AstrWeChat 已启动，但本地 API 未就绪（${waited.error || '超时'}）。请确认 AstrWeChat 已登录微信，或打开 AstrWeChat 查看「Bridge」页是否有报错。`);
    }
    push('AstrWeChat 本地 API 已就绪');
    store.saveConfig({ source: { token } });
    return { ok: true, already: false, token, apiEnabled: true, log };
  } catch (err) {
    return fail(err.message || String(err));
  }
}

/**
 * 以管理员身份重新启动 WeNotice（用于需要结束以管理员权限运行的 AstrWeChat 的场景）。
 * 会先退出当前实例，再通过 PowerShell Start-Process -Verb RunAs 拉起打包版启动器（会弹 UAC）。
 */
async function relaunchElevated() {
  if (!app.isPackaged) return { ok: false, error: '开发模式下不支持以管理员身份重启' };
  const dir = path.dirname(process.execPath);
  const launcher = path.join(dir, 'WeNotice.exe');
  if (!fs.existsSync(launcher)) {
    return { ok: false, error: '未找到启动器 WeNotice.exe（便携版应位于 electron.exe 同目录）' };
  }
  try {
    const { spawn } = require('child_process');
    const escaped = launcher.replace(/'/g, "''");
    const script = `Start-Sleep -Milliseconds 1200; Start-Process -FilePath '${escaped}' -Verb RunAs`;
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
    bootLog('relaunch elevated: requested via UAC');
    setTimeout(() => app.quit(), 500);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
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
  if (!opts.fromHistory) {
    maybeAutoSchedule(record);
    maybeClassifyWithAI(record);
  }
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
  if (store) {
    store.dropDemoMessages();
    startDemoRemindersCleanup();
  }
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
  if (!demoActive) await syncTokenFromAstrConfig();
  let cfg = config().source || {};
  if (!cfg.baseUrl) {
    source.setStatus('no-config', '未配置 API 地址');
    return { ok: false, error: '未配置 API 地址' };
  }
  if (sourceStarting) return { ok: false, error: '正在启动中' };
  sourceStarting = true;
  try {
    // 没有任何 Token 且允许自动启动时，直接走「一键开启」流程（生成 Token + 拉起 AstrWeChat）
    if (!cfg.token) {
      if (cfg.autoLaunchAstrWechat === false) {
        source.setStatus('no-config', '尚未填写 Access Token');
        return { ok: false, error: '尚未填写 Access Token' };
      }
      bootLog('ensure: no token, running enable-astr-api');
      source.setStatus('launching', '正在初始化 AstrWeChat 本地 API…');
      const enabled = await enableAstrApi();
      bootLog(`ensure: enable-astr-api ok=${enabled.ok} error=${enabled.error || ''} needElevation=${Boolean(enabled.needElevation)}`);
      if (!enabled.ok) {
        source.setStatus('error', enabled.hint || enabled.error || '初始化 AstrWeChat API 失败');
        return { ok: false, error: enabled.error || 'enable-failed' };
      }
      cfg = config().source || {};
    }

    const base = AstrWechat.normalizeBaseUrl(cfg.baseUrl);
    bootLog(`ensure: probe ${base}`);
    const health = await AstrWechat.probeHealth(base, 2500);
    if (!health.ok) {
      bootLog(`ensure: probe failed (${health.error || 'unknown'})`);
      if (cfg.autoLaunchAstrWechat === false) {
        source.setStatus('error', `AstrWeChat 未运行（已关闭自动启动）：${health.error || ''}`);
        return { ok: false, error: health.error || 'not-running' };
      }
      const running = await AstrWechat.isRunning();
      bootLog(`ensure: AstrWeChat running=${running}`);
      if (!running) {
        // AstrWeChat 没在运行：完整初始化（写入新的本地 Token + 启动 AstrWeChat + 等 API 就绪）
        source.setStatus('launching', 'AstrWeChat 未运行，正在自动启动并配置本地 API…');
        const enabled = await enableAstrApi();
        bootLog(`ensure: enable-astr-api ok=${enabled.ok} error=${enabled.error || ''} needElevation=${Boolean(enabled.needElevation)}`);
        if (!enabled.ok) {
          source.setStatus('error', enabled.hint || enabled.error || '启动 AstrWeChat 失败');
          return { ok: false, error: enabled.error || 'launch-failed' };
        }
      } else {
        source.setStatus('launching', 'AstrWeChat 已在运行，正在等待本地 API 就绪…');
        const waited = await AstrWechat.waitForHealth(base, {
          timeoutMs: 30000,
          intervalMs: 1200,
          onTick: (sec) => source.setStatus('launching', `正在等待 AstrWeChat 本地 API 就绪…（${sec}s）`)
        });
        if (!waited.ok) {
          bootLog(`ensure: health timeout (${waited.error || 'unknown'})`);
          source.setStatus(
            'error',
            'AstrWeChat 已在运行，但本地 API 未响应：请在 AstrWeChat「Bridge」页点「启动 AstrWeChat」（会自动开启 API 与主动推送），或在 WeNotice 设置里点「一键开启 AstrWeChat API」'
          );
          return { ok: false, error: 'health-timeout' };
        }
      }
    }
    bootLog('ensure: start source');
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

function onQqStatus(status) {
  qqStatus = { state: status.state, message: status.message || '', selfId: status.selfId || '' };
  bootLog(`qq status: ${status.state}${status.message ? ` — ${status.message}` : ''}`);
  sendEvent({ type: 'qq:status', payload: qqStatus });
  scheduleStateBroadcast();
  scheduleTrayRefresh();
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
    qq: qqStatus,
    paused,
    demo: demoActive,
    stats: getStats(),
    schedule: reminderStats(),
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

  const menuItems = [
    { label: `WeNotice${stats.unread ? ` · ${stats.unread} 条未读` : ''}`, enabled: false },
    { label: statusText, enabled: false },
    { type: 'separator' },
    {
      label: '打开通知中心',
      click: () => showWindow()
    }
  ];
  // 下一个日程闹钟
  const scheduleStats = reminderStats();
  if (scheduleStats.next) {
    const next = scheduleStats.next;
    menuItems.push({
      label: `⏰ 下一个闹钟：${formatReminderClock(next.dueAt)}${next.title ? ` · ${truncate(next.title, 14)}` : ''}`,
      click: () => {
        showWindow();
        sendEvent({ type: 'open-page', page: 'alarms' });
      }
    });
  } else if (scheduleStats.pendingCount > 0) {
    menuItems.push({ label: `⏰ 日程闹钟（${scheduleStats.pendingCount} 个待提醒）`, click: () => showWindow() });
  }
  menuItems.push(
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
  );
  const menu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(menu);
  tray.setToolTip(
    scheduleStats.next
      ? `WeNotice · ${stats.unread} 条未读 · 下个闹钟 ${formatReminderClock(scheduleStats.next.dueAt)}`
      : `WeNotice · ${stats.unread} 条未读`
  );
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
  const hasElectronTray = tray && !tray.isDestroyed();
  const hotkey = hotkeyRegistered || 'Ctrl+Alt+Shift+W';
  if (hasElectronTray) {
    try {
      tray.displayBalloon({
        icon: trayImage(),
        title: 'WeNotice 已最小化到系统托盘',
        content: '仍在后台监听微信消息。点任务栏右下角「^」里的 WeNotice 图标即可恢复，或按 ' + hotkey + ' 唤起窗口。'
      });
    } catch (_err) {
      /* 个别系统不支持气泡，忽略 */
    }
    return;
  }
  // 启动器托盘模式：图标在 WeNotice.exe 进程里，气泡由应用侧通知代替。
  try {
    new Notification({
      title: 'WeNotice 已最小化到托盘',
      body: '仍在后台监听微信消息。点任务栏右下角「^」里的 WeNotice 图标恢复窗口，或按 ' + hotkey + ' 唤起。'
    }).show();
  } catch (_err) {
    /* 通知不可用时忽略 */
  }
}

// ---------------------------------------------------------------------------
// 启动器托盘模式（--launcher-tray）
//
// WeNotice.exe 启动器负责显示托盘图标（WinForms NotifyIcon，本机验证可靠），
// 应用在 127.0.0.1 随机端口开一个带 token 的本地控制接口，启动器通过它：
//   show      → 显示主窗口
//   settings  → 显示主窗口并打开设置
//   pause     → 切换暂停提醒
//   state     → 读取未读数/连接状态（更新托盘提示）
//   quit      → 退出应用
// 端口与 token 写入 <userData>/control.json，启动器启动后轮询读取。
// ---------------------------------------------------------------------------

let controlServer = null;

function controlFilePath() {
  return path.join(app.getPath('userData'), 'control.json');
}

function stopControlServer() {
  if (!controlServer) return;
  try {
    controlServer.close();
  } catch (_err) {
    /* noop */
  }
  controlServer = null;
  try {
    fs.unlinkSync(controlFilePath());
  } catch (_err) {
    /* noop */
  }
}

function startControlServer() {
  stopControlServer();
  const token = crypto.randomBytes(16).toString('hex');
  controlServer = http.createServer((req, res) => {
    const reply = (code, body) => {
      try {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      } catch (_err) {
        /* noop */
      }
    };
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (_err) {
      reply(400, { ok: false });
      return;
    }
    if (url.searchParams.get('token') !== token) {
      reply(403, { ok: false, error: 'forbidden' });
      return;
    }
    const action = url.pathname.replace(/^\/+/, '');
    const stats = getStats();
    switch (action) {
      case 'show':
        showWindow();
        reply(200, { ok: true });
        return;
      case 'settings':
        openSettings();
        reply(200, { ok: true });
        return;
      case 'pause': {
        const want = url.searchParams.get('value');
        paused = want === null ? !paused : want === '1' || want === 'true';
        broadcastState();
        scheduleTrayRefresh();
        reply(200, { ok: true, paused });
        return;
      }
      case 'state':
        reply(200, {
          ok: true,
          unread: stats.unread,
          paused,
          demo: demoActive,
          sourceState: source ? source.status.state : 'idle',
          sourceMessage: source ? source.status.message || '' : ''
        });
        return;
      case 'quit':
        isQuitting = true;
        reply(200, { ok: true });
        setTimeout(() => app.quit(), 50);
        return;
      default:
        reply(404, { ok: false });
    }
  });
  controlServer.on('error', (err) => bootLog(`control server error: ${err.message}`));
  controlServer.listen(0, '127.0.0.1', () => {
    const addr = controlServer.address();
    try {
      fs.writeFileSync(controlFilePath(), JSON.stringify({ port: addr.port, token }), 'utf8');
      bootLog(`control server on 127.0.0.1:${addr.port}`);
    } catch (err) {
      bootLog(`control server write failed: ${err.message}`);
    }
  });
}

// 全局快捷键兜底：即使托盘图标没有显示，也能一键找回窗口。
// 注意：Ctrl+Alt+W 可能被其它软件占用（注册会返回 false），因此准备多个候选键依次尝试。
const HOTKEY_CANDIDATES = ['Control+Alt+Shift+W', 'Control+Alt+F9', 'Control+Alt+Shift+N'];
let hotkeyRegistered = '';

function registerGlobalHotkey() {
  for (const acc of HOTKEY_CANDIDATES) {
    try {
      if (globalShortcut.register(acc, () => showWindow())) {
        hotkeyRegistered = acc;
        break;
      }
    } catch (err) {
      bootLog(`global hotkey ${acc} failed: ${err.message}`);
    }
  }
  bootLog(`global hotkey registered=${hotkeyRegistered || 'none'}`);
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
    if (TEST_ENABLE_API) {
      // 自助回归测试：验证「一键开启 AstrWeChat API」流程（会重启 AstrWeChat）。
      setTimeout(async () => {
        try {
          const result = await enableAstrApi();
          bootLog(`test-enable-api: ${JSON.stringify(result)}`);
        } catch (err) {
          bootLog(`test-enable-api error: ${err.message || err}`);
        }
        setTimeout(() => {
          isQuitting = true;
          app.quit();
        }, 500);
      }, 2500);
    }
    if (TEST_TOKEN_FORMAT) {
      // 自助回归测试：验证 safe: 加密 Token 的解码（本应用自己加密再解码）。
      setTimeout(() => {
        try {
          const sample = 'sample-token-1234567890';
          const encrypted = `safe:${safeStorage.encryptString(sample).toString('base64')}`;
          const decoded = decodeAstrToken(encrypted);
          const plain = decodeAstrToken('plain-token-abc');
          const lock = decodeAstrToken('lock:xxxx');
          const garbage = decodeAstrToken('safe:not-base64!!');
          bootLog(`test-token-format: available=${safeStorage.isEncryptionAvailable()} encLen=${encrypted.length}`);
          bootLog(`test-token-format: encrypted.decode=${JSON.stringify({ ok: decoded.ok, reason: decoded.reason, match: decoded.token === sample })}`);
          bootLog(`test-token-format: plain=${JSON.stringify({ ok: plain.ok, token: plain.token, reason: plain.reason })}`);
          bootLog(`test-token-format: lock=${JSON.stringify({ ok: lock.ok, reason: lock.reason })}`);
          bootLog(`test-token-format: garbage=${JSON.stringify({ ok: garbage.ok, reason: garbage.reason })}`);
        } catch (err) {
          bootLog(`test-token-format error: ${err.message || err}`);
        }
        setTimeout(() => {
          isQuitting = true;
          app.quit();
        }, 500);
      }, 1500);
    }
    if (TEST_MINIMIZE) {
      // 自助回归测试：验证「最小化到托盘」是否真的把窗口隐藏（不回到底部任务栏）。
      setTimeout(() => {
        bootLog(`test-minimize: before visible=${mainWindow.isVisible()} minimized=${mainWindow.isMinimized()}`);
        mainWindow.minimize();
        setTimeout(() => {
          bootLog(`test-minimize: after visible=${mainWindow.isVisible()} minimized=${mainWindow.isMinimized()}`);
          isQuitting = true;
          app.quit();
        }, 1200);
      }, 1500);
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
    const hasElectronTray = tray && !tray.isDestroyed();
    // 启动器托盘模式（--launcher-tray）下托盘图标由 WeNotice.exe 启动器提供，应用自身不创建托盘。
    if (!hasElectronTray && !LAUNCHER_TRAY) return;
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

  // ---------------------------------------------------------------- 日程闹钟
  ipcMain.handle('alarms:list', () => reminderStats());

  ipcMain.handle('alarms:parse', (_event, payload) => {
    const text = String((payload && payload.text) || '');
    const parsed = parseSchedule(text, new Date());
    return {
      ok: Boolean(parsed.ok),
      reason: parsed.reason || '',
      dueAt: parsed.dueAt || 0,
      allDay: Boolean(parsed.allDay),
      suggestedAt: parsed.ok ? parsed.dueAt : Date.now() + 10 * 60000
    };
  });

  ipcMain.handle('alarms:create', (_event, payload) => {
    const data = payload || {};
    if (!data.messageId) return { ok: false, error: '请选择一条日程消息' };
    if (!data.dueAt) return { ok: false, error: '缺少提醒时间' };
    return createReminderFromMessage(String(data.messageId), {
      dueAt: Number(data.dueAt),
      advanceMin: data.advanceMin != null ? Number(data.advanceMin) : undefined,
      title: data.title
    });
  });

  ipcMain.handle('alarms:update', (_event, payload) => {
    const data = payload || {};
    const id = String(data.id || '');
    const patch = {};
    if (data.dueAt != null) patch.dueAt = Number(data.dueAt);
    if (data.advanceMin != null) patch.advanceMin = Math.max(0, Number(data.advanceMin));
    if (typeof data.title === 'string') patch.title = data.title.slice(0, 200);
    if (['pending', 'fired', 'done', 'canceled'].includes(data.status)) {
      patch.status = data.status;
      if (data.status === 'pending') patch.firedAt = 0;
    }
    const updated = store.updateReminder(id, patch);
    if (updated) notifyReminderChange(updated);
    return { ok: Boolean(updated), reminder: updated };
  });

  ipcMain.handle('alarms:remove', (_event, payload) => {
    const id = String((payload && payload.id) || '');
    const removed = store.removeReminder(id);
    notifyReminderChange(null);
    return { ok: removed };
  });

  ipcMain.handle('alarms:snooze', (_event, payload) => {
    const data = payload || {};
    const id = String(data.id || '');
    const minutes = Math.max(1, Math.min(24 * 60, Number(data.minutes) || 5));
    const reminder = store.getReminder(id);
    if (!reminder) return { ok: false, error: '闹钟不存在' };
    const dueAt = Math.max(Number(reminder.dueAt) + minutes * 60000, Date.now() + minutes * 60000);
    const updated = store.updateReminder(id, { status: 'pending', dueAt, firedAt: 0, snoozedAt: Date.now() });
    notifyReminderChange(updated);
    return { ok: true, reminder: updated };
  });

  ipcMain.handle('alarms:done', (_event, payload) => {
    const id = String((payload && payload.id) || '');
    const updated = store.updateReminder(id, { status: 'done', doneAt: Date.now() });
    notifyReminderChange(updated);
    return { ok: Boolean(updated), reminder: updated };
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
    const qqBefore = JSON.stringify(store.config.qq || {});
    store.saveConfig(patch);
    applyAutoLaunch();
    broadcastState();
    scheduleTrayRefresh();
    const after = JSON.stringify(store.config.source || {});
    if (before !== after && !demoActive) {
      await ensureSourceReady();
    }
    if (qqSource) {
      const qqAfter = JSON.stringify(store.config.qq || {});
      if (qqBefore !== qqAfter) {
        qqSource.stop();
        const qqCfg = store.config.qq || {};
        if (qqCfg.enabled && qqCfg.autoConnect !== false) qqSource.connect();
      }
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
    await syncTokenFromAstrConfig();
    return source.test();
  });

  ipcMain.handle('src:reconnect', async () => {
    stopDemo();
    broadcastState();
    return ensureSourceReady();
  });

  ipcMain.handle('qq:test', async () => (qqSource ? qqSource.test() : { ok: false, error: 'QQ 数据源未初始化' }));

  ipcMain.handle('qq:reconnect', async () => {
    if (!qqSource) return { ok: false, error: 'QQ 数据源未初始化' };
    qqSource.stop();
    const result = qqSource.connect();
    if (result && result.ok) return { ok: true, url: result.url };
    return { ok: false, error: result && result.error };
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

  ipcMain.handle('app:openexternal', async (_event, payload) => {
    const url = payload && typeof payload.url === 'string' ? payload.url : '';
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只允许打开 http/https 链接' };
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:relaunch-elevated', async () => relaunchElevated());

  ipcMain.handle('cfg:astr-token', async () => {
    const astr = readAstrConfig();
    const cfg = config().source || {};
    const base = AstrWechat.normalizeBaseUrl(cfg.baseUrl || `http://${astr.host || '127.0.0.1'}:${astr.port || 5031}`);
    const health = await AstrWechat.probeHealth(base, 2500);
    let probe = null;
    if (astr.token) probe = await AstrWechat.probeSessions(base, astr.token, 3000);
    return Object.assign({}, astr, {
      tokenMasked: astr.token ? maskSecret(astr.token) : '',
      probe,
      health,
      apiListening: Boolean(health && health.ok)
    });
  });

  ipcMain.handle('astr:enable-api', async () => {
    try {
      return await enableAstrApi();
    } catch (err) {
      return { ok: false, error: err.message || String(err), log: [] };
    }
  });

  ipcMain.handle('app:diagnostics', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出诊断信息',
      defaultPath: path.join(app.getPath('documents'), `WeNotice-diagnostics-${stamp}.txt`),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const cfg = JSON.parse(JSON.stringify(store.config || {}));
    if (cfg.source && cfg.source.token) cfg.source.token = maskSecret(cfg.source.token);
    if (cfg.ai && cfg.ai.apiKey) cfg.ai.apiKey = maskSecret(cfg.ai.apiKey);
    const bootLogFile = path.join(app.getPath('userData'), 'boot.log');
    const launcherLogFile = path.join(path.dirname(app.getPath('exe')), 'WeNotice-launcher.log');
    const tailText = (file, max = 8000) => {
      try {
        const text = fs.readFileSync(file, 'utf8');
        return text.length > max ? text.slice(-max) : text;
      } catch (_err) {
        return '(无)';
      }
    };
    const lines = [
      'WeNotice diagnostics',
      `generated: ${new Date().toISOString()}`,
      `version: ${app.getVersion()}`,
      `packaged: ${app.isPackaged}`,
      `exe: ${app.getPath('exe')}`,
      `userData: ${app.getPath('userData')}`,
      `dataDir: ${store.dataDir}`,
      `runtime: ${process.platform} ${process.arch} node=${process.versions.node} electron=${process.versions.electron} chrome=${process.versions.chrome}`,
      `source: ${source.status.state} — ${source.status.message || ''}`,
      `qq: ${qqStatus.state} — ${qqStatus.message || ''}`,
      `qq config: ${JSON.stringify(Object.assign({}, (config().qq || {}), { token: (config().qq || {}).token ? '***' : '' }))}`,
      `paused: ${paused} | demo: ${demoActive} | backfilled: ${backfilled}`,
      `history: ${store.history.length} | rules: ${store.rules.length}`,
      '',
      '--- config (secrets masked) ---',
      JSON.stringify(cfg, null, 2),
      '',
      '--- AstrWeChat config ---',
      JSON.stringify((() => {
        const astr = readAstrConfig();
        return Object.assign({}, astr, {
          token: astr.token ? `${maskSecret(astr.token)} (len ${astr.token.length}, ${astr.tokenEncrypted ? 'decrypted' : 'plain'})` : `<empty: ${astr.tokenReason || 'unknown'}>`
        });
      })(), null, 2),
      `lastTokenSync: ${JSON.stringify(lastTokenSync)}`,
      '',
      '--- boot.log (tail) ---',
      tailText(bootLogFile),
      '',
      '--- WeNotice-launcher.log (tail) ---',
      tailText(launcherLogFile)
    ];
    fs.writeFileSync(result.filePath, lines.join('\n'), 'utf8');
    return { ok: true, filePath: result.filePath };
  });

  ipcMain.handle('rules:export', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出通知规则',
      defaultPath: path.join(app.getPath('documents'), `WeNotice-rules-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const payload = {
      app: 'WeNotice',
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      rules: store.rules
    };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath: result.filePath, count: store.rules.length };
  });

  ipcMain.handle('rules:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入通知规则',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
    try {
      const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
      const list = Array.isArray(data) ? data : Array.isArray(data.rules) ? data.rules : [];
      if (!list.length) return { ok: false, error: '文件里没有可导入的规则' };
      const normalized = list.map((rule, index) => {
        const clean = normalizeRule(rule);
        if (!clean.id) clean.id = `rule-import-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
        return clean;
      });
      const merged = [...store.rules, ...normalized];
      store.saveRules(merged);
      broadcastState();
      return { ok: true, imported: normalized.length, rules: merged };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
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
    qqSource = new QqSource(config);
    qqSource.on('status', onQqStatus);
    qqSource.on('message', (evt) => ingestEvent(evt, 'qq'));
    ai = new AIClassifier(config);

    registerIpc();
    createWindow();
    bootLog('window created');
    if (!IS_SHOT) {
      if (LAUNCHER_TRAY) startControlServer();
      else createTray();
      registerGlobalHotkey();
    }
    applyAutoLaunch();
    startReminderTimer();

    const cfg = config().source || {};
    if (hasFlag('demo') || cfg.demoMode || (IS_SHOT && !hasFlag('no-demo'))) {
      startDemo({ fast: true });
    } else {
      // 允许在 Token 为空时也从 AstrWeChat 本机配置自动补齐（用户无需手动复制）
      if (!cfg.token) {
        try {
          await syncTokenFromAstrConfig();
        } catch (_err) {
          /* 同步失败不影响启动 */
        }
      }
      const readyCfg = config().source || {};
      const astrConfigReady = (() => {
        try {
          return Boolean(readAstrConfig().ok);
        } catch (_err) {
          return false;
        }
      })();
      const canAutoInit = readyCfg.autoLaunchAstrWechat !== false && astrConfigReady;
      if (readyCfg.autoConnect !== false && readyCfg.baseUrl && (readyCfg.token || canAutoInit)) {
        ensureSourceReady();
      } else {
        source.setStatus('no-config', readyCfg.token ? '已停止监听（自动连接已关闭）' : '尚未配置 AstrWeChat Access Token');
      }
    }

    // QQ 数据源（OneBot 11）独立于微信数据源：配置启用且允许自动连接时后台保持连接
    const qqCfg = config().qq || {};
    if (qqCfg.enabled && qqCfg.autoConnect !== false) {
      const result = qqSource.connect();
      if (result && !result.ok) bootLog(`qq connect skipped: ${result.error || ''}`);
    } else {
      qqStatus = { state: 'disabled', message: 'QQ 数据源未启用' };
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
    try {
      if (hotkeyRegistered) globalShortcut.unregisterAll();
    } catch (_err) {
      /* noop */
    }
    if (reminderTimer) {
      clearInterval(reminderTimer);
      reminderTimer = null;
    }
    stopControlServer();
    if (demo) demo.stop();
    if (qqSource) qqSource.stop();
    if (source) source.stop();
    if (store) store.flushNow();
  });
}

