'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// レンダラー（マスコット/設定画面）に安全なAPIだけを公開します。
contextBridge.exposeInMainWorld('butler', {
  // --- 会話 ---
  // メッセージを送信。応答は onChatDelta で逐次、戻り値のPromiseで全文が得られる。
  sendMessage: (text) => ipcRenderer.invoke('chat:send', text),
  onChatDelta: (cb) => {
    const listener = (_e, delta) => cb(delta);
    ipcRenderer.on('chat:delta', listener);
    return () => ipcRenderer.removeListener('chat:delta', listener);
  },
  onChatStart: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('chat:start', listener);
    return () => ipcRenderer.removeListener('chat:start', listener);
  },
  clearHistory: () => ipcRenderer.invoke('chat:clear'),

  // --- 設定 ---
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  testApiKey: (apiKey, model) => ipcRenderer.invoke('config:test', { apiKey, model }),
  onConfigChanged: (cb) => {
    const listener = (_e, cfg) => cb(cfg);
    ipcRenderer.on('config:changed', listener);
    return () => ipcRenderer.removeListener('config:changed', listener);
  },

  // --- ウィンドウ/アプリ操作 ---
  openSettings: () => ipcRenderer.invoke('window:openSettings'),
  showContextMenu: () => ipcRenderer.invoke('window:contextMenu'),
  quit: () => ipcRenderer.invoke('app:quit'),
});
