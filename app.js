'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { AppError } = require('./errors');
const { JobManager, RES_HEIGHT } = require('./jobs');
const V = require('./validate');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function createLimiter(max, windowMs) {
  const hits = new Map();
  const t = setInterval(() => { const now = Date.now(); for (const [k, a] of hits) { if (!a.length || now - a[a.length - 1] > windowMs) hits.delete(k); } }, windowMs).unref();
  return {
    take(key) {
      const now = Date.now();
      const a = (hits.get(key) || []).filter((x) => now - x < windowMs);
      if (a.length >= max) { hits.set(key, a); return false; }
      a.push(now); hits.set(key, a); return true;
    },
    stop() { clearInterval(t); },
  };
}

function createApp(cfg, deps = {}) {
  const jobs = deps.jobs || new JobManager(cfg);
  jobs.purgeAll();
  const attemptLimiter = createLimiter(cfg.rateLimitPerHour, 60 * 60 * 1000);
  const apiLimiter = createLimiter(cfg.apiRateLimitPerMinute, 60 * 1000);
  let toolsOk = null;

  const imageAvailable = () => !!cfg.replicateToken;
  async function videoStatus() {
    if (!cfg.videoEnabled || !cfg.videoToken) return { available: false, reason: 'NOT_CONFIGURED_VIDEO' };
    if (toolsOk === null) toolsOk = await V.videoToolsAvailable(cfg);
    if (!toolsOk) return { available: false, reason: 'VIDEO_TOOLS_MISSING' };
    return { available: true };
  }

  function clientIp(req) {
    const sock = req.socket.remoteAddress || 'unknown';
    if (cfg.trustProxy > 0) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      const idx = xff.length - cfg.trustProxy;
      if (idx >= 0) return xff[idx];
    }
    return sock;
  }

  function sendJson(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(body);
  }
  function sendError(req, res, e, bodyUnread) {
    const err = e instanceof AppError ? e : new AppError('INTERNAL');
    if (!(e instanceof AppError)) console.error('unexpected error:', e && e.message);
    const extra = bodyUnread ? { Connection: 'close' } : {};
    sendJson(res, err.status, { error: err.toJSON() }, extra);
    if (bodyUnread) res.on('finish', () => { setTimeout(() => req.destroy(), 50); });
  }

  async function receiveUpload(req, maxBytes) {
    const file = path.join(cfg.tmpDir, 'uploads', crypto.randomBytes(12).toString('hex') + '.part');
    const hash = crypto.createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new AppError('FILE_TOO_LARGE'));
        hash.update(chunk); cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(file));
    } catch (e) {
      await fs.promises.rm(file, { force: true });
      if (e instanceof AppError) throw e;
      throw new AppError('INTERNAL');
    }
    return { file, size, sha256: hash.digest('hex') };
  }

  async function handleCreate(req, res, url) {
    const ip = clientIp(req);
    if (!attemptLimiter.take(ip)) throw Object.assign(new AppError('RATE_LIMITED'), { unread: true });
    if (cfg.accessCode) {
      const a = crypto.createHash('sha256').update(String(req.headers['x-access-code'] || '')).digest();
      const b = crypto.createHash('sha256').update(cfg.accessCode).digest();
      if (!crypto.timingSafeEqual(a, b)) throw Object.assign(new AppError('ACCESS_DENIED'), { unread: true });
    }
    const q = url.searchParams;
    const type = q.get('type');
    if (type !== 'image' && type !== 'video') throw Object.assign(new AppError('INVALID_PARAMS', 'type'), { unread: true });

    // Refuse early (and honestly) when the engine is not configured: never fake success.
    let params;
    if (type === 'image') {
      if (!imageAvailable()) throw Object.assign(new AppError('NOT_CONFIGURED_IMAGE'), { unread: true });
      const scale = Number(q.get('scale') || 4);
      if (scale !== 2 && scale !== 4) throw Object.assign(new AppError('INVALID_PARAMS', 'scale must be 2 or 4'), { unread: true });
      params = { scale, faceEnhance: q.get('face_enhance') === '1' };
    } else {
      const st = await videoStatus();
      if (!st.available) throw Object.assign(new AppError(st.reason), { unread: true });
      const resolution = q.get('resolution') || '1080p';
      if (!RES_HEIGHT[resolution]) throw Object.assign(new AppError('INVALID_PARAMS', 'resolution'), { unread: true });
      params = { resolution };
    }

    const maxBytes = (type === 'image' ? cfg.maxImageMB : cfg.maxVideoMB) * 1024 * 1024;
    const declared = Number(req.headers['content-length']);
    if (declared && declared > maxBytes) throw Object.assign(new AppError('FILE_TOO_LARGE'), { unread: true });

    const slot = jobs.reserve(ip);
    let handedOff = false;
    let upload;
    try {
      upload = await receiveUpload(req, maxBytes);
      let originalName = 'file';
      try { originalName = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch (_) { /* keep default */ }

      let info;
      if (type === 'image') {
        info = await V.inspectImage(upload.file);
        if (info.width * info.height > cfg.maxImagePixels) throw new AppError('IMAGE_TOO_LARGE_DIMS');
      } else {
        info = await V.inspectVideoUpload(cfg, upload.file);
        const need = RES_HEIGHT[params.resolution];
        if (Math.min(info.width, info.height) >= need) throw new AppError('RESOLUTION_NOT_HIGHER');
        // Keep the source frame rate (Topaz would otherwise default to 30 fps).
        params.fps = Math.max(15, Math.min(60, Math.round(info.fps || 30)));
      }

      const key = jobs.dedupeKey(upload.sha256, type, params);
      const dup = jobs.findDuplicate(key);
      if (dup) {
        await fs.promises.rm(upload.file, { force: true });
        slot.release(); handedOff = true;
        return sendJson(res, 200, { duplicate: true, job: jobs.view(dup) });
      }

      const original = { name: originalName, size: upload.size, mime: info.mime, ext: info.ext, width: info.width, height: info.height, duration: info.duration, fps: info.fps };
      const job = jobs.create({ type, params, key, original, uploadPath: upload.file, slot });
      handedOff = true;
      return sendJson(res, 202, { duplicate: false, job: jobs.view(job) });
    } catch (e) {
      if (upload) await fs.promises.rm(upload.file, { force: true });
      throw e;
    } finally {
      if (!handedOff) slot.release();
    }
  }

  function serveResult(req, res, job, url) {
    if (job.status !== 'succeeded' || !job.result) throw new AppError(job.status === 'running' ? 'NOT_READY' : 'NOT_FOUND');
    const r = job.result;
    let stat;
    try { stat = fs.statSync(r.path); } catch (_) { throw new AppError('NOT_FOUND'); }
    const headers = {
      'Content-Type': r.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${r.filename}"`,
    };
    let start = 0; let end = stat.size - 1; let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      if (range[1] === '') { start = Math.max(0, stat.size - Number(range[2])); }
      else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(r.path, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const full = path.normalize(path.join(cfg.publicDir, rel));
    if (!full.startsWith(cfg.publicDir + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found');
    }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400); return res.end(); }
    const p = url.pathname;
    let bodyUnread = false;
    try {
      if (p.startsWith('/api/')) {
        if (!apiLimiter.take(clientIp(req))) throw Object.assign(new AppError('RATE_LIMITED'), { unread: req.method === 'POST' });
        if (p === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });
        if (p === '/api/config' && req.method === 'GET') {
          const vs = await videoStatus();
          return sendJson(res, 200, {
            image: { available: imageAvailable(), reason: imageAvailable() ? null : 'NOT_CONFIGURED_IMAGE', scales: [2, 4], faceEnhance: true, formats: ['JPG', 'PNG', 'WebP'], maxMB: cfg.maxImageMB, maxPixels: cfg.maxImagePixels },
            video: { available: vs.available, reason: vs.reason || null, resolutions: Object.keys(RES_HEIGHT), formats: ['MP4'], maxMB: cfg.maxVideoMB, maxSecondsExclusive: cfg.maxVideoSecondsExclusive, maxShortSide: cfg.maxVideoShortSide },
            retentionMinutes: cfg.fileTtlMinutes,
            accessCodeRequired: !!cfg.accessCode,
          });
        }
        if (p === '/api/jobs' && req.method === 'POST') {
          try { return await handleCreate(req, res, url); }
          catch (e) { bodyUnread = !!e.unread; throw e; }
        }
        const m = /^\/api\/jobs\/([a-f0-9]{32})(\/result)?$/.exec(p);
        if (m) {
          const job = jobs.get(m[1]);
          if (!job) throw new AppError('NOT_FOUND');
          if (m[2] && (req.method === 'GET' || req.method === 'HEAD')) return serveResult(req, res, job, url);
          if (!m[2] && req.method === 'GET') return sendJson(res, 200, { job: jobs.view(job) });
          if (!m[2] && req.method === 'DELETE') {
            if (job.status === 'running') throw new AppError('BUSY');
            await jobs.deleteJob(job);
            return sendJson(res, 200, { deleted: true });
          }
        }
        throw new AppError('NOT_FOUND');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, p);
    } catch (e) {
      if (!res.headersSent) sendError(req, res, e, bodyUnread || (e && e.unread));
      else res.destroy();
    }
  });
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.on('close', () => { jobs.stop(); attemptLimiter.stop(); apiLimiter.stop(); });
  return { server, jobs };
}

module.exports = { createApp };
