'use strict';
// This module intentionally has no Electron dependencies so the real downloader can be tested.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const LIMIT_REDIRECTS = 8;
const PART_MIN = 1024 * 1024;
const STATES = new Set(['queued', 'downloading', 'paused', 'completed', 'error']);
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeUrl(raw) {
  const url = new URL(String(raw).trim());
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not supported.');
  return url.href;
}
function cleanName(value) {
  return (value || 'download').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'download';
}
function fileNameFromUrl(url) {
  try { return cleanName(decodeURIComponent(path.posix.basename(new URL(url).pathname)) || 'download'); }
  catch { return 'download'; }
}
function request(url, { method = 'GET', headers = {}, signal } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > LIMIT_REDIRECTS) return reject(new Error('Too many redirects'));
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, { method, headers: { 'User-Agent': 'YouWantDownload/0.1', ...headers }, signal, timeout: 25000 }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, parsed).href;
        if (!['http:', 'https:'].includes(new URL(next).protocol)) return reject(new Error('Unsafe redirect protocol'));
        resolve(request(next, { method, headers, signal }, redirects + 1));
      } else resolve({ res, url });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}
async function probe(url, signal) {
  let result = await request(url, { method: 'HEAD', signal });
  if ([405, 501, 403].includes(result.res.statusCode)) {
    result.res.resume();
    result = await request(url, { headers: { Range: 'bytes=0-0' }, signal });
  }
  const { res } = result;
  if (res.statusCode >= 400) { res.resume(); throw new Error(`Server returned HTTP ${res.statusCode}`); }
  const total = res.statusCode === 206
    ? Number(/\/(\d+)$/.exec(res.headers['content-range'] || '')?.[1])
    : Number(res.headers['content-length']);
  const length = Number.isSafeInteger(total) && total >= 0 ? total : null;
  const ranges = res.statusCode === 206 || /bytes/i.test(res.headers['accept-ranges'] || '');
  const validator = res.headers.etag || res.headers['last-modified'] || null;
  res.resume();
  return { total: length, ranges, validator };
}
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(temp, file);
}
class DownloadEngine extends EventEmitter {
  constructor({ stateFile, downloadDir, concurrency = 3, segments = 4 } = {}) {
    super();
    this.stateFile = stateFile || path.join(process.cwd(), 'downloads.json');
    this.downloadDir = downloadDir || path.join(process.cwd(), 'downloads');
    this.items = [];
    this.settings = { concurrency: Math.max(1, Math.min(8, concurrency)), segments: Math.max(1, Math.min(8, segments)) };
    this.active = new Map();
    this.saving = Promise.resolve();
    this.pumping = false;
    this.timer = null;
  }
  async init() {
    try {
      const saved = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
      this.settings = { ...this.settings, ...saved.settings };
      this.items = (saved.items || []).filter(i => i && STATES.has(i.status)).map(i => ({ ...i,
        status: i.status === 'downloading' ? 'queued' : i.status, speed: 0 }));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fsp.mkdir(this.downloadDir, { recursive: true });
    this.timer = setInterval(() => this.pump(), 1000);
    this.timer.unref?.();
    this.pump();
  }
  snapshot() { return { items: this.items.map(i => ({ ...i })), settings: { ...this.settings } }; }
  publish() { this.emit('changed', this.snapshot()); }
  persist() {
    const data = this.snapshot();
    this.saving = this.saving.catch(() => {}).then(() => atomicJson(this.stateFile, data));
    return this.saving;
  }
  async add({ url, fileName, directory, scheduledAt } = {}) {
    url = normalizeUrl(url);
    const folder = path.resolve(directory || this.downloadDir);
    const name = cleanName(fileName || fileNameFromUrl(url));
    const target = await this.uniqueTarget(folder, name);
    const parsedSchedule = scheduledAt ? new Date(scheduledAt).getTime() : null;
    if (scheduledAt && !Number.isFinite(parsedSchedule)) throw new Error('Invalid scheduled time');
    const item = { id: randomUUID(), url, fileName: path.basename(target), directory: folder, target,
      status: 'queued', createdAt: now(), scheduledAt: parsedSchedule ? new Date(parsedSchedule).toISOString() : null,
      total: null, downloaded: 0, speed: 0, error: null, validator: null, parts: null };
    this.items.unshift(item);
    await this.persist(); this.publish(); this.pump();
    return item.id;
  }
  async uniqueTarget(folder, name) {
    await fsp.mkdir(folder, { recursive: true });
    const ext = path.extname(name), stem = path.basename(name, ext);
    for (let n = 0; n < 10000; n++) {
      const candidate = path.join(folder, n ? `${stem} (${n})${ext}` : name);
      if (this.items.some(i => i.target === candidate)) continue;
      try { await fsp.access(candidate); } catch (e) { if (e.code === 'ENOENT') return candidate; throw e; }
    }
    throw new Error('Cannot find an available destination filename');
  }
  async updateSettings(settings) {
    const n = Number(settings.concurrency), s = Number(settings.segments);
    if (!Number.isInteger(n) || n < 1 || n > 8 || !Number.isInteger(s) || s < 1 || s > 8)
      throw new Error('Concurrency and segments must be between 1 and 8');
    this.settings = { concurrency: n, segments: s };
    await this.persist(); this.publish(); this.pump();
  }
  async pause(id) {
    const item = this.get(id);
    if (item.status === 'completed') return;
    item.status = 'paused'; item.speed = 0;
    this.active.get(id)?.abort();
    await this.persist(); this.publish();
  }
  async resume(id) {
    const item = this.get(id);
    if (item.status === 'completed') return;
    item.status = 'queued'; item.error = null; item.scheduledAt = null;
    await this.persist(); this.publish(); this.pump();
  }
  async remove(id) {
    const item = this.get(id);
    this.active.get(id)?.abort();
    this.items = this.items.filter(i => i.id !== id);
    await this.persist(); this.publish(); this.pump();
    // Do not delete partial files while an in-flight stream might still be writing.
    // They can be cleaned up manually; never delete the user's completed file.
  }
  get(id) { const item = this.items.find(i => i.id === id); if (!item) throw new Error('Download not found'); return item; }
  pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const item of this.items.slice().reverse()) {
        if (this.active.size >= this.settings.concurrency) break;
        if (item.status !== 'queued' || this.active.has(item.id)) continue;
        if (item.scheduledAt && Date.parse(item.scheduledAt) > Date.now()) continue;
        const ctl = new AbortController();
        this.active.set(item.id, ctl);
        item.status = 'downloading'; item.error = null;
        this.persist().catch(e => this.emit('error', e));
        this.publish();
        this.run(item, ctl.signal).then(async () => {
          if (item.status === 'downloading') { item.status = 'completed'; item.speed = 0; item.downloaded = item.total ?? item.downloaded; }
        }).catch(async e => {
          if (item.status === 'downloading') { item.status = 'error'; item.speed = 0; item.error = e.message; }
        }).finally(() => {
          this.active.delete(item.id);
          this.persist().catch(e => this.emit('error', e));
          this.publish(); this.pump();
        });
      }
    } finally { this.pumping = false; }
  }
  async run(item, signal) {
    const meta = await probe(item.url, signal);
    if (signal.aborted) return;
    // Previously persisted parts belong to one particular remote representation.
    // A different known size or a missing/mismatched validator is not safe to resume.
    if (item.parts && (
      (item.total != null && meta.total != null && item.total !== meta.total) ||
      (item.validator && item.validator !== meta.validator)
    )) throw new Error('Remote file changed. Remove this task and add the new file.');
    item.validator = meta.validator;
    if (meta.total != null) item.total = meta.total;
    const canSplit = meta.ranges && meta.total !== null && meta.total >= PART_MIN;
    if (!item.parts) {
      const count = canSplit ? Math.min(this.settings.segments, Math.floor(meta.total / PART_MIN)) : 1;
      item.parts = Array.from({length: count}, (_, index) => ({
        start: count === 1 ? 0 : Math.floor(meta.total * index / count),
        end: count === 1 ? (meta.total == null ? null : meta.total - 1) : Math.floor(meta.total * (index + 1) / count) - 1,
        index
      }));
      await this.persist();
    }
    if (item.parts.length > 1 && (!meta.ranges || meta.total !== item.total))
      throw new Error('Server no longer supports reliable range downloads.');
    // Disk is authoritative after crashes, aborted writes and retries; never trust a stale counter.
    item.downloaded = (await Promise.all(item.parts.map((_, i) =>
      fsp.stat(this.partPath(item, i)).then(stat => stat.size, () => 0)))).reduce((a, b) => a + b, 0);
    const controllers = item.parts.map(() => new AbortController());
    const stop = () => controllers.forEach(c => c.abort());
    signal.addEventListener('abort', stop, {once: true});
    let last = Date.now(), lastBytes = item.downloaded;
    const progress = () => {
      const t = Date.now();
      if (t - last >= 400) {
        item.speed = Math.max(0, Math.round((item.downloaded - lastBytes) * 1000 / (t - last)));
        last = t; lastBytes = item.downloaded; this.publish();
      }
    };
    try {
      await Promise.all(item.parts.map(async (part, index) => {
        const dest = this.partPath(item, index);
        let existing = (await fsp.stat(dest).catch(() => ({size:0}))).size;
        const expected = part.end == null ? null : part.end - part.start + 1;
        if (expected != null && existing > expected) throw new Error('Damaged partial download');
        // Without HTTP byte ranges, partial data cannot be resumed safely.
        if (!meta.ranges && existing) { await fsp.truncate(dest, 0); existing = 0; }
        if (expected != null && existing === expected) return;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (signal.aborted) return;
          try {
            await this.transfer(item, part, index, dest, existing, meta.ranges, controllers[index].signal, progress);
            return;
          } catch(e) {
            if (signal.aborted || controllers[index].signal.aborted) throw e;
            existing = (await fsp.stat(dest).catch(() => ({size:0}))).size;
            if (attempt === 2 || !meta.ranges) throw e;
            await sleep(300 * (attempt + 1));
          }
        }
      })).catch(e => { stop(); throw e; });
      if (signal.aborted || item.status !== 'downloading') return;
      await this.assemble(item);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  partPath(item, index) { return path.join(item.directory, `.ywd-${item.id}-${index}.part`); }
  async transfer(item, part, index, dest, existing, ranges, signal, progress) {
    const start = part.start + existing;
    const headers = {};
    const needsRange = ranges && (part.end != null || start > 0);
    if (needsRange) headers.Range = `bytes=${start}-${part.end == null ? '' : part.end}`;
    if (needsRange && item.validator) headers['If-Range'] = item.validator;
    const { res } = await request(item.url, { headers, signal });
    const expectedCode = needsRange ? 206 : 200;
    if (res.statusCode !== expectedCode) {
      res.resume(); throw new Error(`Unexpected HTTP ${res.statusCode} (expected ${expectedCode})`);
    }
    if (needsRange) {
      const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(res.headers['content-range'] || '');
      if (!m || Number(m[1]) !== start || (part.end != null && Number(m[2]) !== part.end)) {
        res.destroy(); throw new Error('Server returned an invalid Content-Range');
      }
    }
    const stream = fs.createWriteStream(dest, { flags: existing ? 'a' : 'w' });
    let written = 0;
    res.on('data', chunk => { written += chunk.length; item.downloaded += chunk.length; progress(); });
    try { await pipeline(res, stream, { signal }); }
    catch(e) { throw e; }
    const final = (await fsp.stat(dest)).size;
    const expected = part.end == null ? null : part.end - part.start + 1;
    if (expected != null && final !== expected) throw new Error(`Incomplete segment ${index + 1}`);
    if (!written && !existing && (item.total || 0) > 0) throw new Error('Empty download');
  }
  async assemble(item) {
    const temporary = `${item.target}.assembling-${item.id}`;
    const output = await fsp.open(temporary, 'w');
    try {
      for (let index = 0; index < item.parts.length; index++) {
        const part = this.partPath(item, index);
        for await (const chunk of fs.createReadStream(part)) await output.write(chunk);
      }
      await output.sync();
    } finally { await output.close(); }
    if (item.total != null && (await fsp.stat(temporary)).size !== item.total)
      throw new Error('Size verification failed; partial files retained for recovery');
    // Avoid overwriting a pre-existing user file if a file appeared during downloading.
    // Recheck at the moment of finalization; never overwrite another user's file.
    const finalTarget = await fsp.access(item.target).then(() => this.uniqueTarget(item.directory, item.fileName), e => { if (e.code === 'ENOENT') return item.target; throw e; });
    await fsp.rename(temporary, finalTarget);
    item.target = finalTarget; item.fileName = path.basename(finalTarget);
    await Promise.all(item.parts.map((_, i) => fsp.unlink(this.partPath(item, i)).catch(() => {})));
  }
  async close() {
    clearInterval(this.timer);
    for (const [id, ctl] of this.active) { const i = this.items.find(x => x.id === id); if (i) i.status = 'queued'; ctl.abort(); }
    await this.persist();
  }
}
module.exports = { DownloadEngine, normalizeUrl, cleanName, fileNameFromUrl, probe };
