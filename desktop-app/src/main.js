'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, screen, shell, session } = require('electron');

const config = require('./config');
const claude = require('./claude');
const { CHARACTER } = require('./persona');

let mascotWindow = null;
let settingsWindow = null;

// 会話履歴（メインプロセスで保持）。
let history = [];

// --- ウィンドウ生成 ---

function createMascotWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 380;
  const height = 520;

  mascotWindow = new BrowserWindow({
    width,
    height,
    // 画面右下に配置。
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + workArea.height - height - 24,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mascotWindow.setAlwaysOnTop(true, 'screen-saver');
  mascotWindow.loadFile(path.join(__dirname, 'renderer', 'mascot.html'));

  mascotWindow.on('closed', () => {
    mascotWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 560,
    title: `${CHARACTER.name}の設定`,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// --- 右クリックメニュー ---

function popupContextMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: '会話をリセット',
      click: () => {
        history = [];
      },
    },
    { type: 'separator' },
    { label: '設定…', click: () => createSettingsWindow() },
    {
      label: 'APIキーの取得方法',
      click: () => shell.openExternal('https://console.anthropic.com/settings/keys'),
    },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]);
  menu.popup({ window: mascotWindow });
}

// --- IPC ハンドラ ---

ipcMain.handle('chat:send', async (event, text) => {
  const message = String(text || '').trim();
  if (!message) return '';

  const apiKey = config.resolveApiKey();
  if (!apiKey) {
    createSettingsWindow();
    return '__NO_API_KEY__';
  }

  const cfg = config.load();
  const client = claude.createClient(apiKey);

  history.push({ role: 'user', content: message });
  history = claude.trimHistory(history);

  const sender = event.sender;
  sender.send('chat:start');

  try {
    const reply = await claude.streamReply(client, history, cfg.model, (delta) => {
      if (!sender.isDestroyed()) sender.send('chat:delta', delta);
    });
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    // 失敗したuser発話は履歴から取り除く（次回に影響しないように）。
    history.pop();
    const msg = describeError(err);
    return `__ERROR__${msg}`;
  }
});

ipcMain.handle('chat:clear', () => {
  history = [];
  return true;
});

ipcMain.handle('config:get', () => config.load());

ipcMain.handle('config:set', (_e, partial) => {
  const merged = config.save(partial || {});
  // 設定変更を全ウィンドウに通知。
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('config:changed', merged);
  }
  return merged;
});

ipcMain.handle('config:test', async (_e, { apiKey, model }) => {
  const key = apiKey || config.resolveApiKey();
  if (!key) return { ok: false, error: 'APIキーが未設定です。' };
  try {
    const client = claude.createClient(key);
    await client.messages.create({
      model: model || 'claude-sonnet-5',
      max_tokens: 8,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
});

ipcMain.handle('window:openSettings', () => createSettingsWindow());
ipcMain.handle('window:contextMenu', () => popupContextMenu());
ipcMain.handle('app:quit', () => app.quit());

function describeError(err) {
  const status = err && err.status;
  if (status === 401) return 'APIキーが正しくありません。設定をご確認ください。';
  if (status === 403) return 'このAPIキーではモデルにアクセスできません。';
  if (status === 429) return '少々混み合っております。しばらくしてからお試しください。';
  if (status && status >= 500) return 'サーバー側で問題が発生しました。時間をおいてお試しください。';
  if (err && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(String(err.message))) {
    return 'ネットワークに接続できませんでした。接続をご確認ください。';
  }
  return (err && err.message) ? err.message : '不明なエラーが発生しました。';
}

// --- アプリ起動 ---

// 単一インスタンス化。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mascotWindow) {
      if (mascotWindow.isMinimized()) mascotWindow.restore();
      mascotWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 音声入力（マイク）の権限を許可します。
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' || permission === 'audioCapture');
    });
    createMascotWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMascotWindow();
    });
  });

  // マスコットは常駐型。全ウィンドウが閉じても即終了はしない設計だが、
  // macOS以外では設定画面を閉じただけで終了しないよう明示的に何もしない。
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
