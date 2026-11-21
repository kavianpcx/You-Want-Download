'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, value) => ipcRenderer.invoke(channel, value);
contextBridge.exposeInMainWorld('ywd', Object.freeze({
  state: () => invoke('app:state'),
  add: data => invoke('downloads:add', data),
  pause: id => invoke('downloads:pause', id),
  resume: id => invoke('downloads:resume', id),
  remove: id => invoke('downloads:remove', id),
  updateSettings: options => invoke('settings:update', options),
  chooseDirectory: () => invoke('directory:choose'),
  showFile: id => invoke('file:show', id),
  clipboard: () => invoke('clipboard:read'),
  checkUpdate: () => invoke('updater:check'),
  downloadUpdate: () => invoke('updater:download'),
  installUpdate: () => invoke('updater:install'),
  releases: () => invoke('app:releases'),
  repository: () => invoke('app:repo'),
  onDownloads: fn => { const handler = (_event, data) => fn(data); ipcRenderer.on('downloads:changed', handler); return () => ipcRenderer.off('downloads:changed', handler); },
  onUpdate: fn => { const handler = (_event, data) => fn(data); ipcRenderer.on('updater:status', handler); return () => ipcRenderer.off('updater:status', handler); },
  onError: fn => { const handler = (_event, data) => fn(data); ipcRenderer.on('app:error', handler); return () => ipcRenderer.off('app:error', handler); }
}));
