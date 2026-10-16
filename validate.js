'use strict';
const fs = require('fs');
const { execFile } = require('child_process');
const { AppError } = require('./errors');

async function readHead(file, n) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}
async function readTail(file, n) {
  const st = await fs.promises.stat(file);
  const fh = await fs.promises.open(file, 'r');
  try {
    const len = Math.min(n, st.size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, st.size - len);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

// ---- Image sniffing by real bytes (never by file name or declared MIME) ----
function sniffImageKind(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const IMAGE_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

function jpegDims(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    let marker = buf[i + 1];
    while (marker === 0xff) { i++; marker = buf[i + 1]; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
function webpDims(buf) {
  const type = buf.toString('latin1', 12, 16);
  if (type === 'VP8X' && buf.length >= 30) {
    return { animated: !!(buf[20] & 0x02), width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (type === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (type === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** Validates an image file on disk. Returns {kind, mime, ext, width, height}. */
async function inspectImage(file) {
  const st = await fs.promises.stat(file);
  if (st.size === 0) throw new AppError('EMPTY_FILE');
  const head = await readHead(file, Math.min(st.size, 4 * 1024 * 1024));
  const kind = sniffImageKind(head);
  if (!kind) throw new AppError('UNSUPPORTED_TYPE');
  let dims = null;
  let tail = null;
  if (kind === 'png') {
    if (head.length >= 24 && head.toString('latin1', 12, 16) === 'IHDR') dims = { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    tail = await readTail(file, 4096);
    if (!tail.includes(Buffer.from('IEND'))) throw new AppError('CORRUPT_FILE'); // truncated PNG
  } else if (kind === 'jpeg') {
    dims = jpegDims(head);
    tail = await readTail(file, 4096);
    if (tail.indexOf(Buffer.from([0xff, 0xd9])) === -1) throw new AppError('CORRUPT_FILE'); // truncated JPEG (no EOI marker near the end)
  } else {
    const declared = head.readUInt32LE(4) + 8;
    if (declared > st.size + 1) throw new AppError('CORRUPT_FILE'); // truncated WebP
    dims = webpDims(head);
    if (dims && dims.animated) throw new AppError('ANIMATED_IMAGE');
  }
  if (!dims || !dims.width || !dims.height) throw new AppError('CORRUPT_FILE');
  return { kind, mime: IMAGE_MIME[kind], ext: IMAGE_EXT[kind], width: dims.width, height: dims.height, size: st.size };
}

// ---- Video via ffprobe/ffmpeg ----
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
let toolsCache = null;
async function videoToolsAvailable(cfg) {
  if (toolsCache && toolsCache.key === cfg.ffprobePath + cfg.ffmpegPath) return toolsCache.value;
  const a = await run(cfg.ffprobePath, ['-version'], 5000);
  const b = await run(cfg.ffmpegPath, ['-version'], 5000);
  const value = !a.err && !b.err;
  toolsCache = { key: cfg.ffprobePath + cfg.ffmpegPath, value };
  return value;
}
function fpsOf(s) {
  const parse = (r) => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : 0; };
  const f = parse(s.avg_frame_rate) || parse(s.r_frame_rate);
  return Number.isFinite(f) && f > 0 ? f : 0;
}

/** Probes a video file's real properties. Throws AppError if not a valid video. */
async function probeVideo(cfg, file) {
  const r = await run(cfg.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 20000);
  if (r.err && r.err.code === 'ENOENT') throw new AppError('VIDEO_TOOLS_MISSING');
  if (r.err) throw new AppError('CORRUPT_FILE');
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { throw new AppError('CORRUPT_FILE'); }
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.width && s.height && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new AppError('VIDEO_NO_STREAM');
  const duration = Number((j.format && j.format.duration) || v.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new AppError('CORRUPT_FILE');
  const st = await fs.promises.stat(file);
  return {
    formatName: (j.format && j.format.format_name) || '',
    codec: v.codec_name,
    width: v.width, height: v.height,
    duration, fps: fpsOf(v), size: st.size,
    hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
  };
}

/** Full decode pass to catch files whose headers are fine but whose data is corrupt. */
async function decodeCheck(cfg, file) {
  const r = await run(cfg.ffmpegPath, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], 60000);
  if (r.err && r.err.code === 'ENOENT') throw new AppError('VIDEO_TOOLS_MISSING');
  if (r.err || r.stderr.trim()) throw new AppError('CORRUPT_FILE');
}

/** Validates an MP4 upload (type, real duration, decodability). */
async function inspectVideoUpload(cfg, file) {
  const st = await fs.promises.stat(file);
  if (st.size === 0) throw new AppError('EMPTY_FILE');
  const head = await readHead(file, 12);
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') throw new AppError('UNSUPPORTED_TYPE');
  const brand = head.toString('latin1', 8, 12);
  if (/^qt/.test(brand)) throw new AppError('UNSUPPORTED_TYPE'); // QuickTime .mov is not enabled
  const info = await probeVideo(cfg, file);
  if (!/mp4/.test(info.formatName)) throw new AppError('UNSUPPORTED_TYPE');
  if (info.duration >= cfg.maxVideoSecondsExclusive) throw new AppError('VIDEO_TOO_LONG');
  if (Math.min(info.width, info.height) > cfg.maxVideoShortSide) throw new AppError('VIDEO_TOO_LARGE_DIMS');
  await decodeCheck(cfg, file);
  return { ...info, mime: 'video/mp4', ext: 'mp4' };
}

/** Validates a result video returned by the AI service. */
async function inspectResultVideo(cfg, file) {
  const head = await readHead(file, 12);
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') throw new AppError('BAD_OUTPUT');
  let info;
  try { info = await probeVideo(cfg, file); } catch (e) { throw e.code === 'VIDEO_TOOLS_MISSING' ? e : new AppError('BAD_OUTPUT'); }
  try { await decodeCheck(cfg, file); } catch (e) { throw e.code === 'VIDEO_TOOLS_MISSING' ? e : new AppError('BAD_OUTPUT'); }
  return { ...info, mime: 'video/mp4', ext: 'mp4' };
}

async function inspectResultImage(file) {
  try { return await inspectImage(file); } catch (e) { throw new AppError('BAD_OUTPUT'); }
}

module.exports = { inspectImage, inspectVideoUpload, inspectResultVideo, inspectResultImage, videoToolsAvailable, probeVideo };
