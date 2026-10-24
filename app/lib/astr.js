'use strict';

/**
 * AstrWeChat 辅助模块：定位安装路径、检测进程、拉起应用、探测本地 API。
 *
 * WeNotice 本身只消费 AstrWeChat 的本地 HTTP API（127.0.0.1:5031）。
 * 为了让用户「只开 WeNotice 一个图标」，这里负责：
 *  - 打开 WeNotice 时如果 API 不可达，自动找到并拉起 AstrWeChat；
 *  - 拉起后轮询 /health，等待 API 就绪再建立 SSE；
 *  - 失败时给出可执行的提示（未安装 / 未开启 API 服务 / 端口被占用）。
 *
 * 注意：这里不做任何微信数据解密或注入，只启动用户已安装的 AstrWeChat 程序。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile, spawn } = require('child_process');

// 主进程里优先使用 Electron 的 shell.openPath（ShellExecute，等同双击），
// 避免 Chromium/Node 的 CreateProcess 在部分环境被拒绝（EACCES）导致启动失败。
let electronShell = null;
try {
  // eslint-disable-next-line global-require
  const electron = require('electron');
  if (electron && electron.shell && typeof electron.shell.openPath === 'function') {
    electronShell = electron.shell;
  }
} catch (_err) {
  electronShell = null;
}

const COMMON_PATHS = [
  'C:\\Program Files\\astrwechat\\AstrWeChat.exe',
  'C:\\Program Files\\AstrWeChat\\AstrWeChat.exe',
  'C:\\Program Files (x86)\\astrwechat\\AstrWeChat.exe',
  'C:\\Program Files (x86)\\AstrWeChat\\AstrWeChat.exe'
];

function exists(file) {
  try {
    return Boolean(file) && fs.existsSync(file);
  } catch (_err) {
    return false;
  }
}

function execFileAsync(file, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/** 通过注册表卸载项查找安装目录（DisplayIcon / InstallLocation / UninstallString）。 */
async function registryCandidates() {
  const roots = [
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  const result = await execFileAsync('reg.exe', ['query', roots[0], '/s', '/f', 'AstrWeChat', '/d']);
  const found = [];
  const text = `${result.stdout}\n${result.stderr}`;
  for (const root of roots) {
    if (text.includes(root)) continue;
    const extra = await execFileAsync('reg.exe', ['query', root, '/s', '/f', 'AstrWeChat', '/d']);
    if (extra.stdout) found.push(extra.stdout);
  }
  found.push(text);
  const paths = [];
  for (const chunk of found) {
    const re = /(?:DisplayIcon|InstallLocation|UninstallString)\s+REG_[A-Z_]+\s+(.+)/g;
    let m;
    while ((m = re.exec(chunk))) {
      let value = m[1].trim().replace(/^"|"$/g, '');
      if (!/astrwechat/i.test(value)) continue;
      // DisplayIcon 形如 "C:\...\AstrWeChat.exe,0"；InstallLocation 可能是目录
      value = value.replace(/,\s*-?\d+$/, '').trim();
      if (/\.exe$/i.test(value)) {
        paths.push(value);
      } else if (/astrwechat/i.test(value)) {
        paths.push(path.join(value, 'AstrWeChat.exe'));
      }
    }
  }
  return paths;
}

/** 查找 AstrWeChat.exe：优先用户指定路径，然后注册表、常见安装目录、PATH。 */
async function findAstrWechat(configuredPath) {
  if (exists(configuredPath)) return configuredPath;
  const fromRegistry = await registryCandidates();
  for (const candidate of fromRegistry) {
    if (exists(candidate)) return candidate;
  }
  for (const candidate of COMMON_PATHS) {
    if (exists(candidate)) return candidate;
  }
  const where = await execFileAsync('where.exe', ['AstrWeChat.exe']);
  const first = where.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => exists(line));
  return first || '';
}

let launchGuard = null;
/** 启动 AstrWeChat（若已在运行则直接返回）。优先 ShellExecute，失败再退回 spawn。 */
async function launchAstrWechat(exePath) {
  if (!exePath || !exists(exePath)) return { ok: false, error: '未找到 AstrWeChat.exe' };
  if (await isRunning()) return { ok: true, alreadyRunning: true };
  if (launchGuard) return launchGuard;
  launchGuard = (async () => {
    try {
      if (electronShell) {
        const errMsg = await electronShell.openPath(exePath);
        if (!errMsg) return { ok: true, alreadyRunning: false, via: 'shell.openPath' };
        // ShellExecute 失败时继续尝试 spawn，最后统一报错
        const fallbackError = errMsg;
        const spawned = await spawnDetached(exePath);
        if (spawned.ok) return spawned;
        return { ok: false, error: `启动 AstrWeChat 失败：${fallbackError || spawned.error}` };
      }
      return await spawnDetached(exePath);
    } catch (err) {
      return { ok: false, error: `启动 AstrWeChat 失败：${err.message}` };
    } finally {
      launchGuard = null;
    }
  })();
  return launchGuard;
}

/** 以独立进程方式启动（不阻塞、不继承 stdio）。 */
function spawnDetached(exePath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exePath, [], {
        cwd: path.dirname(exePath),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    child.once('error', (err) => resolve({ ok: false, error: err.message }));
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, alreadyRunning: false, via: 'spawn' });
    });
  });
}

/** 检测 AstrWeChat.exe 进程是否在运行。 */
async function isRunning() {
  const task = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq AstrWeChat.exe', '/NH']);
  return /AstrWeChat\.exe/i.test(task.stdout);
}

/**
 * 停止 AstrWeChat：先温和结束（taskkill 不带 /F），最多等约 2 秒；仍在则强制结束。
 * 若 AstrWeChat 以管理员权限运行，普通权限的 taskkill 会返回「Access is denied」，
 * 此时返回 elevated:true 交给界面提示用户手动退出。
 * 返回 { ok, forced, elevated, error }。
 */
async function stopAstrWechat() {
  if (!(await isRunning())) return { ok: true, alreadyStopped: true };
  let denied = false;
  let forceFailed = false;
  const kill = async (args, isForce) => {
    const result = await execFileAsync('taskkill.exe', args, 8000);
    if (result.err) {
      const text = `${result.stdout}\n${result.stderr}\n${result.err.message || ''}`;
      if (/access is denied|access denied|拒绝访问|无法终止/i.test(text)) denied = true;
      if (isForce) forceFailed = true;
    }
    return result;
  };
  await kill(['/IM', 'AstrWeChat.exe', '/T'], false);
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!(await isRunning())) return { ok: true, alreadyStopped: false };
  }
  await kill(['/IM', 'AstrWeChat.exe', '/T', '/F'], true);
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!(await isRunning())) return { ok: true, forced: true };
  }
  return {
    ok: false,
    elevated: denied || forceFailed,
    error: 'AstrWeChat 还在运行，WeNotice 无法自动关闭它（常见原因：AstrWeChat 以管理员权限启动，或被系统/第三方软件保护）。请手动退出 AstrWeChat（任务栏托盘右键退出，或任务管理器结束任务）后再点一次「一键开启 AstrWeChat API」。'
  };
}


/** GET /health，轻量探测本地 API 是否就绪（不校验 Token）。 */
function probeHealth(baseUrl, timeout = 2500) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return Promise.resolve({ ok: false, error: '未配置 API 地址' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      const url = new URL(`${base}/health`);
      const client = url.protocol === 'https:' ? https : http;
      request = client.get(
        url,
        { timeout, headers: { Accept: 'application/json', 'User-Agent': 'WeNotice/1.0' } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              done({ ok: true, status: res.statusCode });
            } else {
              done({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
            }
          });
        }
      );
      request.on('timeout', () => {
        request.destroy();
        done({ ok: false, error: '连接超时' });
      });
      request.on('error', (err) => done({ ok: false, error: err.code || err.message }));
    } catch (err) {
      done({ ok: false, error: err.message });
    }
  });
}

/**
 * 用 Token 探测 /api/v1/sessions?limit=1，验证 Token 是否真的有效。
 * 401/403 → token 无效；500 → （AstrWeChat 未完成微信连接时）Token 本身有效但数据源未就绪；
 * 其他网络错误 → 服务不可达。
 */
function probeSessions(baseUrl, token, timeout = 3000) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return Promise.resolve({ ok: false, reason: 'no-base', error: '未配置 API 地址' });
  if (!token) return Promise.resolve({ ok: false, reason: 'no-token', error: '没有 Token' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      const url = new URL(`${base}/api/v1/sessions?limit=1`);
      const client = url.protocol === 'https:' ? https : http;
      request = client.get(
        url,
        {
          timeout,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'WeNotice/1.0',
            Authorization: `Bearer ${token}`
          }
        },
        (res) => {
          res.resume();
          if (res.statusCode === 401 || res.statusCode === 403) {
            done({ ok: false, reason: 'invalid-token', status: res.statusCode, error: `HTTP ${res.statusCode}（Token 无效）` });
          } else if (res.statusCode >= 500) {
            done({ ok: false, reason: 'not-connected', status: res.statusCode, error: `HTTP ${res.statusCode}（AstrWeChat 未完成微信连接）` });
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            done({ ok: true, status: res.statusCode });
          } else {
            done({ ok: false, reason: 'http-error', status: res.statusCode, error: `HTTP ${res.statusCode}` });
          }
        }
      );
      request.on('timeout', () => {
        request.destroy();
        done({ ok: false, reason: 'timeout', error: '连接超时' });
      });
      request.on('error', (err) => done({ ok: false, reason: 'network', error: err.code || err.message }));
    } catch (err) {
      done({ ok: false, reason: 'exception', error: err.message });
    }
  });
}

/** 轮询 /health 直到就绪或超时。 */async function waitForHealth(baseUrl, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const intervalMs = options.intervalMs || 1200;
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    const result = await probeHealth(baseUrl, 2000);
    if (result.ok) return { ok: true, elapsedMs: Date.now() - startedAt };
    lastError = result.error || '未知错误';
    if (options.onTick) {
      try {
        options.onTick(Math.round((Date.now() - startedAt) / 1000));
      } catch (_err) {
        /* 忽略回调错误 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, error: lastError || '等待超时', elapsedMs: Date.now() - startedAt };
}

module.exports = {
  findAstrWechat,
  isRunning,
  stopAstrWechat,
  launchAstrWechat,
  probeHealth,
  probeSessions,
  waitForHealth,
  exists,
  normalizeBaseUrl
};
