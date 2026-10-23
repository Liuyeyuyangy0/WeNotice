'use strict';

/* ==========================================================================
   WeNotice 渲染进程
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const CATEGORY_FALLBACK = {
  notice: { label: '公告通知', color: '#fbbf24', icon: 'megaphone' },
  mention: { label: '@我 / 全员', color: '#60a5fa', icon: 'at' },
  finance: { label: '交易财务', color: '#34d399', icon: 'wallet' },
  logistics: { label: '物流快递', color: '#22d3ee', icon: 'package' },
  security: { label: '安全验证', color: '#fb7185', icon: 'shield' },
  schedule: { label: '日程安排', color: '#c084fc', icon: 'calendar' },
  work: { label: '工作事务', color: '#818cf8', icon: 'briefcase' },
  file: { label: '文件', color: '#2dd4bf', icon: 'file' },
  link: { label: '链接', color: '#94a3b8', icon: 'link' },
  system: { label: '系统消息', color: '#94a3b8', icon: 'info' },
  chat: { label: '普通聊天', color: '#64748b', icon: 'chat' },
  custom: { label: '自定义', color: '#a78bfa', icon: 'sparkles' }
};

const CATEGORY_ORDER = ['notice', 'mention', 'security', 'finance', 'logistics', 'schedule', 'work', 'file', 'link', 'system'];

const ACTION_META = {
  notify: { label: '桌面提醒', cls: 'is-notify' },
  list: { label: '仅列表', cls: 'is-list' },
  ignore: { label: '忽略', cls: 'is-ignore' }
};

const state = {
  config: null,
  categories: CATEGORY_FALLBACK,
  templates: [],
  rules: [],
  status: { state: 'idle', message: '未启动' },
  paused: false,
  demo: false,
  stats: { total: 0, inbox: 0, unread: 0, today: 0 },
  version: '1.0.0',
  dataDir: '',
  messages: [],
  view: 'inbox',
  category: 'all',
  search: '',
  sort: 'time',
  selectedId: '',
  newIds: new Set(),
  modal: null
};

const refs = {};

/* --------------------------------------------------------------------------
   基础工具
   -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function icon(name, cls = 'ic') {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

function categoryMeta(key) {
  return state.categories[key] || CATEGORY_FALLBACK[key] || CATEGORY_FALLBACK.custom;
}

function relTime(ts) {
  const sec = Number(ts) || 0;
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (diff < 45) return '刚刚';
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟前`;
  const d = new Date(sec * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function absTime(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function truncate(text, max) {
  const str = String(text == null ? '' : text);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function toast(message, type = 'info', timeout = 3400) {
  const el = document.createElement('div');
  el.className = `toast${type === 'ok' ? ' is-ok' : type === 'err' ? ' is-err' : ''}`;
  const ic = type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info';
  el.innerHTML = `${icon(ic)}<span>${escapeHtml(message)}</span>`;
  refs.toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  }, timeout);
}

function setText(el, text) {
  if (el) el.textContent = text == null ? '' : String(text);
}

function readSwitch(el) {
  return el ? el.classList.contains('is-on') : false;
}

function toggleSwitch(el, value) {
  if (!el) return;
  el.classList.toggle('is-on', Boolean(value));
  el.setAttribute('aria-checked', String(Boolean(value)));
}

/* --------------------------------------------------------------------------
   初始化
   -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheRefs();
  bindStaticEvents();

  if (!window.we) {
    document.body.innerHTML = '<div style="padding:40px;color:#fda4af;font:14px system-ui">预加载脚本未注入（preload 失败），请重启应用。</div>';
    return;
  }

  try {
    const initial = await window.we.getState();
    hydrate(initial);
  } catch (err) {
    toast(`初始化失败：${err.message}`, 'err');
  }

  try {
    const messages = await window.we.queryMessages();
    state.messages = Array.isArray(messages) ? messages : [];
  } catch (_err) {
    state.messages = [];
  }

  window.we.onEvent(handleEvent);
  renderAll();
  maybeShowTrayHint();
  maybeShowOnboarding();
}

/** 首次使用向导：演示 → 连接 AstrWeChat → 测试连接（可从设置里再次打开）。 */
function maybeShowOnboarding() {
  const appCfg = (state.config && state.config.app) || {};
  if (appCfg.onboarded) return;
  if (state.demo) return;
  setTimeout(() => openOnboardingModal(), 700);
}

function openOnboardingModal() {
  openModal({
    title: '欢迎使用 WeNotice',
    subtitle: '首次使用向导 · 三步开始',
    body: `
      <div class="onboarding">
        <p class="onboarding-lead">WeNotice 读取 <b>AstrWeChat</b> 的本地 API，把微信里收到的公告、验证码、快递、日程、转账等消息筛出来并弹提醒。三步就能用起来：</p>
        <ol class="onboarding-steps">
          <li><b>体验演示</b>：先看看通知中心长什么样（只读演示样例，不碰真实数据）。</li>
          <li><b>连接 AstrWeChat</b>：退出微信登录 → AstrWeChat「微信连接」里点「自动检测 / 自动获取」→ 重新登录微信 → 点「连接数据库」。</li>
          <li><b>开启 API</b>：AstrWeChat 没有独立的「设置 → API」页，开关在左侧 <b>「Bridge」页</b>的「启动 AstrWeChat / 保存并启动」（会一并开启 API 服务与主动推送）。也可以直接回 WeNotice 设置 → 数据源 点「一键开启 AstrWeChat API」；Token 不用复制，会自动读取。</li>
        </ol>
        <div class="onboarding-note">不确定卡在哪一步？点「测试连接」会告诉你是哪一环没完成；也可以 设置 → 应用 → 导出诊断信息 再发给我们。</div>
        <div class="test-result" id="onboardingResult" hidden></div>
      </div>
    `,
    footer: `
      <button class="btn btn-ghost" id="onboardDemo">${icon('sparkles')}先看看演示</button>
      <button class="btn btn-ghost" id="onboardDownload">${icon('external')}下载 AstrWeChat</button>
      <button class="btn btn-ghost" id="onboardLater">稍后</button>
      <button class="btn btn-primary" id="onboardTest">${icon('check')}测试连接</button>
    `
  });

  $('#onboardDemo').addEventListener('click', async () => {
    await window.we.toggleDemo(true);
    closeModal();
    toast('已进入演示模式，点右上角「退出演示」可退出', 'ok', 3600);
  });

  $('#onboardDownload').addEventListener('click', async () => {
    await window.we.openExternal('https://github.com/CMKH1337/Astrwechat/releases/latest');
    toast('已打开浏览器；装好后回到 WeNotice 点「测试连接」', 'info', 4200);
  });

  $('#onboardLater').addEventListener('click', async () => {
    try {
      await window.we.saveConfig({ app: { onboarded: true } });
      state.config.app.onboarded = true;
    } catch (_err) {
      /* 忽略 */
    }
    closeModal();
    toast('已关闭引导，可从 设置 → 应用 → 新手引导 再次打开', 'info', 3600);
  });

  $('#onboardTest').addEventListener('click', async () => {
    const box = $('#onboardingResult');
    box.hidden = false;
    box.className = 'test-result';
    box.textContent = '正在测试连接…';
    try {
      const result = await window.we.testSource();
      const success = result && result.ok && result.wxReady !== false;
      box.className = `test-result ${success ? 'is-ok' : 'is-err'}`;
      const lines = [];
      lines.push(`地址：${result.baseUrl || '-'}`);
      lines.push(`健康检查：${result.health ? '通过' : '失败'}`);
      if (result.tokenValid != null) lines.push(`Access Token：${result.tokenValid ? '有效' : '无效'}`);
      if (result.wxReady != null) lines.push(`微信连接：${result.wxReady ? '正常' : '未完成（需在 AstrWeChat 里连接微信数据库）'}`);
      if (result.sessionCount != null) lines.push(`会话数：${result.sessionCount}`);
      lines.push('');
      lines.push(success ? '连接成功，开始监听微信消息了。' : result.hint || result.error || '还有步骤没完成，按上面的提示处理后再试。');
      box.textContent = lines.join('\n');
      if (success) {
        try {
          await window.we.saveConfig({ app: { onboarded: true } });
          state.config.app.onboarded = true;
        } catch (_err) {
          /* 忽略 */
        }
        toast('连接成功，微信消息会自动筛选并提醒', 'ok', 3600);
        setTimeout(() => closeModal(), 1200);
      }
    } catch (err) {
      box.className = 'test-result is-err';
      box.textContent = `测试失败：${err.message}`;
    }
  });
}

/** 首次启动提示托盘图标位置（Windows 11 默认收进「^」展开区，容易被当成窗口丢了）。 */
function maybeShowTrayHint() {
  try {
    if (localStorage.getItem('wenotice.trayHint') === '1') return;
    const cfg = (state.config && state.config.app) || {};
    if (cfg.minimizeToTray === false) return;
    setTimeout(() => {
      toast('已启用「最小化到托盘」：图标在任务栏右下角「^」里，拖到任务栏可常显', 'info', 7200);
      localStorage.setItem('wenotice.trayHint', '1');
    }, 2000);
  } catch (_err) {
    /* 忽略无 localStorage 的环境 */
  }
}

function cacheRefs() {
  refs.badgeInbox = $('#badgeInbox');
  refs.badgeUnread = $('#badgeUnread');
  refs.badgeStarred = $('#badgeStarred');
  refs.badgeIgnored = $('#badgeIgnored');
  refs.badgeAll = $('#badgeAll');
  refs.catNav = $('#catNav');
  refs.viewTitle = $('#viewTitle');
  refs.viewCount = $('#viewCount');
  refs.messageList = $('#messageList');
  refs.emptyState = $('#emptyState');
  refs.detailBody = $('#detailBody');
  refs.detailPlaceholder = $('#detailPlaceholder');
  refs.connPill = $('#connPill');
  refs.connText = $('#connPill .conn-text');
  refs.btnPause = $('#btnPause');
  refs.btnDemo = $('#btnDemo');
  refs.btnTest = $('#btnTest');
  refs.sourceDot = $('#sourceDot');
  refs.sourceState = $('#sourceState');
  refs.sidebarStats = $('#sidebarStats');
  refs.demoBanner = $('#demoBanner');
  refs.statusDot = $('#statusDot');
  refs.statusSource = $('#statusSource');
  refs.statusHint = $('#statusHint');
  refs.statusStats = $('#statusStats');
  refs.statusVersion = $('#statusVersion');
  refs.searchInput = $('#searchInput');
  refs.sortSwitch = $('#sortSwitch');
  refs.btnMarkAll = $('#btnMarkAll');
  refs.btnExport = $('#btnExport');
  refs.modalRoot = $('#modalRoot');
  refs.toastHost = $('#toastHost');
}

function hydrate(data) {
  if (!data) return;
  if (data.config) state.config = data.config;
  if (data.categories) state.categories = data.categories;
  if (Array.isArray(data.templates)) state.templates = data.templates;
  if (Array.isArray(data.rules)) state.rules = data.rules;
  if (data.status) state.status = data.status;
  if (typeof data.paused === 'boolean') state.paused = data.paused;
  if (typeof data.demo === 'boolean') state.demo = data.demo;
  if (data.stats) state.stats = data.stats;
  if (data.version) state.version = data.version;
  if (data.dataDir) state.dataDir = data.dataDir;
}

function handleEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  switch (payload.type) {
    case 'state': {
      hydrate(payload.payload);
      renderSidebar();
      renderStatus();
      renderHeaderActions();
      if (!state.modal) renderList();
      break;
    }
    case 'source:status': {
      state.status = payload.payload || state.status;
      renderStatus();
      renderSidebar();
      break;
    }
    case 'messages:add': {
      const record = payload.payload;
      if (!record || !record.id) return;
      if (state.messages.some((m) => m.id === record.id)) return;
      state.messages.unshift(record);
      state.newIds.add(record.id);
      state.stats = computeStats();
      renderList();
      renderSidebar();
      renderStatus();
      break;
    }
    case 'messages:patch': {
      const record = payload.payload;
      if (!record) return;
      const index = state.messages.findIndex((m) => m.id === record.id);
      if (index >= 0) state.messages[index] = record;
      state.stats = computeStats();
      renderList();
      renderSidebar();
      if (state.selectedId === record.id) renderDetail();
      break;
    }
    case 'messages:reset': {
      state.messages = [];
      state.selectedId = '';
      state.stats = computeStats();
      renderList();
      renderDetail();
      renderSidebar();
      break;
    }
    case 'focus': {
      const record = state.messages.find((m) => m.id === payload.id);
      if (!record) return;
      if (state.view === 'ignored') {
        /* 保持当前视图 */
      }
      selectMessage(payload.id, true);
      switchView('inbox');
      scrollToSelected();
      break;
    }
    case 'open-page': {
      if (payload.page === 'settings') openSettingsModal();
      else if (payload.page === 'rules') openRulesModal();
      break;
    }
    case 'toast': {
      toast(payload.message || '', payload.kind || 'info');
      break;
    }
    default:
      break;
  }
}

/* --------------------------------------------------------------------------
   数据计算
   -------------------------------------------------------------------------- */

function computeStats() {
  const all = state.messages;
  const inbox = all.filter((m) => m.level !== 'ignore' && !m.ignored);
  const unread = inbox.filter((m) => !m.read);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = inbox.filter((m) => Number(m.receivedAt) >= todayStart.getTime()).length;
  return {
    total: all.length,
    inbox: inbox.length,
    unread: unread.length,
    today
  };
}

function countByCategory() {
  const map = {};
  for (const m of state.messages) {
    if (m.level === 'ignore' || m.ignored) continue;
    map[m.category] = (map[m.category] || 0) + 1;
  }
  return map;
}

function visibleMessages() {
  let list = state.messages.slice();
  if (state.view === 'inbox') list = list.filter((m) => m.level !== 'ignore' && !m.ignored);
  else if (state.view === 'unread') list = list.filter((m) => m.level !== 'ignore' && !m.ignored && !m.read);
  else if (state.view === 'starred') list = list.filter((m) => m.favorite);
  else if (state.view === 'ignored') list = list.filter((m) => m.ignored);
  else if (state.view === 'category') list = list.filter((m) => m.category === state.category && m.level !== 'ignore' && !m.ignored);

  if (state.search) {
    const q = state.search.trim().toLowerCase();
    if (q) {
      list = list.filter((m) =>
        [m.content, m.sender, m.groupName, m.sessionName, m.reason, m.summary, categoryMeta(m.category).label]
          .join(' ')
          .toLowerCase()
          .includes(q)
      );
    }
  }

  if (state.sort === 'importance') {
    list.sort((a, b) => {
      const rank = (m) => (m.level === 'notify' ? 0 : m.level === 'list' ? 1 : 2);
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return Number(b.timestamp) - Number(a.timestamp);
    });
  } else {
    list.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  }
  return list;
}

/* --------------------------------------------------------------------------
   渲染
   -------------------------------------------------------------------------- */

function renderAll() {
  renderSidebar();
  renderHeaderActions();
  renderStatus();
  renderList();
  renderDetail();
}

function renderSidebar() {
  const cats = countByCategory();
  if (refs.badgeInbox) setText(refs.badgeInbox, state.stats.inbox);
  if (refs.badgeUnread) setText(refs.badgeUnread, state.stats.unread);
  if (refs.badgeStarred) setText(refs.badgeStarred, state.messages.filter((m) => m.favorite).length);
  if (refs.badgeIgnored) setText(refs.badgeIgnored, state.messages.filter((m) => m.ignored).length);
  if (refs.badgeAll) setText(refs.badgeAll, state.messages.length);
  if (refs.badgeUnread) refs.badgeUnread.classList.toggle('is-hot', state.stats.unread > 0);

  // 分类导航
  if (refs.catNav) {
    refs.catNav.innerHTML = CATEGORY_ORDER.map((key) => {
      const meta = categoryMeta(key);
      const count = cats[key] || 0;
      const active = state.view === 'category' && state.category === key;
      return `<button class="nav-item${active ? ' is-active' : ''}" data-view="category" data-category="${key}" type="button">
        <span class="cat-dot" style="--c:${meta.color}"></span>
        <span>${escapeHtml(meta.label)}</span>
        <span class="nav-badge">${count}</span>
      </button>`;
    }).join('');
  }

  // 侧栏底部数据源卡片
  const info = statusInfo();
  if (refs.sourceDot) refs.sourceDot.className = `source-dot ${info.dotClass}`;
  if (refs.sourceState) setText(refs.sourceState, info.sourceMessage);
  if (refs.btnDemo) setText(refs.btnDemo, state.demo ? '退出演示' : '演示模式');
  if (refs.sidebarStats) {
    refs.sidebarStats.innerHTML = `今日 <b>${state.stats.today}</b> · 未读 <b>${state.stats.unread}</b> · 共 <b>${state.stats.total}</b>`;
  }
  if (refs.demoBanner) refs.demoBanner.hidden = !state.demo;

  // 视图按钮高亮（非分类）
  $$('.nav-item[data-view]').forEach((btn) => {
    if (btn.dataset.view === 'category') return;
    btn.classList.toggle('is-active', state.view === btn.dataset.view);
  });
}

function renderHeaderActions() {
  if (refs.btnPause) {
    refs.btnPause.innerHTML = icon(state.paused ? 'play' : 'pause');
    refs.btnPause.title = state.paused ? '恢复提醒' : '暂停提醒';
    refs.btnPause.classList.toggle('is-active', state.paused);
  }
  if (refs.connPill) {
    const info = statusInfo();
    refs.connPill.className = `conn-pill ${info.pillClass}`;
    if (refs.connText) setText(refs.connText, info.pillText);
    refs.connPill.title = info.title;
  }
}

function statusInfo() {
  if (state.demo) {
    return {
      pillClass: 'is-demo',
      pillText: '演示模式',
      dotClass: 'is-demo',
      sourceMessage: '演示数据源 · 样例消息',
      statusText: '数据源：演示模式',
      hint: '正在展示样例消息流',
      title: '当前为演示模式，点击可打开设置连接真实数据源'
    };
  }
  const status = state.status || { state: 'idle', message: '' };
  const baseUrl = (state.config && state.config.source && state.config.source.baseUrl) || '';
  switch (status.state) {
    case 'connected':
      return {
        pillClass: 'is-connected',
        pillText: '已连接',
        dotClass: 'is-connected',
        sourceMessage: status.message || '实时监听中',
        statusText: '数据源：AstrWeChat · 已连接',
        hint: baseUrl,
        title: `${status.message || '已连接'} · ${baseUrl}`
      };
    case 'connecting':
      return { pillClass: 'is-reconnecting', pillText: '连接中', dotClass: 'is-reconnecting', sourceMessage: status.message || '正在连接…', statusText: '数据源：连接中…', hint: baseUrl, title: status.message };
    case 'launching':
      return { pillClass: 'is-reconnecting', pillText: '启动中', dotClass: 'is-reconnecting', sourceMessage: status.message || '正在启动 AstrWeChat…', statusText: '数据源：正在启动 AstrWeChat…', hint: status.message || '', title: status.message };
    case 'reconnecting':
      return { pillClass: 'is-reconnecting', pillText: '重连中', dotClass: 'is-reconnecting', sourceMessage: status.message || '正在重连…', statusText: '数据源：重连中', hint: status.message || '', title: status.message };
    case 'error':
      return { pillClass: 'is-error', pillText: '连接异常', dotClass: 'is-error', sourceMessage: status.message || '连接异常', statusText: '数据源：连接异常', hint: '点击查看设置', title: status.message };
    case 'no-config':
      return { pillClass: 'is-idle', pillText: '未配置', dotClass: '', sourceMessage: status.message || '尚未配置 Access Token', statusText: '数据源：未配置', hint: '点击完成配置', title: status.message };
    default:
      return { pillClass: 'is-idle', pillText: '未连接', dotClass: '', sourceMessage: status.message || '尚未连接', statusText: '数据源：未连接', hint: '', title: '点击查看设置' };
  }
}

function renderStatus() {
  const info = statusInfo();
  if (refs.statusDot) refs.statusDot.className = `status-dot ${info.dotClass}`;
  if (refs.statusSource) setText(refs.statusSource, info.statusText);
  if (refs.statusHint) setText(refs.statusHint, info.hint || '');
  if (refs.statusStats) setText(refs.statusStats, `今日 ${state.stats.today} 条通知 · 未读 ${state.stats.unread}`);
  if (refs.statusVersion) setText(refs.statusVersion, `WeNotice v${state.version}`);
}

const VIEW_TITLES = {
  inbox: '通知中心',
  unread: '未读通知',
  starred: '已收藏',
  ignored: '已忽略',
  all: '全部消息'
};

function renderList() {
  const list = visibleMessages();
  const title = state.view === 'category' ? categoryMeta(state.category).label : VIEW_TITLES[state.view] || '通知中心';
  if (refs.viewTitle) setText(refs.viewTitle, title);
  if (refs.viewCount) setText(refs.viewCount, `${list.length} 条`);
  if (refs.btnMarkAll) refs.btnMarkAll.disabled = state.stats.unread === 0;

  if (!list.length) {
    refs.messageList.innerHTML = '';
    refs.emptyState.hidden = false;
    refs.emptyState.innerHTML = emptyHTML();
    refs.messageList.hidden = true;
    bindEmptyActions();
    return;
  }

  refs.emptyState.hidden = true;
  refs.messageList.hidden = false;

  const scrollTop = refs.messageList.scrollTop;
  refs.messageList.innerHTML = list.map((m) => cardHTML(m)).join('');
  state.newIds.clear();
  // 用户停留在顶部时保持顶部，便于看到新消息；否则维持滚动位置
  refs.messageList.scrollTop = scrollTop < 80 ? 0 : scrollTop;
}

function cardHTML(m) {
  const meta = categoryMeta(m.category);
  const unread = !m.read && m.level !== 'ignore';
  const selected = state.selectedId === m.id;
  const classes = ['msg-card', `lvl-${m.level}`];
  if (unread) classes.push('is-unread');
  if (selected) classes.push('is-selected');
  if (m.ignored) classes.push('is-ignored');
  if (state.newIds.has(m.id)) classes.push('is-new');

  const aiTag = m.ai ? `<span class="tag tag-ai">${icon('sparkles')}AI 辅助</span>` : '';
  const historyTag = m.fromHistory ? '<span class="tag tag-history" title="连接时回填的历史消息">回填</span>' : '';
  const favTag = m.favorite ? `<span class="tag tag-fav">${icon('star')}已收藏</span>` : '';
  const senderPart = m.groupName && m.sender ? `<span class="msg-sender">${escapeHtml(m.sender)}</span>` : '';
  const unreadDot = unread ? '<span class="tag tag-unread-dot" title="未读"></span>' : '';

  return `<article class="${classes.join(' ')}" data-id="${escapeHtml(m.id)}" style="--c:${meta.color}" tabindex="0">
    <div class="msg-avatar">${icon(meta.icon)}</div>
    <div class="msg-main">
      <div class="msg-top">
        <span class="msg-session">${escapeHtml(m.sessionName || '未知会话')}</span>
        ${senderPart}
        <span class="msg-time">${relTime(m.timestamp)}</span>
      </div>
      <p class="msg-content">${escapeHtml(m.summary || m.content || `[${mediaLabel(m)}]`)}</p>
      <div class="msg-tags">
        <span class="tag tag-cat" style="--c:${meta.color}">${icon(meta.icon)}${escapeHtml(meta.label)}</span>
        ${historyTag}
        <span class="tag tag-reason" title="${escapeHtml(m.reason || '')}">${escapeHtml(truncate(m.reason || '', 22))}</span>
        ${aiTag}
        ${favTag}
        ${unreadDot}
      </div>
    </div>
  </article>`;
}

function mediaLabel(m) {
  const map = { image: '图片', voice: '语音', video: '视频', file: '文件', emoji: '表情', link: '链接' };
  return map[m.mediaType] || '消息';
}

function emptyHTML() {
  if (state.search) {
    return `<div class="empty-icon">${icon('search')}</div>
      <p class="empty-title">没有匹配「${escapeHtml(state.search)}」的消息</p>
      <p class="empty-text">试试别的关键词，或清空搜索查看全部通知。</p>
      <div class="empty-actions"><button class="btn" data-empty="clear-search">${icon('x')}清空搜索</button></div>`;
  }
  if (state.view === 'starred') {
    return `<div class="empty-icon">${icon('star')}</div>
      <p class="empty-title">还没有收藏的消息</p>
      <p class="empty-text">在消息详情中点击「收藏」，重要通知就会集中出现在这里。</p>`;
  }
  if (state.view === 'ignored') {
    return `<div class="empty-icon">${icon('eyeoff')}</div>
      <p class="empty-title">没有已忽略的消息</p>
      <p class="empty-text">被忽略的通知会收纳到这里，随时可以恢复。</p>`;
  }
  if (state.view === 'unread') {
    return `<div class="empty-icon">${icon('check')}</div>
      <p class="empty-title">所有通知都已读</p>
      <p class="empty-text">新消息到达时，符合条件的通知会自动提醒你。</p>`;
  }
  if (state.demo) {
    return `<div class="empty-icon">${icon('sparkles')}</div>
      <p class="empty-title">演示数据即将到来</p>
      <p class="empty-text">正在生成样例消息，几秒后即可看到各类通知的筛选效果。</p>`;
  }
  const info = statusInfo();
  const statusState = (state.status && state.status.state) || 'idle';
  if (statusState === 'error' || statusState === 'launching' || statusState === 'connecting' || statusState === 'reconnecting') {
    const isError = statusState === 'error';
    const isWaiting = !isError;
    return `<div class="empty-icon">${icon(isError ? 'alert' : 'refresh')}</div>
      <p class="empty-title">${isError ? '还没有连上微信数据源' : statusState === 'launching' ? '正在启动 AstrWeChat' : '正在连接数据源'}</p>
      <p class="empty-text">${escapeHtml(info.sourceMessage || '')}${isWaiting ? '' : '<br>微信消息会在连接成功后实时筛选并显示在这里。'}</p>
      <div class="empty-actions">
        <button class="btn btn-primary" data-empty="settings">${icon('gear')}打开设置</button>
        ${isError ? `<button class="btn" data-empty="reconnect">${icon('refresh')}重新连接</button>` : ''}
        <button class="btn" data-empty="demo">${icon('zap')}演示预览</button>
      </div>`;
  }
  const hasToken = Boolean(state.config && state.config.source && state.config.source.token);
  if (!hasToken) {
    return `<div class="empty-icon">${icon('bell')}</div>
      <p class="empty-title">还没有收到任何通知</p>
      <p class="empty-text">WeNotice 需要先连接 AstrWeChat 的本地 API。完成一次配置后，微信消息会被实时筛选，只有通知类消息会出现在这里。</p>
      <div class="empty-actions">
        <button class="btn btn-primary" data-empty="settings">${icon('gear')}去配置数据源</button>
        <button class="btn" data-empty="demo">${icon('zap')}先看看演示</button>
      </div>`;
  }
  return `<div class="empty-icon">${icon('inbox')}</div>
    <p class="empty-title">暂时没有新的通知</p>
    <p class="empty-text">数据源已配置，WeNotice 正在后台等待消息。当群公告、验证码、转账、快递、日程等消息到达时会自动出现。</p>
    <div class="empty-actions">
      <button class="btn" data-empty="demo">${icon('zap')}演示模式预览</button>
    </div>`;
}

function bindEmptyActions() {
  $$('[data-empty]', refs.emptyState).forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.empty;
      if (act === 'settings') openSettingsModal();
      else if (act === 'demo') window.we.toggleDemo(!state.demo);
      else if (act === 'reconnect') {
        window.we.reconnect().then((result) => {
          toast(result && result.ok === false ? result.error || '连接失败' : '已开始重新连接', result && result.ok === false ? 'err' : 'ok', 4000);
        });
      } else if (act === 'clear-search') {
        state.search = '';
        if (refs.searchInput) refs.searchInput.value = '';
        renderList();
      }
    });
  });
}

function renderDetail() {
  const record = state.messages.find((m) => m.id === state.selectedId);
  if (!record) {
    refs.detailPlaceholder.hidden = false;
    refs.detailBody.hidden = true;
    refs.detailBody.innerHTML = '';
    return;
  }
  refs.detailPlaceholder.hidden = true;
  refs.detailBody.hidden = false;

  const meta = categoryMeta(record.category);
  const action = ACTION_META[record.level] || ACTION_META.list;
  const aiBlock = record.ai && record.ai.summary
    ? `<div class="detail-message" style="border-color:rgba(139,124,255,.3);background:rgba(139,124,255,.08)">${icon('sparkles')} <b>AI 摘要</b><br>${escapeHtml(record.ai.summary)}</div>`
    : '';

  refs.detailBody.innerHTML = `
    <div class="detail-top">
      <span class="detail-cat" style="--c:${meta.color}">${icon(meta.icon)}${escapeHtml(meta.label)}</span>
      <div class="detail-top-right">
        <button class="icon-btn" data-act="fav" title="${record.favorite ? '取消收藏' : '收藏'}">${icon('star')}</button>
        <button class="icon-btn" data-act="copy" title="复制内容">${icon('copy')}</button>
      </div>
    </div>
    <div>
      <h3 class="detail-session">${escapeHtml(record.sessionName || '未知会话')}</h3>
      <div class="detail-meta-line">
        ${record.sender ? `<span>${escapeHtml(record.sender)}</span>` : ''}
        <span>${relTime(record.timestamp)} · ${absTime(record.timestamp)}</span>
      </div>
    </div>
    ${aiBlock}
    <div class="detail-message">${escapeHtml(record.content || `[${mediaLabel(record)}]`)}</div>
    <div class="detail-grid">
      <div><div class="k">提醒动作</div><div class="v">${action.label}${record.level === 'notify' ? ' · 已弹出桌面通知' : ''}</div></div>
      <div><div class="k">会话类型</div><div class="v">${sessionTypeLabel(record.sessionType)}</div></div>
      <div class="span-2"><div class="k">命中原因</div><div class="v">${escapeHtml(record.reason || '-')}</div></div>
      <div><div class="k">接收时间</div><div class="v">${absTime(record.receivedAt / 1000)}</div></div>
      <div><div class="k">消息来源</div><div class="v">${record.isDemo ? '演示数据' : 'AstrWeChat / WeFlow'}</div></div>
      <div class="span-2"><div class="k">消息 ID</div><div class="v" style="font-family:ui-monospace,monospace;font-size:10.5px;color:#8f9bb0;word-break:break-all">${escapeHtml(record.id)}</div></div>
    </div>
    <div class="detail-actions">
      <button class="btn btn-sm" data-act="fav">${icon('star')}${record.favorite ? '取消收藏' : '收藏'}</button>
      <button class="btn btn-sm" data-act="ignore">${icon('eyeoff')}${record.ignored ? '取消忽略' : '忽略'}</button>
      <button class="btn btn-sm" data-act="read">${icon('check')}${record.read ? '标记未读' : '标记已读'}</button>
      <button class="btn btn-sm" data-act="copy">${icon('copy')}复制</button>
    </div>
    <details class="raw-block">
      <summary>原始消息 JSON</summary>
      <pre class="raw-pre">${escapeHtml(JSON.stringify(record, null, 2))}</pre>
    </details>
  `;
}

function sessionTypeLabel(type) {
  const map = { group: '群聊', private: '私聊', official: '公众号', system: '系统', other: '其他' };
  return map[type] || type || '其他';
}

/* --------------------------------------------------------------------------
   事件绑定
   -------------------------------------------------------------------------- */

function bindStaticEvents() {
  // 窗口控制
  $('#winMin').addEventListener('click', () => window.we.winMin());
  $('#winMax').addEventListener('click', () => window.we.winMax());
  $('#winClose').addEventListener('click', () => window.we.winClose());

  // 搜索
  refs.searchInput.addEventListener('input', () => {
    state.search = refs.searchInput.value;
    renderList();
  });
  refs.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      refs.searchInput.value = '';
      state.search = '';
      renderList();
      refs.searchInput.blur();
    }
  });

  // 视图切换
  $('.sidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    if (btn.dataset.view === 'category') {
      state.view = 'category';
      state.category = btn.dataset.category;
    } else {
      switchView(btn.dataset.view);
    }
    renderSidebar();
    renderList();
  });

  // 排序
  refs.sortSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    state.sort = btn.dataset.sort;
    $$('.seg-btn', refs.sortSwitch).forEach((el) => el.classList.toggle('is-on', el === btn));
    renderList();
  });

  // 消息列表点击
  refs.messageList.addEventListener('click', (e) => {
    const card = e.target.closest('.msg-card');
    if (!card) return;
    selectMessage(card.dataset.id);
  });
  refs.messageList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.msg-card');
    if (!card) return;
    e.preventDefault();
    selectMessage(card.dataset.id);
  });

  // 详情操作
  refs.detailBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const record = state.messages.find((m) => m.id === state.selectedId);
    if (!record) return;
    const act = btn.dataset.act;
    if (act === 'copy') {
      navigator.clipboard.writeText(record.content || '').then(() => toast('已复制消息内容', 'ok')).catch(() => toast('复制失败', 'err'));
    } else if (act === 'fav') {
      patchMessage(record.id, { favorite: !record.favorite });
      toast(record.favorite ? '已取消收藏' : '已收藏', 'ok', 2000);
    } else if (act === 'ignore') {
      patchMessage(record.id, { ignored: !record.ignored });
      toast(record.ignored ? '已取消忽略' : '已忽略该通知', 'ok', 2000);
    } else if (act === 'read') {
      patchMessage(record.id, { read: !record.read });
    }
  });

  // 暂停提醒
  refs.btnPause.addEventListener('click', async () => {
    const result = await window.we.togglePause(!state.paused);
    state.paused = Boolean(result && result.paused);
    if (!state.paused) {
      toast('提醒已恢复', 'ok', 2000);
    }
    renderHeaderActions();
  });

  // 连接状态胶囊
  refs.connPill.addEventListener('click', async () => {
    if (state.demo) {
      openSettingsModal();
      return;
    }
    const status = state.status || {};
    if (status.state === 'no-config' || status.state === 'error') {
      openSettingsModal();
      return;
    }
    if (status.state === 'idle') {
      const result = await window.we.reconnect();
      if (result && result.ok === false) toast(result.error || '连接失败', 'err');
      return;
    }
    toast(status.message || '数据源运行中', 'info');
  });

  // 规则 / 设置
  $('#btnRules').addEventListener('click', openRulesModal);
  $('#btnSettings').addEventListener('click', openSettingsModal);

  // 数据源操作
  refs.btnTest.addEventListener('click', testConnection);
  refs.btnDemo.addEventListener('click', () => window.we.toggleDemo(!state.demo));
  $('#btnDemoBanner').addEventListener('click', () => window.we.toggleDemo(false));

  // 工具按钮
  refs.btnMarkAll.addEventListener('click', async () => {
    await window.we.markAllRead();
    state.messages.forEach((m) => { m.read = true; });
    state.stats = computeStats();
    renderList();
    renderSidebar();
    renderStatus();
    toast('已全部标记为已读', 'ok', 2200);
  });

  refs.btnExport.addEventListener('click', async () => {
    const result = await window.we.exportHistory();
    if (result && result.ok) toast(`已导出到 ${result.filePath}`, 'ok', 5000);
    else if (result && result.canceled) toast('已取消导出', 'info', 1800);
    else toast('导出失败', 'err');
  });

  // 弹窗关闭
  refs.modalRoot.addEventListener('click', (e) => {
    if (e.target === refs.modalRoot) closeModal();
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      refs.searchInput.focus();
      refs.searchInput.select();
      return;
    }
    if (e.key === 'Escape') {
      if (state.modal) closeModal();
      else if (state.search) {
        refs.searchInput.value = '';
        state.search = '';
        renderList();
      }
    }
  });
}

function switchView(view) {
  state.view = view;
  if (view !== 'category') state.category = 'all';
}

function selectMessage(id, silent = false) {
  const record = state.messages.find((m) => m.id === id);
  if (!record) return;
  state.selectedId = id;
  if (!record.read && record.level !== 'ignore') {
    record.read = true;
    state.stats = computeStats();
    window.we.updateMessage(id, { read: true }).catch(() => {});
  }
  renderList();
  renderDetail();
  renderSidebar();
  if (!silent) {
    const el = refs.messageList.querySelector(`[data-id="${cssEscape(id)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function scrollToSelected() {
  const el = refs.messageList.querySelector(`[data-id="${cssEscape(state.selectedId)}"]`);
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

async function patchMessage(id, patch) {
  const record = state.messages.find((m) => m.id === id);
  if (!record) return;
  Object.assign(record, patch);
  state.stats = computeStats();
  renderList();
  renderDetail();
  renderSidebar();
  try {
    await window.we.updateMessage(id, patch);
  } catch (_err) {
    /* noop */
  }
}

async function testConnection() {
  const original = refs.btnTest.textContent;
  refs.btnTest.disabled = true;
  refs.btnTest.textContent = '测试中…';
  try {
    const result = await window.we.testSource();
    if (!result) {
      toast('测试失败：无返回', 'err');
      return;
    }
    if (result.ok) {
      const parts = ['连接正常'];
      if (result.sessionCount != null) parts.push(`发现 ${result.sessionCount} 个会话`);
      if (result.tokenValid === false) parts.push('Token 无效');
      if (result.pushReady === false) parts.push('推送接口不可用（将使用轮询）');
      toast(parts.join(' · '), result.tokenValid === false ? 'err' : 'ok', 4500);
      if (result.tokenValid === false) openSettingsModal();
    } else {
      toast(result.error || '连接失败', 'err', 6000);
      openSettingsModal();
    }
  } catch (err) {
    toast(`测试失败：${err.message}`, 'err');
  } finally {
    refs.btnTest.disabled = false;
    refs.btnTest.textContent = original || '测试连接';
  }
}

/* --------------------------------------------------------------------------
   弹窗基础
   -------------------------------------------------------------------------- */

function openModal({ title, subtitle = '', body, footer = '', size = '' }) {
  refs.modalRoot.hidden = false;
  refs.modalRoot.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-head">
        <div>
          <div class="modal-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="modal-sub">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <button class="modal-close" data-modal-close type="button" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>
  `;
  refs.modalRoot.querySelector('[data-modal-close]').addEventListener('click', closeModal);
  state.modal = title;
  const focusable = refs.modalRoot.querySelector('.modal-body input, .modal-body textarea, .modal-body select');
  if (focusable) setTimeout(() => focusable.focus(), 60);
}

function closeModal() {
  if (!state.modal) return;
  state.modal = null;
  refs.modalRoot.hidden = true;
  refs.modalRoot.innerHTML = '';
  const hadFocus = state.selectedId;
  if (hadFocus) renderDetail();
}

function confirmModal(message, { okText = '确认', danger = true } = {}) {
  return new Promise((resolve) => {
    openModal({
      title: '请确认',
      size: 'is-sm',
      body: `<p style="font-size:12.5px;line-height:1.7;color:var(--text-2)">${escapeHtml(message)}</p>`,
      footer: `<button class="btn btn-ghost" data-confirm="0">取消</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm="1">${escapeHtml(okText)}</button>`
    });
    refs.modalRoot.querySelectorAll('[data-confirm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ok = btn.dataset.confirm === '1';
        closeModal();
        resolve(ok);
      });
    });
  });
}

/* --------------------------------------------------------------------------
   设置弹窗
   -------------------------------------------------------------------------- */

function settingsBody() {
  const cfg = state.config || {};
  const source = cfg.source || {};
  const notify = cfg.notify || {};
  const ai = cfg.ai || {};
  const appCfg = cfg.app || {};
  const filters = cfg.filters || {};
  const on = (v) => (v ? ' is-on' : '');
  const checked = (v) => (v ? ' checked' : '');

  return `
    <div class="section-title">数据源 · AstrWeChat / WeFlow 本地 API</div>
    <div class="field">
      <label>API 地址</label>
      <input class="input" id="setBaseUrl" value="${escapeHtml(source.baseUrl || 'http://127.0.0.1:5031')}" placeholder="http://127.0.0.1:5031">
      <div class="hint">默认 <b>127.0.0.1:5031</b>。需先在 AstrWeChat 完成微信连接；API 服务开关在 AstrWeChat 的 <b>「Bridge」页</b>（没有独立的「设置 → API」页），也可以直接点下面的「一键开启」。</div>
    </div>
    <div class="field">
      <label>Access Token</label>
      <div style="display:flex;gap:8px">
        <input class="input" id="setToken" type="password" value="${escapeHtml(source.token || '')}" placeholder="点「一键开启」或「自动读取」，无需手动复制" style="flex:1">
        <button class="btn btn-sm" id="setReadToken" type="button">自动读取</button>
      </div>
      <div class="hint">Token 用于访问本地 API，仅保存在本机配置文件中；「一键开启」「自动读取」都会直接从 AstrWeChat 的配置文件取值，不用手动复制。</div>
    </div>
    <div class="field">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm" id="setEnableAstrApi" type="button">一键开启 AstrWeChat API</button>
        <span class="hint" style="margin:0">自动写入 AstrWeChat 配置（开启 API 服务 + 主动推送）并重启它，然后自动读取 Token；AstrWeChat 需要已完成微信连接。</span>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">自动读取 Token</div><div class="setting-desc">每次连接前自动从 AstrWeChat 配置读取 Token（AstrWeChat 重启后 Token 变化也能自动跟上）</div></div>
      <button class="switch${on(source.autoTokenSync !== false)}" data-switch="autoTokenSync" type="button" aria-checked="${source.autoTokenSync !== false}"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">启动时自动连接</div><div class="setting-desc">打开应用后自动连接本地 API 并开始监听</div></div>
      <button class="switch${on(source.autoConnect)}" data-switch="autoConnect" type="button" aria-checked="${Boolean(source.autoConnect)}"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">自动启动 AstrWeChat</div><div class="setting-desc">打开 WeNotice 时如果检测不到本地 API，就自动寻找并启动 AstrWeChat，再等待它就绪</div></div>
      <button class="switch${on(source.autoLaunchAstrWechat)}" data-switch="autoLaunchAstrWechat" type="button" aria-checked="${Boolean(source.autoLaunchAstrWechat)}"></button>
    </div>
    <div class="field">
      <label>AstrWeChat.exe 路径（可选）</label>
      <input class="input" id="setAstrPath" value="${escapeHtml(source.astrwechatPath || '')}" placeholder="留空 = 自动检测（注册表 / Program Files / PATH）">
      <div class="hint">自动检测失败时，可手动填写安装路径，例如 <b>C:\\Program Files\\astrwechat\\AstrWeChat.exe</b>。</div>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">实时推送不可用时启用轮询</div><div class="setting-desc">SSE 连接不稳定时，每隔一段时间拉取新消息作为兜底</div></div>
      <button class="switch${on(source.pollFallback)}" data-switch="pollFallback" type="button" aria-checked="${Boolean(source.pollFallback)}"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">连接后回填最近消息</div><div class="setting-desc">刚打开应用时把最近 12 小时的消息补进列表（不弹桌面通知），不用等新消息才有内容</div></div>
      <button class="switch${on(source.backfillRecent !== false)}" data-switch="backfillRecent" type="button" aria-checked="${source.backfillRecent !== false}"></button>
    </div>
    <div class="field">
      <label>回填时间范围（小时）</label>
      <input class="input" id="setBackfillHours" type="number" min="1" max="72" value="${Number(source.backfillHours || 12)}">
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-sm" id="setTestSource">测试连接</button>
      <button class="btn btn-sm" id="setReconnect">重新连接</button>
    </div>
    <div class="test-result" id="sourceTestResult" hidden></div>

    <div class="section-title">提醒</div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">桌面通知</div><div class="setting-desc">命中「提醒」规则时弹出 Windows 通知</div></div>
      <button class="switch${on(notify.desktop)}" data-switch="desktop" type="button"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">提示音</div><div class="setting-desc">弹出桌面通知时播放系统提示音</div></div>
      <button class="switch${on(notify.sound)}" data-switch="sound" type="button"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">仅提醒重要分类</div><div class="setting-desc">忽略「链接 / 系统消息」等次要通知的桌面弹窗，仅收进列表</div></div>
      <button class="switch${on(notify.onlyImportant)}" data-switch="onlyImportant" type="button"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">免打扰时段</div><div class="setting-desc">该时段内不弹桌面通知，消息仍会进入通知中心</div></div>
      <button class="switch${on(notify.dndEnabled)}" data-switch="dndEnabled" type="button"></button>
    </div>
    <div class="field-row">
      <div class="field"><label>免打扰开始</label><input class="input" id="setDndStart" type="time" value="${escapeHtml(notify.dndStart || '22:30')}"></div>
      <div class="field"><label>免打扰结束</label><input class="input" id="setDndEnd" type="time" value="${escapeHtml(notify.dndEnd || '08:00')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>同一会话合并提醒（秒）</label><input class="input" id="setMerge" type="number" min="0" max="600" value="${Number(notify.mergeWindowSec || 0)}"></div>
      <div class="field"><label>每分钟最多提醒（条）</label><input class="input" id="setMaxPerMin" type="number" min="0" max="100" value="${Number(notify.maxPerMinute || 0)}"></div>
    </div>

    <div class="section-title">AI 语义增强（可选）</div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">启用 AI 辅助判定</div><div class="setting-desc">内置规则无法判断的普通消息，交给大模型判断是否属于通知；失败时自动降级</div></div>
      <button class="switch${on(ai.enabled)}" data-switch="aiEnabled" type="button"></button>
    </div>
    <div class="field-row">
      <div class="field"><label>API 地址（OpenAI 兼容）</label><input class="input" id="setAiBase" value="${escapeHtml(ai.baseUrl || '')}" placeholder="https://api.openai.com/v1"></div>
      <div class="field"><label>模型</label><input class="input" id="setAiModel" value="${escapeHtml(ai.model || '')}" placeholder="gpt-4o-mini"></div>
    </div>
    <div class="field"><label>API Key</label><input class="input" id="setAiKey" type="password" value="${escapeHtml(ai.apiKey || '')}" placeholder="sk-..."></div>
    <div class="field-row">
      <div class="field"><label>判定模式</label>
        <select class="select" id="setAiMode">
          <option value="fallback"${ai.mode === 'fallback' ? ' selected' : ''}>兜底：仅判定规则未覆盖的消息</option>
          <option value="unknown-only"${ai.mode === 'unknown-only' ? ' selected' : ''}>保守：仅判定明显普通的消息</option>
        </select>
      </div>
      <div class="field"><label>&nbsp;</label><button class="btn btn-sm" id="setTestAI">测试 AI 连接</button></div>
    </div>
    <div class="test-result" id="aiTestResult" hidden></div>

    <div class="section-title">过滤</div>
    <div class="field">
      <label>静音会话（不提醒、不进通知中心）</label>
      <textarea class="textarea" id="setMute" placeholder="每行一个群名或发送者，例如：营销群">${escapeHtml((filters.muteSessions || []).join('\n'))}</textarea>
    </div>
    <div class="field">
      <label>重点会话（一律提醒）</label>
      <textarea class="textarea" id="setAlways" placeholder="每行一个群名或发送者，例如：项目交付群">${escapeHtml((filters.alwaysSessions || []).join('\n'))}</textarea>
    </div>

    <div class="section-title">应用</div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">关闭窗口时最小化到托盘</div><div class="setting-desc">保持后台监听，从托盘图标重新打开</div></div>
      <button class="switch${on(appCfg.closeToTray)}" data-switch="closeToTray" type="button"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">最小化到托盘</div><div class="setting-desc">点最小化时隐藏到系统托盘，不占用任务栏；托盘图标在任务栏右下角「^」展开区，可拖到任务栏固定</div></div>
      <button class="switch${on(appCfg.minimizeToTray)}" data-switch="minimizeToTray" type="button"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">开机自动启动</div><div class="setting-desc">登录 Windows 后自动运行 WeNotice</div></div>
      <button class="switch${on(appCfg.launchAtStartup)}" data-switch="launchAtStartup" type="button"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text"><div class="setting-title">历史记录上限</div><div class="setting-desc">最多保留多少条消息（告警：过多会占用更多内存）</div></div>
      <input class="input" id="setHistoryLimit" type="number" min="200" max="20000" value="${Number(appCfg.historyLimit || 2000)}">
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-sm" id="setOpenData">打开数据目录</button>
      <button class="btn btn-sm" id="setOnboarding">新手引导</button>
      <button class="btn btn-sm" id="setExportDiag">导出诊断信息</button>
      <button class="btn btn-sm btn-danger" id="setClearHistory">清空全部历史</button>
    </div>
  `;
}

function openSettingsModal() {
  openModal({
    title: 'WeNotice 设置',
    subtitle: '连接 AstrWeChat 本地 API，配置提醒策略与 AI 辅助判定',
    body: settingsBody(),
    footer: `
      <button class="btn btn-ghost grow" data-settings="open-data">${icon('external')}数据目录</button>
      <button class="btn btn-ghost" data-settings="cancel">取消</button>
      <button class="btn btn-primary" data-settings="save">${icon('check')}保存设置</button>
    `,
    size: 'is-lg'
  });

  // 开关交互
  refs.modalRoot.querySelectorAll('.switch[data-switch]').forEach((sw) => {
    sw.addEventListener('click', () => sw.classList.toggle('is-on'));
  });

  $('#setTestSource').addEventListener('click', async () => {
    const box = $('#sourceTestResult');
    box.hidden = false;
    box.className = 'test-result';
    box.textContent = '正在测试连接…';
    try {
      const result = await window.we.testSource();
      box.className = `test-result ${result.ok ? 'is-ok' : 'is-err'}`;
      const lines = [];
      lines.push(`地址：${result.baseUrl || '-'}`);
      lines.push(`健康检查：${result.health ? '通过' : '失败'}`);
      if (result.tokenValid != null) lines.push(`Access Token：${result.tokenValid ? '有效' : '无效'}`);
      if (result.wxReady != null) lines.push(`微信连接：${result.wxReady ? '正常' : '未完成（需在 AstrWeChat 里连接微信数据库）'}`);
      if (result.sessionCount != null) lines.push(`会话数：${result.sessionCount}`);
      if (result.pushReady != null) lines.push(`实时推送：${result.pushReady ? '可用' : '不可用（将使用轮询回退）'}`);
      if (result.error) lines.push(`错误：${result.error}`);
      if (result.hint) lines.push(`提示：${result.hint}`);
      box.textContent = lines.join('\n');
    } catch (err) {
      box.className = 'test-result is-err';
      box.textContent = `测试失败：${err.message}`;
    }
  });

  $('#setReconnect').addEventListener('click', async () => {
    const result = await window.we.reconnect();
    toast(result && result.ok === false ? result.error || '连接失败' : '已开始重新连接', result && result.ok === false ? 'err' : 'ok');
  });

  $('#setReadToken').addEventListener('click', async () => {
    const readTokenReason = (info) => {
      const reason = (info && (info.tokenReason || (info.probe && info.probe.reason))) || '';
      const map = {
        'decrypt-failed': 'AstrWeChat 把 Token 加密保存了，但本机解不开（可能是 AstrWeChat 改了加密方式或使用了口令模式）。请打开 AstrWeChat → Bridge 页 → 启动 AstrWeChat，然后重新读取；或手动复制 Token。',
        'password-mode': 'AstrWeChat 的 Token 使用了口令（密码）模式加密，WeNotice 无法自动解密。请打开 AstrWeChat → Bridge 页 → 启动 AstrWeChat，或手动复制 Token。',
        unavailable: '当前系统加密服务不可用，无法解密 AstrWeChat 保存的 Token，请手动复制。',
        'invalid-token': '已读取 Token，但 AstrWeChat 返回 401（Token 无效）。请到 AstrWeChat → Bridge 页重新「启动 AstrWeChat」生成新 Token，再读取。',
        'not-connected': 'Token 有效，但 AstrWeChat 还没完成微信连接（请先在 AstrWeChat →「微信连接」完成连接数据库）。',
        network: 'Token 已读取，但本地 API 不可达：请确认 AstrWeChat 正在运行，且已开启本地 API 服务。',
        'no-config': '没有找到 AstrWeChat 配置文件，请先安装并打开一次 AstrWeChat。',
        'no-token': 'AstrWeChat 配置里没有 Token：请打开 AstrWeChat → Bridge 页 → 启动 AstrWeChat 生成 Token。'
      };
      return map[reason] || '';
    };
    try {
      const result = await window.we.readAstrToken();
      if (result && result.ok && result.token) {
        $('#setToken').value = result.token;
        const probe = result.probe;
        if (!probe) {
          toast('已读取 Token，但未能验证（本地 API 不可达），请确认 AstrWeChat 正在运行。', 'ok', 5200);
        } else if (probe.ok) {
          toast(`已读取 Token 并验证有效（${result.tokenEncrypted ? '已自动解密' : '明文'}）`, 'ok', 4200);
        } else {
          const extra = readTokenReason({ tokenReason: probe.reason });
          toast(extra || `Token 已读取，但校验失败：${probe.error || probe.reason}`, 'err', 6500);
        }
      } else {
        const extra = readTokenReason(result);
        toast(extra || (result && result.error) || '没有在 AstrWeChat 配置里找到可用 Token，请先在 AstrWeChat 开启 API 服务并复制 Token', 'err', 6500);
      }
    } catch (err) {
      toast(`读取失败：${err.message}`, 'err');
    }
  });

  $('#setEnableAstrApi').addEventListener('click', async () => {
    const ok = await confirmModal(
      '这会修改 AstrWeChat 的配置（开启本地 API 服务 + 主动推送），并重启 AstrWeChat 使它生效。\n\nAstrWeChat 重启期间微信数据连接会短暂中断（几秒到几十秒），完成后自动恢复。继续吗？',
      { okText: '开启并重启', danger: false }
    );
    if (!ok) return;
    const btn = $('#setEnableAstrApi');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '正在开启…';
    toast('正在开启 AstrWeChat API，请稍候（最多约 50 秒）…', 'ok', 4000);
    try {
      const result = await window.we.enableAstrApi();
      if (result && result.ok) {
        if (result.token && $('#setToken')) $('#setToken').value = result.token;
        toast(result.already ? 'AstrWeChat API 已经是开启状态，Token 已同步' : 'AstrWeChat API 已开启，Token 已同步，正在重新连接…', 'ok', 5000);
        if (result.warning) toast(result.warning, 'err', 5000);
        await window.we.reconnect();
      } else {
        const detail = result && result.log && result.log.length ? `（${result.log[result.log.length - 1]}）` : '';
        toast(`${(result && result.error) || '开启失败'}${detail}`, 'err', 7000);
      }
    } catch (err) {
      toast(`开启失败：${err.message}`, 'err', 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  $('#setExportDiag').addEventListener('click', async () => {
    try {
      const result = await window.we.exportDiagnostics();
      if (result && result.ok) toast(`诊断信息已导出：${result.filePath}`, 'ok', 4200);
      else if (!result || !result.canceled) toast('导出失败', 'err');
    } catch (err) {
      toast(`导出失败：${err.message}`, 'err');
    }
  });

  $('#setOnboarding').addEventListener('click', () => {
    closeModal();
    setTimeout(() => openOnboardingModal(), 60);
  });

  $('#setTestAI').addEventListener('click', async () => {
    const box = $('#aiTestResult');
    box.hidden = false;
    box.className = 'test-result';
    box.textContent = '正在调用 AI 接口…';
    try {
      const result = await window.we.testAI();
      if (result && result.ok) {
        box.className = 'test-result is-ok';
        box.textContent = `AI 可用（${result.elapsedMs}ms）\n判定：${result.result.notice ? '通知类' : '非通知'} · 分类：${result.result.category}\n摘要：${result.result.summary || '-'}`;
      } else {
        box.className = 'test-result is-err';
        box.textContent = `AI 测试失败：${(result && result.error) || '未知错误'}`;
      }
    } catch (err) {
      box.className = 'test-result is-err';
      box.textContent = `AI 测试失败：${err.message}`;
    }
  });

  $('#setClearHistory').addEventListener('click', async () => {
    const ok = await confirmModal('确定清空全部历史消息吗？此操作不可恢复。', { okText: '清空', danger: true });
    if (!ok) return;
    await window.we.clearHistory();
    state.messages = [];
    state.stats = computeStats();
    state.selectedId = '';
    renderList();
    renderSidebar();
    renderDetail();
    renderStatus();
    toast('历史已清空', 'ok');
  });

  refs.modalRoot.querySelectorAll('[data-settings]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.settings;
      if (act === 'cancel') {
        closeModal();
        return;
      }
      if (act === 'open-data') {
        await window.we.openDataDir();
        return;
      }
      if (act === 'save') {
        await saveSettings();
      }
    });
  });
}

async function saveSettings() {
  const get = (sel) => refs.modalRoot.querySelector(sel);
  const baseUrl = get('#setBaseUrl').value.trim().replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    toast('API 地址必须以 http:// 或 https:// 开头', 'err');
    return;
  }
  const splitLines = (value) =>
    value.split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);

  const patch = {
    source: {
      baseUrl,
      token: get('#setToken').value.trim(),
      autoTokenSync: readSwitch(get('[data-switch="autoTokenSync"]')),
      autoConnect: readSwitch(get('[data-switch="autoConnect"]')),
      autoLaunchAstrWechat: readSwitch(get('[data-switch="autoLaunchAstrWechat"]')),
      astrwechatPath: get('#setAstrPath').value.trim(),
      pollFallback: readSwitch(get('[data-switch="pollFallback"]')),
      backfillRecent: readSwitch(get('[data-switch="backfillRecent"]')),
      backfillHours: clampNumber(get('#setBackfillHours').value, 1, 72, 12)
    },
    notify: {
      desktop: readSwitch(get('[data-switch="desktop"]')),
      sound: readSwitch(get('[data-switch="sound"]')),
      onlyImportant: readSwitch(get('[data-switch="onlyImportant"]')),
      dndEnabled: readSwitch(get('[data-switch="dndEnabled"]')),
      dndStart: get('#setDndStart').value || '22:30',
      dndEnd: get('#setDndEnd').value || '08:00',
      mergeWindowSec: clampNumber(get('#setMerge').value, 0, 600, 20),
      maxPerMinute: clampNumber(get('#setMaxPerMin').value, 0, 100, 12)
    },
    ai: {
      enabled: readSwitch(get('[data-switch="aiEnabled"]')),
      baseUrl: get('#setAiBase').value.trim().replace(/\/+$/, ''),
      model: get('#setAiModel').value.trim(),
      apiKey: get('#setAiKey').value.trim(),
      mode: get('#setAiMode').value
    },
    filters: {
      muteSessions: splitLines(get('#setMute').value),
      alwaysSessions: splitLines(get('#setAlways').value)
    },
    app: {
      closeToTray: readSwitch(get('[data-switch="closeToTray"]')),
      minimizeToTray: readSwitch(get('[data-switch="minimizeToTray"]')),
      launchAtStartup: readSwitch(get('[data-switch="launchAtStartup"]')),
      historyLimit: clampNumber(get('#setHistoryLimit').value, 200, 20000, 2000)
    }
  };

  try {
    const result = await window.we.saveConfig(patch);
    if (result && result.config) state.config = result.config;
    closeModal();
    toast('设置已保存', 'ok', 2400);
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/* --------------------------------------------------------------------------
   规则弹窗
   -------------------------------------------------------------------------- */

let rulesDraft = [];
let ruleEditingId = '';

function cloneRule(rule) {
  return {
    id: rule.id || '',
    name: rule.name || '',
    enabled: rule.enabled !== false,
    priority: Number(rule.priority) || 100,
    action: rule.action || 'notify',
    category: rule.category || 'notice',
    scope: rule.scope || 'all',
    anyKeywords: Array.isArray(rule.anyKeywords) ? rule.anyKeywords.slice() : [],
    allKeywords: Array.isArray(rule.allKeywords) ? rule.allKeywords.slice() : [],
    excludeKeywords: Array.isArray(rule.excludeKeywords) ? rule.excludeKeywords.slice() : [],
    regex: rule.regex || '',
    senders: Array.isArray(rule.senders) ? rule.senders.slice() : [],
    sessions: Array.isArray(rule.sessions) ? rule.sessions.slice() : []
  };
}

function openRulesModal() {
  rulesDraft = (state.rules || []).map(cloneRule);
  ruleEditingId = rulesDraft.length ? rulesDraft[0].id : '';

  openModal({
    title: '通知规则',
    subtitle: '用户规则优先于内置识别 · 按优先级从小到大匹配，命中后停止继续匹配',
    body: `
      <div class="rules-layout">
        <div class="rules-list" id="rulesList"></div>
        <div class="rule-editor" id="ruleEditor"></div>
      </div>
    `,
    footer: `
      <button class="btn btn-ghost grow" id="rulesTemplates">${icon('sparkles')}添加示例规则</button>
      <button class="btn btn-ghost btn-sm" data-rules="import">${icon('download')}导入</button>
      <button class="btn btn-ghost btn-sm" data-rules="export">${icon('external')}导出</button>
      <button class="btn btn-ghost" data-rules="cancel">取消</button>
      <button class="btn btn-primary" data-rules="save">${icon('check')}保存全部</button>
    `,
    size: 'is-lg'
  });

  renderRulesList();
  renderRuleEditor();

  $('#rulesTemplates').addEventListener('click', () => {
    if (!state.templates.length) {
      toast('当前没有可用的示例模板', 'err');
      return;
    }
    for (const tpl of state.templates) {
      const exists = rulesDraft.some((r) => r.name === tpl.name);
      if (exists) continue;
      rulesDraft.push(cloneRule(Object.assign({}, tpl, { id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })));
    }
    if (!ruleEditingId && rulesDraft.length) ruleEditingId = rulesDraft[0].id;
    renderRulesList();
    renderRuleEditor();
    toast('已加入示例规则（未保存前可继续调整）', 'ok', 2600);
  });

  refs.modalRoot.querySelectorAll('[data-rules]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.rules;
      if (act === 'cancel') {
        closeModal();
        return;
      }
      if (act === 'save') {
        try {
          const result = await window.we.saveRules(rulesDraft);
          state.rules = result.rules || rulesDraft;
          closeModal();
          toast('规则已保存，新消息将按新规则筛选', 'ok');
        } catch (err) {
          toast(`保存失败：${err.message}`, 'err');
        }
        return;
      }
      if (act === 'export') {
        try {
          // 先把当前草稿存盘再导出，避免导出旧规则
          const saved = await window.we.saveRules(rulesDraft);
          state.rules = saved.rules || rulesDraft;
          const result = await window.we.exportRules();
          if (result && result.ok) toast(`已导出 ${result.count} 条规则：${result.filePath}`, 'ok', 4200);
          else if (!result || !result.canceled) toast((result && result.error) || '导出失败', 'err');
        } catch (err) {
          toast(`导出失败：${err.message}`, 'err');
        }
        return;
      }
      if (act === 'import') {
        try {
          const result = await window.we.importRules();
          if (result && result.ok) {
            state.rules = result.rules || state.rules;
            rulesDraft = (state.rules || []).map(cloneRule);
            if (!rulesDraft.some((r) => r.id === ruleEditingId)) ruleEditingId = rulesDraft.length ? rulesDraft[0].id : '';
            renderRulesList();
            renderRuleEditor();
            toast(`已导入并保存 ${result.imported} 条规则`, 'ok', 3000);
          } else if (!result || !result.canceled) {
            toast((result && result.error) || '导入失败', 'err');
          }
        } catch (err) {
          toast(`导入失败：${err.message}`, 'err');
        }
      }
    });
  });
}

function renderRulesList() {
  const host = $('#rulesList');
  if (!host) return;
  host.innerHTML = `
    <div class="rules-list-head">
      <button class="btn btn-sm btn-primary" id="ruleNew">${icon('plus')}新建规则</button>
      <span style="flex:1"></span>
      <span class="rule-state">${rulesDraft.length} 条</span>
    </div>
    ${rulesDraft
      .map((rule) => {
        const action = ACTION_META[rule.action] || ACTION_META.notify;
        const editing = rule.id === ruleEditingId;
        return `<button class="rule-item${editing ? ' is-editing' : ''}" data-rule-id="${escapeHtml(rule.id)}" type="button">
          <div class="rule-item-top">
            <span class="rule-name">${escapeHtml(rule.name || '未命名规则')}</span>
            <span class="rule-state">${rule.enabled ? '启用' : '停用'}</span>
          </div>
          <div class="rule-chips">
            <span class="rule-chip ${action.cls}">${action.label}</span>
            <span class="rule-chip">优先级 ${rule.priority}</span>
            <span class="rule-chip">${escapeHtml(categoryMeta(rule.category).label)}</span>
          </div>
        </button>`;
      })
      .join('')}
  `;

  host.querySelectorAll('[data-rule-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      ruleEditingId = btn.dataset.ruleId;
      renderRulesList();
      renderRuleEditor();
    });
  });

  const newBtn = $('#ruleNew');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      const rule = cloneRule({
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: '新规则',
        priority: 100,
        action: 'notify',
        category: 'notice'
      });
      rulesDraft.push(rule);
      ruleEditingId = rule.id;
      renderRulesList();
      renderRuleEditor();
    });
  }
}

function renderRuleEditor() {
  const host = $('#ruleEditor');
  if (!host) return;
  const rule = rulesDraft.find((r) => r.id === ruleEditingId);
  if (!rule) {
    host.innerHTML = `<div class="rule-editor-empty">${icon('sliders')}<span>在左侧选择一条规则，或新建规则</span></div>`;
    return;
  }

  const categoryOptions = Object.keys(state.categories)
    .map((key) => `<option value="${key}"${rule.category === key ? ' selected' : ''}>${escapeHtml(state.categories[key].label)}</option>`)
    .join('');
  const actionOptions = Object.keys(ACTION_META)
    .map((key) => `<option value="${key}"${rule.action === key ? ' selected' : ''}>${ACTION_META[key].label}</option>`)
    .join('');
  const scopeOptions = [
    ['all', '全部会话'],
    ['group', '仅群聊'],
    ['private', '仅私聊'],
    ['official', '仅公众号'],
    ['service', '仅服务/系统消息']
  ]
    .map(([key, label]) => `<option value="${key}"${rule.scope === key ? ' selected' : ''}>${label}</option>`)
    .join('');
  const listToText = (list) => (list || []).join('\n');

  host.innerHTML = `
    <div class="field-row">
      <div class="field"><label>规则名称</label><input class="input" id="reName" value="${escapeHtml(rule.name)}" placeholder="例如：项目群 @我"></div>
      <div class="field"><label>优先级（越小越先匹配）</label><input class="input" id="rePriority" type="number" min="1" max="9999" value="${rule.priority}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>命中动作</label><select class="select" id="reAction">${actionOptions}</select></div>
      <div class="field"><label>归入分类</label><select class="select" id="reCategory">${categoryOptions}</select></div>
    </div>
    <div class="field">
      <label>作用范围</label>
      <select class="select" id="reScope">${scopeOptions}</select>
    </div>
    <div class="field">
      <label>触发关键词（任一命中即满足，每行或逗号分隔）</label>
      <textarea class="textarea" id="reAny" placeholder="群公告&#10;@所有人">${escapeHtml(listToText(rule.anyKeywords))}</textarea>
    </div>
    <div class="field-row">
      <div class="field"><label>必须全部包含</label><textarea class="textarea" id="reAll" placeholder="每行一个">${escapeHtml(listToText(rule.allKeywords))}</textarea></div>
      <div class="field"><label>排除关键词</label><textarea class="textarea" id="reExclude" placeholder="命中则规则不生效">${escapeHtml(listToText(rule.excludeKeywords))}</textarea></div>
    </div>
    <div class="field">
      <label>正则匹配（可选，JS 语法）</label>
      <input class="input" id="reRegex" value="${escapeHtml(rule.regex)}" placeholder="例如：(验证码|校验码).{0,12}\\d{3,8}">
    </div>
    <div class="field-row">
      <div class="field"><label>发送者包含</label><textarea class="textarea" id="reSenders" placeholder="每行一个">${escapeHtml(listToText(rule.senders))}</textarea></div>
      <div class="field"><label>会话名包含</label><textarea class="textarea" id="reSessions" placeholder="每行一个">${escapeHtml(listToText(rule.sessions))}</textarea></div>
    </div>
    <div class="setting-row" style="border-top:1px dashed rgba(255,255,255,.055);margin-top:4px">
      <div class="setting-text"><div class="setting-title">启用此规则</div><div class="setting-desc">停用后规则保留但不参与匹配</div></div>
      <button class="switch${rule.enabled ? ' is-on' : ''}" id="reEnabled" type="button"></button>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-sm btn-primary" id="reSave">${icon('check')}保存此规则</button>
      <button class="btn btn-sm btn-danger" id="reDelete">${icon('trash')}删除</button>
    </div>
  `;

  $('#reEnabled').addEventListener('click', (e) => e.currentTarget.classList.toggle('is-on'));

  $('#reSave').addEventListener('click', () => {
    collectRuleEditor(rule);
    renderRulesList();
    renderRuleEditor();
    toast('规则已更新（记得点「保存全部」写入配置）', 'ok', 2600);
  });

  $('#reDelete').addEventListener('click', async () => {
    const ok = await confirmModal(`删除规则「${rule.name || '未命名'}」？`, { okText: '删除', danger: true });
    if (!ok) return;
    rulesDraft = rulesDraft.filter((r) => r.id !== rule.id);
    ruleEditingId = rulesDraft.length ? rulesDraft[0].id : '';
    renderRulesList();
    renderRuleEditor();
  });
}

function collectRuleEditor(rule) {
  const get = (sel) => refs.modalRoot.querySelector(sel);
  const split = (value) => value.split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);
  rule.name = get('#reName').value.trim() || '未命名规则';
  rule.priority = clampNumber(get('#rePriority').value, 1, 9999, 100);
  rule.action = get('#reAction').value;
  rule.category = get('#reCategory').value;
  rule.scope = get('#reScope').value;
  rule.anyKeywords = split(get('#reAny').value);
  rule.allKeywords = split(get('#reAll').value);
  rule.excludeKeywords = split(get('#reExclude').value);
  rule.regex = get('#reRegex').value.trim();
  rule.senders = split(get('#reSenders').value);
  rule.sessions = split(get('#reSessions').value);
  rule.enabled = readSwitch(get('#reEnabled'));
}

