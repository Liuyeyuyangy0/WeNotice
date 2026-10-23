'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程可用的受控 API。
 * 所有 invoke 都在 main.js 中做参数校验与错误兜底。
 */
contextBridge.exposeInMainWorld('we', {
  // 初始状态：配置 / 规则 / 数据源状态 / 统计
  getState: () => ipcRenderer.invoke('app:state'),

  // 消息
  queryMessages: () => ipcRenderer.invoke('msgs:query'),
  updateMessage: (id, patch) => ipcRenderer.invoke('msgs:update', { id, patch }),
  markAllRead: () => ipcRenderer.invoke('msgs:readall'),
  clearHistory: () => ipcRenderer.invoke('msgs:clear'),
  exportHistory: () => ipcRenderer.invoke('msgs:export'),

  // 配置 / 规则
  saveConfig: (patch) => ipcRenderer.invoke('cfg:save', { patch }),
  saveRules: (rules) => ipcRenderer.invoke('rules:save', { rules }),
  resetRules: () => ipcRenderer.invoke('rules:reset'),
  exportRules: () => ipcRenderer.invoke('rules:export'),
  importRules: () => ipcRenderer.invoke('rules:import'),

  // 数据源
  testSource: () => ipcRenderer.invoke('src:test'),
  reconnect: () => ipcRenderer.invoke('src:reconnect'),
  readAstrToken: () => ipcRenderer.invoke('cfg:astr-token'),
  togglePause: (value) => ipcRenderer.invoke('app:pause', { value }),
  toggleDemo: (value) => ipcRenderer.invoke('demo:toggle', { value }),
  simulateMessage: () => ipcRenderer.invoke('demo:simulate'),

  // AI 辅助
  testAI: () => ipcRenderer.invoke('ai:test'),

  // 应用
  openDataDir: () => ipcRenderer.invoke('app:openpath'),
  openExternal: (url) => ipcRenderer.invoke('app:openexternal', { url }),
  exportDiagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  quit: () => ipcRenderer.invoke('app:quit'),

  // 窗口控制
  winMin: () => ipcRenderer.send('win:min'),
  winMax: () => ipcRenderer.send('win:max'),
  winClose: () => ipcRenderer.send('win:close'),

  // 主进程事件总线（state / messages:add / messages:patch / messages:reset / focus / toast）
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('we:event', handler);
    return () => ipcRenderer.removeListener('we:event', handler);
  }
});
