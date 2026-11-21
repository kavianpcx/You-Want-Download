'use strict';
const $ = id => document.getElementById(id);
const api = window.ywd;
const preview = new URLSearchParams(location.search).has('preview');
let state = { items: [], settings: { concurrency: 3, segments: 4 } };
let updater = { status: 'idle', message: 'Check for a newer version on GitHub.', percent: 0 };
let filter = 'all', search = '';
const make = (tag, className = '', text = '') => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};
const icon = name => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
};
const fmtSize = value => {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  let size = value, i = 0;
  while (size >= 1024 && i < 4) { size /= 1024; i++; }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${['B','KB','MB','GB','TB'][i]}`;
};
const fmtSpeed = value => `${fmtSize(Math.max(0, value || 0))}/s`;
const escapeLabel = status => ({ queued: 'Queued', downloading: 'Downloading', completed: 'Completed', paused: 'Paused', error: 'Failed' }[status] || 'Unknown');
function toast(message) {
  const el = $('toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.hidden = true, 4500);
}
async function attempt(fn) { try { return await fn(); } catch(e) { toast(e.message || String(e)); return null; } }
function isQueued(item) { return item.status === 'queued' || item.status === 'paused'; }
function statUpdate() {
  const all = state.items, active = all.filter(i => i.status === 'downloading'), completed = all.filter(i => i.status === 'completed');
  $('stat-all').textContent = all.length;
  $('stat-active').textContent = active.length;
  $('stat-done').textContent = completed.length;
  $('stat-speed').replaceChildren(document.createTextNode(fmtSpeed(active.reduce((n, item) => n + (item.speed || 0), 0))));
  $('count-all').textContent = all.length;
  $('count-downloading').textContent = active.length;
  $('count-completed').textContent = completed.length;
  $('count-queued').textContent = all.filter(isQueued).length;
}
function matches(item) {
  const statusMatch = filter === 'all' || (filter === 'queued' ? isQueued(item) : item.status === filter);
  return statusMatch && `${item.fileName} ${item.url}`.toLowerCase().includes(search);
}
function actionButton(name, title, click) {
  const b = make('button','row-icon'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
  b.append(icon(name)); b.addEventListener('click', click); return b;
}
function row(item) {
  const el = make('div', 'download-row');
  const file = make('div', 'file-cell'), badge = make('div', 'file-badge'), info = make('div', 'file-info');
  badge.append(icon('download'));
  info.append(make('strong','',item.fileName), make('small','',new URL(item.url).hostname));
  info.title = item.url; file.append(badge, info);
  const size = make('div', 'size-cell',fmtSize(item.total));
  const progress = make('div','progress-cell'), shell = make('div','progress-shell'), bar = make('div','progress-bar');
  const ratio = item.status === 'completed' ? 100 : item.total > 0 ? Math.min(100, Math.round((item.downloaded || 0) / item.total * 100)) : 0;
  bar.style.width = ratio + '%'; shell.append(bar);
  progress.append(shell, make('div','progress-meta',`${item.total == null ? fmtSize(item.downloaded || 0) : `${ratio}%`} · ${item.status === 'downloading' ? fmtSpeed(item.speed) : fmtSize(item.downloaded || 0)}`));
  const status = make('div'); const badgeStatus = make('span',`pill-status ${item.status}`,escapeLabel(item.status));
  if (item.scheduledAt && item.status === 'queued') badgeStatus.title = 'Scheduled for ' + new Date(item.scheduledAt).toLocaleString();
  if (item.error) badgeStatus.title = item.error;
  status.append(badgeStatus);
  const actions = make('div','row-actions');
  if (item.status === 'downloading' || item.status === 'queued') actions.append(actionButton('pause','Pause download',() => attempt(() => api.pause(item.id))));
  if (item.status === 'paused' || item.status === 'error') actions.append(actionButton('play','Resume download',() => attempt(() => api.resume(item.id))));
  if (item.status === 'completed') actions.append(actionButton('folder','Show in folder',() => attempt(() => api.showFile(item.id))));
  actions.append(actionButton('trash','Remove from list',async() => { if (confirm(`Remove ${item.fileName} from the list?`)) await attempt(() => api.remove(item.id)); }));
  el.append(file, size, progress, status, actions);
  return el;
}
function render() {
  statUpdate();
  const root = $('download-rows'), visible = state.items.filter(matches);
  root.replaceChildren();
  if (!visible.length) {
    const empty = make('div','empty');
    empty.append(make('h3','',state.items.length ? 'Nothing matches this view' : 'No downloads yet'),make('p','',state.items.length ? 'Try another filter or search.' : 'Add a URL and your downloads will show up here.'));
    const btn = make('button','secondary','+ Add a download'); btn.addEventListener('click',openAdd); empty.append(btn);
    root.append(empty);
  } else { for (const item of visible) root.append(row(item)); }
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active',b.dataset.filter === filter));
  $('status-select').value = filter;
  document.querySelector('.breadcrumb strong').textContent = ({all:'Overview',downloading:'Downloading',completed:'Completed',queued:'Queue & scheduled',paused:'Paused',error:'Failed'})[filter];
}
function openAdd() { $('add-dialog').showModal(); $('url-field').focus(); }
function showUpdate() {
  $('update-dialog').showModal(); renderUpdate();
}
function renderUpdate() {
  const msg = updater.message || 'Check for a newer version on GitHub.';
  $('update-message').textContent = msg;
  const progress = $('update-progress'); progress.hidden = updater.status !== 'downloading';
  progress.firstElementChild.style.width = updater.percent + '%';
  const action = $('update-action');
  const types = { idle: 'Check now', checking: 'Checking…', available: 'Download update', downloading: `Downloading ${updater.percent}%`, ready: 'Restart and install', portable: 'Open releases', unavailable: 'Open releases', error: 'Try again', current: 'Check again' };
  action.textContent = types[updater.status] || 'Check now';
  action.disabled = ['checking','downloading'].includes(updater.status);
}
async function updateAction() {
  if (!api) return;
  if (updater.status === 'available') return attempt(() => api.downloadUpdate());
  if (updater.status === 'ready') return attempt(() => api.installUpdate());
  if (['portable','unavailable'].includes(updater.status)) return attempt(() => api.releases());
  return attempt(() => api.checkUpdate());
}
async function init() {
  if (!api) {
    if (preview) {
      // This is intentionally a design preview, not a claimed real transfer.
      const statuses = ['downloading','completed','queued','paused'];
      const names = ['design-assets-v3.zip','summer-film.mp4','product-images.zip','workstation-backup.tar'];
      state.items = names.map((name, i) => ({id:String(i),fileName:name,url:`https://example.com/${name}`,status:statuses[i],total:[1450000000,829000000,254000000,4200000000][i],downloaded:[957000000,829000000,0,1240000000][i],speed:i===0?12300000:0,scheduledAt:null}));
      const banner = make('div','preview-banner','DESIGN PREVIEW · SAMPLE DOWNLOADS');
      banner.style.cssText = 'position:fixed;right:16px;bottom:14px;z-index:4;font-size:9px;letter-spacing:1px;background:#344264;color:#d6e5ff;padding:9px 12px;border-radius:8px;pointer-events:none';
      document.body.append(banner);
    }
  } else {
    const start = await attempt(() => api.state());
    if (start) { state = { items: start.items || [], settings: start.settings }; updater = start.updater || updater; $('version').textContent = `v${start.version}`; }
    api.onDownloads(next => { state = next; render(); });
    api.onUpdate(next => { updater = next; renderUpdate(); });
    api.onError(toast);
  }
  render();
}
$('add-button').addEventListener('click',openAdd);
$('empty-add').addEventListener('click',openAdd);
$('paste-button').addEventListener('click',async() => { openAdd(); if (api) { const text = await attempt(() => api.clipboard()); if (/^https?:\/\//i.test(text || '')) $('url-field').value = text.trim(); } });
$('add-form').addEventListener('submit',e => {
  e.preventDefault();
  const data = { url: $('url-field').value, fileName: $('filename-field').value || undefined,
    directory: $('directory-field').value || undefined, scheduledAt: $('schedule-field').value || undefined };
  attempt(async() => { if (!api) return toast('Interactive downloads are available in the desktop app.'); await api.add(data); $('add-dialog').close(); $('add-form').reset(); });
});
$('browse').addEventListener('click',async() => { if (!api) return; const folder = await attempt(() => api.chooseDirectory()); if (folder) $('directory-field').value = folder; });
$('settings-button').addEventListener('click',() => { $('concurrency').value = state.settings.concurrency; $('segments').value = state.settings.segments; $('settings-dialog').showModal(); });
$('settings-form').addEventListener('submit',e => { e.preventDefault(); attempt(async() => { if (!api) return; await api.updateSettings({ concurrency:Number($('concurrency').value), segments:Number($('segments').value) }); $('settings-dialog').close(); }); });
$('updates-button').addEventListener('click',showUpdate);
$('update-action').addEventListener('click',updateAction);
$('repo-button').addEventListener('click',() => attempt(() => api?.repository()));
$('footer-repo').addEventListener('click',e => { e.preventDefault(); attempt(() => api?.repository()); });
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click',() => { filter = b.dataset.filter; render(); }));
$('status-select').addEventListener('change',e => { filter = e.target.value; render(); });
$('search').addEventListener('input',e => { search = e.target.value.toLowerCase().trim(); render(); });
init();
