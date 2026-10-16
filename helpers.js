'use strict';
// Shared test helpers. The "mock Replicate" server is LOCAL: it exercises our server pipeline
// (upload, polling, error handling, download, verification). It is NOT the real AI model.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp } = require('../server/app');
const { loadConfig } = require('../server/config');

const FIX = path.join(os.tmpdir(), 'enhance-ai-fixtures');
const TEST_TOKEN = 'r8_TESTSECRETTOKEN1234567890abcdef';

function ff(args) { execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' }); }

function makeFixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  const f = (n) => path.join(FIX, n);
  const out = {};
  const src = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=24'];
  const still = (name, extra = []) => { if (!fs.existsSync(f(name))) ff([...src, '-frames:v', '1', ...extra, f(name)]); out[name] = f(name); };
  still('ok.png'); still('ok.jpg', ['-q:v', '3']); still('ok.webp');
  const vid = (name, secs, extra = []) => { if (!fs.existsSync(f(name))) ff([...src, '-t', String(secs), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', ...extra, f(name)]); out[name] = f(name); };
  vid('v3.mp4', 3); vid('v9.mp4', 9.5); vid('v10.mp4', 10); vid('v12.mp4', 12);
  vid('v3fast.mp4', 3, ['-movflags', '+faststart']);
  if (!fs.existsSync(f('v3.webm'))) ff([...src, '-t', '2', '-c:v', 'libvpx', '-b:v', '200k', f('v3.webm')]);
  out['v3.webm'] = f('v3.webm');
  // fakes and corruptions
  fs.writeFileSync(f('fake.png'), 'this is plain text pretending to be a png');
  out['fake.png'] = f('fake.png');
  fs.writeFileSync(f('empty.png'), Buffer.alloc(0)); out['empty.png'] = f('empty.png');
  if (!fs.existsSync(f('ok.gif'))) ff([...src, '-frames:v', '1', f('ok.gif')]);
  out['ok.gif'] = f('ok.gif');
  const png = fs.readFileSync(out['ok.png']);
  fs.writeFileSync(f('trunc.png'), png.subarray(0, Math.floor(png.length / 2))); out['trunc.png'] = f('trunc.png');
  const jpg = fs.readFileSync(out['ok.jpg']);
  fs.writeFileSync(f('trunc.jpg'), jpg.subarray(0, Math.floor(jpg.length / 2))); out['trunc.jpg'] = f('trunc.jpg');
  const mp4 = fs.readFileSync(out['v3fast.mp4']);
  fs.writeFileSync(f('trunc.mp4'), mp4.subarray(0, Math.floor(mp4.length * 0.5))); out['trunc.mp4'] = f('trunc.mp4');
  const rnd = Buffer.alloc(5000); for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 7919 + 13) & 255;
  fs.writeFileSync(f('garbage.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16), rnd])); out['garbage.mp4'] = f('garbage.mp4');
  fs.writeFileSync(f('text.mp4'), 'not a video at all'); out['text.mp4'] = f('text.mp4');
  // image wearing an .mp4 name
  fs.copyFileSync(out['ok.png'], f('png-as.mp4')); out['png-as.mp4'] = f('png-as.mp4');
  // a real PNG wearing a .txt-like declared name is handled in tests via headers
  return out;
}

/** Local stand-in for api.replicate.com + replicate.delivery. behavior = { mode, ... } */
function startMockReplicate() {
  const state = { mode: 'success', calls: [], predictions: new Map(), files: new Map(), polls: 3, delivered: 0, lastInput: null, evilUrl: null };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    state.calls.push(`${req.method} ${url.pathname}`);
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const auth = req.headers.authorization || '';
    if (url.pathname.startsWith('/v1/')) state.lastAuth = auth;
    if (url.pathname.startsWith('/v1/') && state.mode === 'auth401') return json(401, { detail: 'Invalid token' });
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.method === 'GET' && url.pathname === '/v1/models/nightmareai/real-esrgan') return json(200, { latest_version: { id: 'mockversion123' } });
    if (req.method === 'POST' && url.pathname === '/v1/files') {
      const b = /boundary=(.+)$/.exec(req.headers['content-type'] || '')[1];
      const start = body.indexOf('\r\n\r\n') + 4;
      const end = body.lastIndexOf(Buffer.from(`\r\n--${b}`));
      const id = String(state.files.size + 1);
      state.files.set(id, body.subarray(start, end));
      return json(201, { urls: { get: `${base}/files/${id}` } });
    }
    const create = req.method === 'POST' && (url.pathname === '/v1/predictions' || /^\/v1\/models\/[^/]+\/[^/]+\/predictions$/.test(url.pathname));
    if (create) {
      if (state.mode === 'billing402') return json(402, { detail: 'Insufficient credit' });
      if (state.mode === 'rate429') return json(429, { detail: 'Throttled' });
      if (state.mode === 'invalid422') return json(422, { detail: 'Input invalid: image' });
      if (state.mode === 'server500') return json(500, { detail: 'boom' });
      const reqBody = JSON.parse(body.toString());
      state.lastInput = reqBody.input; state.lastCreatePath = url.pathname; state.lastVersion = reqBody.version;
      const id = 'pred' + (state.predictions.size + 1);
      state.predictions.set(id, { n: 0, input: reqBody.input, cancelled: false });
      return json(201, { id, status: 'starting', urls: {} });
    }
    const m = /^\/v1\/predictions\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m) {
      const p = state.predictions.get(m[1]);
      if (!p) return json(404, { detail: 'nope' });
      if (m[2]) { p.cancelled = true; return json(200, { id: m[1], status: 'canceled' }); }
      p.n++;
      if (state.mode === 'hang') return json(200, { id: m[1], status: 'processing' });
      if (p.n < state.polls) return json(200, { id: m[1], status: p.n === 1 ? 'starting' : 'processing' });
      if (state.mode === 'modelfail') return json(200, { id: m[1], status: 'failed', error: 'CUDA out of memory' });
      let output = `${base}/delivery/${m[1]}`;
      if (state.mode === 'evilhost') output = state.evilUrl || 'http://169.254.169.254/latest/meta-data';
      if (state.mode === 'nooutput') output = null;
      if (state.mode === 'arrayoutput') output = [output];
      return json(200, { id: m[1], status: 'succeeded', output });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/delivery/')) {
      state.delivered++;
      const p = state.predictions.get(url.pathname.split('/')[2]);
      if (state.mode === 'badoutput') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end('definitely not an image'); }
      const inUrl = p.input.image || p.input.video;
      const data = state.files.get(inUrl.split('/').pop());
      const isVideo = !!p.input.video;
      const tmpIn = path.join(os.tmpdir(), `mock-in-${Date.now()}-${Math.random().toString(16).slice(2)}${isVideo ? '.mp4' : '.img'}`);
      const tmpOut = tmpIn + (isVideo ? '.out.mp4' : '.out.png');
      fs.writeFileSync(tmpIn, data);
      try {
        if (isVideo) {
          const h = { '720p': 720, '1080p': 1080, '4k': 2160 }[p.input.target_resolution];
          ff(['-i', tmpIn, '-vf', `scale=-2:${h}`, '-r', String(p.input.target_fps), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', tmpOut]);
        } else {
          const s = p.input.scale;
          ff(['-i', tmpIn, '-vf', `scale=iw*${s}:ih*${s}:flags=lanczos`, tmpOut]);
        }
        const out = fs.readFileSync(tmpOut);
        res.writeHead(200, { 'Content-Type': isVideo ? 'video/mp4' : 'image/png', 'Content-Length': out.length });
        res.end(out);
      } finally { fs.rmSync(tmpIn, { force: true }); fs.rmSync(tmpOut, { force: true }); }
      return;
    }
    json(404, { detail: 'mock: unknown route ' + url.pathname });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

async function startApp(overrides = {}, mock) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enhance-ai-test-'));
  const cfg = loadConfig({
    tmpDir, replicateToken: TEST_TOKEN, videoToken: TEST_TOKEN, videoEnabled: true,
    apiBase: mock ? mock.url : 'http://127.0.0.1:1', allowedResultHosts: ['127.0.0.1'], allowInsecureResultHosts: true,
    pollIntervalMs: 40, rateLimitPerHour: 1000, apiRateLimitPerMinute: 100000, imageTimeoutSec: 20, videoTimeoutSec: 60,
    maxConcurrentPerIp: 2, maxConcurrentJobs: 5, ...overrides,
  });
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, cfg, base, tmpDir, close: () => new Promise((r) => { app.server.close(r); app.server.closeAllConnections && app.server.closeAllConnections(); }) };
}

async function upload(base, query, file, { name, type } = {}) {
  const buf = typeof file === 'string' ? fs.readFileSync(file) : file;
  const res = await fetch(`${base}/api/jobs?${query}`, {
    method: 'POST', body: buf,
    headers: { 'Content-Type': type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name || (typeof file === 'string' ? path.basename(file) : 'upload')) },
  });
  let body = null; try { body = await res.json(); } catch (_) { /* */ }
  return { status: res.status, body };
}

async function waitJob(base, id, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (r.job.status !== 'running') return r.job;
    if (Date.now() > end) throw new Error('waitJob timeout');
    await new Promise((s) => setTimeout(s, 60));
  }
}

module.exports = { makeFixtures, startMockReplicate, startApp, upload, waitJob, TEST_TOKEN, FIX };
