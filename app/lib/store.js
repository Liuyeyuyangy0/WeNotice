'use strict';

/**
 * 轻量持久化：config.json / rules.json / history.json 全部保存在数据目录。
 * 不引入 electron-store 等依赖，写入采用「临时文件 + rename」保证原子性。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  version: 1,
  source: {
    type: 'auto', // auto | mock
    baseUrl: 'http://127.0.0.1:5031',
    token: '',
    autoTokenSync: true,
    autoConnect: true,
    autoLaunchAstrWechat: true,
    astrwechatPath: '',
    pollFallback: true,
    pollIntervalSec: 25,
    backfillRecent: true,
    backfillHours: 12,
    demoMode: false
  },
  qq: {
    enabled: false,
    // OneBot 11 协议端（推荐 NapCatQQ）的 WebSocket 服务端地址
    wsUrl: 'ws://127.0.0.1:3001',
    token: '',
    autoConnect: true
  },
  notify: {
    desktop: true,
    sound: true,
    onlyImportant: false,
    mergeWindowSec: 20,
    maxPerMinute: 12,
    dndEnabled: false,
    dndStart: '22:30',
    dndEnd: '08:00',
    ignoreOwn: true
  },
  ai: {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    mode: 'fallback' // fallback | unknown-only
  },
  app: {
    closeToTray: true,
    minimizeToTray: true,
    launchAtStartup: false,
    historyLimit: 2000,
    minimalToast: false,
    onboarded: false
  },
  filters: {
    muteSessions: [],
    alwaysSessions: []
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return clone(base);
  if (Array.isArray(base) || Array.isArray(patch)) return clone(patch);
  if (typeof base !== 'object' || typeof patch !== 'object') return clone(patch);
  const out = clone(base);
  for (const key of Object.keys(patch)) {
    out[key] = deepMerge(base[key], patch[key]);
  }
  return out;
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'config.json');
    this.rulesPath = path.join(dataDir, 'rules.json');
    this.historyPath = path.join(dataDir, 'history.json');
    this.config = clone(DEFAULT_CONFIG);
    this.rules = [];
    this.history = [];
    this._saveTimer = null;
    ensureDir(dataDir);
  }

  load() {
    this.config = deepMerge(DEFAULT_CONFIG, readJson(this.configPath, {}));
    // 防御：字段类型纠偏
    if (!Array.isArray(this.config.filters.muteSessions)) this.config.filters.muteSessions = [];
    if (!Array.isArray(this.config.filters.alwaysSessions)) this.config.filters.alwaysSessions = [];
    const rulesRaw = readJson(this.rulesPath, null);
    this.rules = Array.isArray(rulesRaw) ? rulesRaw : [];
    const historyRaw = readJson(this.historyPath, []);
    this.history = Array.isArray(historyRaw) ? historyRaw.filter((m) => m && typeof m.id === 'string' && !m.isDemo) : [];
    return this;
  }

  saveConfig(patch) {
    this.config = deepMerge(this.config, patch || {});
    writeJson(this.configPath, this.config);
    return this.config;
  }

  saveRules(rules) {
    this.rules = Array.isArray(rules) ? rules : [];
    writeJson(this.rulesPath, this.rules);
    return this.rules;
  }

  /** 新消息插入队首（最新在前），并限制历史上限 */
  addMessage(record) {
    if (!record || !record.id) return false;
    if (this.history.some((m) => m.id === record.id)) return false;
    this.history.unshift(record);
    const limit = Math.max(200, Number(this.config.app.historyLimit) || 2000);
    if (this.history.length > limit) this.history.length = limit;
    this.scheduleFlush();
    return true;
  }

  updateMessage(id, patch) {
    const target = this.history.find((m) => m.id === id);
    if (!target) return null;
    Object.assign(target, patch || {});
    this.scheduleFlush();
    return target;
  }

  getMessage(id) {
    return this.history.find((m) => m.id === id) || null;
  }

  markAllRead() {
    let changed = 0;
    for (const m of this.history) {
      if (!m.read && !m.ignored) {
        m.read = true;
        changed += 1;
      }
    }
    this.scheduleFlush();
    return changed;
  }

  clearHistory() {
    this.history = [];
    this.flushNow();
  }

  /** 演示消息只存在于内存，不写入历史文件；进入演示模式时先清掉上一轮演示数据 */
  dropDemoMessages() {
    const before = this.history.length;
    this.history = this.history.filter((m) => !m.isDemo);
    if (this.history.length !== before) this.scheduleFlush();
    return before - this.history.length;
  }

  scheduleFlush() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushNow();
    }, 1200);
  }

  flushNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      writeJson(this.historyPath, this.history.filter((m) => !m.isDemo));
    } catch (err) {
      console.error('[store] 历史写入失败:', err.message);
    }
  }
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[store] 目录创建失败:', dir, err.message);
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    console.error('[store] 读取失败', file, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { Store, DEFAULT_CONFIG, deepMerge, clone };
