'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Minimal .env loader (no dependency). Real environment variables win.
function loadDotEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) { /* no .env file is fine */ }
}

const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

function loadConfig(overrides = {}) {
  const e = process.env;
  const cfg = {
    port: num(e.PORT, 3000),
    host: e.HOST || '0.0.0.0',
    tmpDir: e.TMP_DIR || path.join(os.tmpdir(), 'enhance-ai'),
    trustProxy: num(e.TRUST_PROXY, 0), // number of reverse proxies in front (0 = none)

    // --- AI services (secrets stay on the server) ---
    replicateToken: (e.REPLICATE_API_TOKEN || '').trim(),
    apiBase: (e.REPLICATE_API_BASE || 'https://api.replicate.com').replace(/\/$/, ''),
    imageModel: e.REPLICATE_IMAGE_MODEL || 'nightmareai/real-esrgan',
    imageVersion: (e.REPLICATE_IMAGE_VERSION || '').trim(), // empty = resolve latest at runtime
    videoEnabled: bool(e.VIDEO_ENGINE_ENABLED, false),
    videoToken: (e.REPLICATE_VIDEO_API_TOKEN || e.REPLICATE_API_TOKEN || '').trim(),
    videoModel: e.REPLICATE_VIDEO_MODEL || 'topazlabs/video-upscale',
    videoVersion: (e.REPLICATE_VIDEO_VERSION || '').trim(),
    allowedResultHosts: (e.ALLOWED_RESULT_HOSTS || 'replicate.delivery').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    allowInsecureResultHosts: false, // only ever enabled by tests

    accessCode: (e.ACCESS_CODE || '').trim(), // optional: protects your credit on a public site

    // --- Limits ---
    maxImageMB: num(e.MAX_IMAGE_MB, 10),
    maxVideoMB: num(e.MAX_VIDEO_MB, 50),
    maxImagePixels: num(e.MAX_IMAGE_PIXELS, 2500000),
    maxVideoSecondsExclusive: num(e.MAX_VIDEO_SECONDS, 10),
    maxVideoShortSide: num(e.MAX_VIDEO_SHORT_SIDE, 1080),
    maxOutputMB: num(e.MAX_OUTPUT_MB, 300),
    imageTimeoutSec: num(e.IMAGE_TIMEOUT_SEC, 180),
    videoTimeoutSec: num(e.VIDEO_TIMEOUT_SEC, 900),
    pollIntervalMs: num(e.POLL_INTERVAL_MS, 2000),
    rateLimitPerHour: num(e.RATE_LIMIT_PER_HOUR, 20),
    apiRateLimitPerMinute: num(e.API_RATE_LIMIT_PER_MINUTE, 240),
    maxConcurrentPerIp: num(e.MAX_CONCURRENT_PER_IP, 1),
    maxConcurrentJobs: num(e.MAX_CONCURRENT_JOBS, 3),
    dailyJobCap: num(e.DAILY_JOB_CAP, 200),
    fileTtlMinutes: num(e.FILE_TTL_MINUTES, 30),

    ffprobePath: e.FFPROBE_PATH || 'ffprobe',
    ffmpegPath: e.FFMPEG_PATH || 'ffmpeg',
    publicDir: path.join(__dirname, '..', 'public'),
  };
  return Object.assign(cfg, overrides);
}

module.exports = { loadConfig, loadDotEnv };
