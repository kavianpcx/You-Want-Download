'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { DownloadEngine, normalizeUrl, cleanName } = require('../app/engine.cjs');
const content = Buffer.allocUnsafe(3_500_123);
for (let i = 0; i < content.length; i++) content[i] = i % 251;
async function fixture(t) {
  const counters = { ranges: 0, full: 0 };
  const server = createServer((req, res) => {
    const pathName = new URL(req.url, 'http://localhost').pathname;
    if (pathName === '/missing') { res.writeHead(404).end(); return; }
    const ranges = pathName !== '/no-range';
    const head = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.length), 'ETag': '"fixture-v1"' };
    if (ranges) head['Accept-Ranges'] = 'bytes';
    let payload = content, code = 200;
    const m = ranges && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]), end = m[2] ? Number(m[2]) : content.length - 1;
      if (start >= content.length || end >= content.length) { res.writeHead(416).end(); return; }
      code = 206; payload = content.subarray(start, end + 1);
      head['Content-Range'] = `bytes ${start}-${end}/${content.length}`;
      head['Content-Length'] = String(payload.length);
      counters.ranges++;
    } else if (req.method !== 'HEAD') counters.full++;
    res.writeHead(code, head);
    if (req.method === 'HEAD') res.end();
    else if (pathName === '/slow') {
      let at = 0;
      const interval = setInterval(() => {
        if (res.destroyed || res.writableEnded) { clearInterval(interval); return; }
        const part = payload.subarray(at, at + 16384);
        if (!part.length) { clearInterval(interval); res.end(); return; }
        res.write(part); at += part.length;
      }, 4);
      res.on('close', () => clearInterval(interval));
    } else res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ywd-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return { url: `http://127.0.0.1:${server.address().port}`, folder, counters };
}
async function completed(engine, id, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const item = engine.get(id);
    if (item.status === 'completed') return item;
    if (item.status === 'error') throw Error(item.error);
    await new Promise(r => setTimeout(r, 30));
  }
  throw Error('Download timed out');
}
test('normalization rejects unsafe schemes and sanitizes filenames', () => {
  assert.throws(() => normalizeUrl('file:///etc/passwd'));
  assert.throws(() => normalizeUrl('javascript:alert(1)'));
  assert.equal(cleanName('evil/../a:?.zip'), 'evil_.._a__.zip');
});
test('parallel segmented download creates exact file and cleans parts', async t => {
  const { url, folder, counters } = await fixture(t);
  const e = new DownloadEngine({ stateFile: path.join(folder, 'state.json'), downloadDir: folder });
  await e.init(); t.after(() => e.close());
  const id = await e.add({ url: url + '/fast', fileName:'parallel.zip' });
  const item = await completed(e, id);
  assert.deepEqual(await fs.readFile(item.target), content);
  assert.ok(counters.ranges >= 2, 'multiple range requests were made');
  assert.equal((await fs.readdir(folder)).filter(x => x.endsWith('.part')).length,0);
  assert.equal(item.total, content.length);
});
test('no range support uses safe one-stream fallback', async t => {
  const { url, folder, counters } = await fixture(t);
  const e = new DownloadEngine({ stateFile: path.join(folder,'state.json'), downloadDir:folder });
  await e.init(); t.after(() => e.close());
  const item = await completed(e, await e.add({url:url+'/no-range'}));
  assert.deepEqual(await fs.readFile(item.target),content);
  assert.equal(counters.ranges,0); assert.equal(counters.full,1);
});
test('pause, persist, restart and resume without losing bytes', async t => {
  const { url, folder } = await fixture(t);
  const stateFile = path.join(folder,'state.json');
  const a = new DownloadEngine({ stateFile, downloadDir: folder, segments: 1 });
  await a.init();
  const id = await a.add({url:url+'/slow', fileName:'recover.bin'});
  const until = Date.now()+5000;
  while ((a.get(id).downloaded || 0) < 80_000 && Date.now() < until) await new Promise(r=>setTimeout(r,25));
  assert.ok(a.get(id).downloaded > 0);
  await a.pause(id);
  await new Promise(r=>setTimeout(r,100));
  await a.close();
  const b = new DownloadEngine({stateFile,downloadDir:folder,segments:1});
  await b.init(); t.after(() => b.close());
  assert.equal(b.get(id).status,'paused');
  await b.resume(id);
  const item = await completed(b,id);
  assert.deepEqual(await fs.readFile(item.target), content);
});
test('invalid resource fails with status error, not a completed file', async t => {
  const {url,folder} = await fixture(t);
  const e = new DownloadEngine({stateFile:path.join(folder,'state.json'),downloadDir:folder});
  await e.init(); t.after(() => e.close());
  const id = await e.add({url:url+'/missing'});
  const until = Date.now()+3000;
  while (e.get(id).status !== 'error' && Date.now()<until) await new Promise(r=>setTimeout(r,20));
  assert.equal(e.get(id).status,'error');
  assert.match(e.get(id).error,/404/);
});
