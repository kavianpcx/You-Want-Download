'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme } = require('electron');
const path = require('node:path');
const { DownloadEngine } = require('./engine.cjs');
const { autoUpdater } = require('electron-updater');

const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
let window, engine;
let updaterState = { status: 'idle', message: '', percent: 0, portable: isPortable };
const send = (channel, data) => { if (window && !window.isDestroyed()) window.webContents.send(channel, data); };
const reportUpdate = (status, message = '', percent = 0) => {
  updaterState = { status, message, percent, portable: isPortable };
  send('updater:status', updaterState);
};

const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    if (window) { window.show(); window.focus(); }
    const protocol = argv.find(arg => arg.startsWith('ywd://'));
    if (protocol) handleProtocol(protocol);
  });
}
app.setAsDefaultProtocolClient('ywd');

function handleProtocol(raw) {
  try {
    const uri = new URL(raw);
    if (uri.hostname !== 'download') return;
    const url = uri.searchParams.get('url');
    if (!url) return;
    if (!engine) { app.once('ready', () => setTimeout(() => handleProtocol(raw), 500)); return; }
    engine.add({ url }).catch(e => dialog.showErrorBox('Cannot add download', e.message));
    if (window) { window.show(); window.focus(); }
  } catch { /* Ignore malformed deep links. */ }
}
function createWindow() {
  window = new BrowserWindow({
    width: 1320, height: 860, minWidth: 950, minHeight: 660,
    title: 'You Want Download', backgroundColor: '#0b101c', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true }
  });
  window.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
}
function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => reportUpdate('checking', 'Checking GitHub Releases…'));
  autoUpdater.on('update-available', info => reportUpdate('available', `Version ${info.version} is available`));
  autoUpdater.on('update-not-available', () => reportUpdate('current', 'You are up to date'));
  autoUpdater.on('download-progress', info => reportUpdate('downloading', 'Downloading update…', Math.round(info.percent)));
  autoUpdater.on('update-downloaded', () => reportUpdate('ready', 'Update is ready to install', 100));
  autoUpdater.on('error', error => reportUpdate('error', String(error.message || error)));
}
function registerIpc() {
  ipcMain.handle('app:state', () => ({ ...engine.snapshot(), updater: updaterState, version: app.getVersion(), portable: isPortable }));
  ipcMain.handle('downloads:add', (_e, data) => engine.add(data || {}));
  ipcMain.handle('downloads:pause', (_e, id) => engine.pause(id));
  ipcMain.handle('downloads:resume', (_e, id) => engine.resume(id));
  ipcMain.handle('downloads:remove', (_e, id) => engine.remove(id));
  ipcMain.handle('settings:update', (_e, settings) => engine.updateSettings(settings));
  ipcMain.handle('directory:choose', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('file:show', (_e, id) => {
    const item = engine.get(id);
    return item.status === 'completed' ? shell.showItemInFolder(item.target) : null;
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('updater:check', async () => {
    if (isPortable) { reportUpdate('portable', 'Portable builds update manually from GitHub Releases.'); return; }
    if (!app.isPackaged) { reportUpdate('unavailable', 'Update checks work in installed release builds.'); return; }
    try { await autoUpdater.checkForUpdates(); } catch (e) { reportUpdate('error', e.message); }
  });
  ipcMain.handle('updater:download', async () => {
    if (isPortable || !app.isPackaged) return;
    try { await autoUpdater.downloadUpdate(); } catch (e) { reportUpdate('error', e.message); }
  });
  ipcMain.handle('updater:install', () => {
    if (updaterState.status === 'ready' && !isPortable) autoUpdater.quitAndInstall();
  });
  ipcMain.handle('app:releases', () => shell.openExternal('https://github.com/kavianpcx/You-Want-Download/releases'));
  ipcMain.handle('app:repo', () => shell.openExternal('https://github.com/kavianpcx/You-Want-Download'));
}
if (locked) app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  engine = new DownloadEngine({
    stateFile: path.join(app.getPath('userData'), 'downloads.json'),
    downloadDir: app.getPath('downloads')
  });
  engine.on('changed', state => send('downloads:changed', state));
  engine.on('error', e => send('app:error', e.message));
  await engine.init();
  setupUpdater(); registerIpc(); createWindow();
  const protocol = process.argv.find(arg => arg.startsWith('ywd://'));
  if (protocol) window.webContents.once('did-finish-load', () => handleProtocol(protocol));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
let quitting = false;
app.on('before-quit', event => {
  if (!engine || quitting) return;
  event.preventDefault(); quitting = true;
  engine.close().catch(console.error).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
