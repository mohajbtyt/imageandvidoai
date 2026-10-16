'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');
const { ReplicateClient, pickOutputUrl } = require('./replicate');
const { inspectResultImage, inspectResultVideo } = require('./validate');

const RES_HEIGHT = { '720p': 720, '1080p': 1080, '4k': 2160 };

function safeBase(name) {
  const base = String(name || 'file').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  return (base || 'file').slice(0, 40);
}
function safeDisplayName(name) {
  return String(name || 'file').replace(/[\u0000-\u001f<>"\\/]/g, '').slice(0, 80) || 'file';
}

class JobManager {
  constructor(cfg, client) {
    this.cfg = cfg;
    this.client = client || new ReplicateClient(cfg);
    this.jobs = new Map();
    this.dedupe = new Map(); // key -> jobId
    this.ipActive = new Map();
    this.totalActive = 0;
    this.day = new Date().toISOString().slice(0, 10);
    this.dayCount = 0;
    fs.mkdirSync(path.join(cfg.tmpDir, 'uploads'), { recursive: true });
    this.timer = setInterval(() => this.sweep().catch(() => {}), 60 * 1000);
    this.timer.unref();
  }

  /** Reserves a concurrency slot for an IP. Throws BUSY when limits are hit. */
  reserve(ip) {
    const n = this.ipActive.get(ip) || 0;
    if (n >= this.cfg.maxConcurrentPerIp || this.totalActive >= this.cfg.maxConcurrentJobs) throw new AppError('BUSY');
    this.ipActive.set(ip, n + 1);
    this.totalActive++;
    let released = false;
    return { release: () => {
      if (released) return; released = true;
      const m = (this.ipActive.get(ip) || 1) - 1;
      if (m <= 0) this.ipActive.delete(ip); else this.ipActive.set(ip, m);
      this.totalActive--;
    } };
  }

  checkDailyCap() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.dayCount = 0; }
    if (this.dayCount >= this.cfg.dailyJobCap) throw new AppError('DAILY_LIMIT');
  }

  dedupeKey(hash, type, params) {
    return crypto.createHash('sha256').update(JSON.stringify([hash, type, params])).digest('hex');
  }

  findDuplicate(key) {
    const id = this.dedupe.get(key);
    const job = id && this.jobs.get(id);
    if (job && (job.status === 'running' || job.status === 'succeeded')) return job;
    return null;
  }

  create({ type, params, key, original, uploadPath, slot }) {
    this.checkDailyCap();
    this.dayCount++;
    const id = crypto.randomBytes(16).toString('hex');
    const dir = path.join(this.cfg.tmpDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const originalPath = path.join(dir, `original.${original.ext}`);
    fs.renameSync(uploadPath, originalPath);
    const job = {
      id, type, params, key, original, dir, originalPath,
      status: 'running', step: 'queued', replicateStatus: null,
      createdAt: Date.now(), finishedAt: null, result: null, error: null,
    };
    this.jobs.set(id, job);
    this.dedupe.set(key, id);
    this.run(job).catch((e) => this.fail(job, e)).finally(() => slot.release());
    return job;
  }

  fail(job, e) {
    const err = e instanceof AppError ? e : new AppError('INTERNAL');
    if (!(e instanceof AppError)) console.error(`[job ${job.id}] unexpected error:`, e && e.message);
    else console.log(`[job ${job.id}] failed: ${err.code}${err.detail ? ' - ' + err.detail : ''}`);
    job.status = 'failed';
    job.step = 'failed';
    job.error = err.toJSON();
    job.finishedAt = Date.now();
    if (this.dedupe.get(job.key) === job.id) this.dedupe.delete(job.key);
    fs.promises.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  async run(job) {
    const cfg = this.cfg;
    const isVideo = job.type === 'video';
    const token = isVideo ? cfg.videoToken : cfg.replicateToken;
    if (!token) throw new AppError(isVideo ? 'NOT_CONFIGURED_VIDEO' : 'NOT_CONFIGURED_IMAGE');

    job.step = 'uploading';
    const fileUrl = await this.client.uploadFile(token, job.originalPath, `input.${job.original.ext}`, job.original.mime);
    // The original is no longer needed on this server once the AI service has it.
    await fs.promises.rm(job.originalPath, { force: true });

    job.step = 'processing';
    let prediction;
    if (isVideo) {
      prediction = await this.client.createPrediction(token, {
        model: cfg.videoModel, version: cfg.videoVersion, useVersion: !!cfg.videoVersion,
        input: { video: fileUrl, target_resolution: job.params.resolution, target_fps: job.params.fps },
      });
    } else {
      prediction = await this.client.createPrediction(token, {
        model: cfg.imageModel, version: cfg.imageVersion, useVersion: true,
        input: { image: fileUrl, scale: job.params.scale, face_enhance: !!job.params.faceEnhance },
      });
    }
    job.predictionId = prediction.id;
    const done = await this.client.waitForPrediction(token, prediction, {
      timeoutMs: (isVideo ? cfg.videoTimeoutSec : cfg.imageTimeoutSec) * 1000,
      pollMs: cfg.pollIntervalMs,
      onStatus: (s) => { job.replicateStatus = s; },
    });

    const outUrl = pickOutputUrl(done.output);
    if (!outUrl) throw new AppError('BAD_OUTPUT', 'Model returned no output');

    job.step = 'downloading';
    const tmpOut = path.join(job.dir, 'result.download');
    await this.client.downloadResult(outUrl, tmpOut);

    job.step = 'verifying';
    const info = isVideo ? await inspectResultVideo(cfg, tmpOut) : await inspectResultImage(tmpOut);
    const resultPath = path.join(job.dir, `result.${info.ext}`);
    await fs.promises.rename(tmpOut, resultPath);
    const base = safeBase(job.original.name);
    const suffix = isVideo ? job.params.resolution : `${job.params.scale}x`;
    job.result = {
      path: resultPath, mime: info.mime, size: info.size, width: info.width, height: info.height,
      duration: isVideo ? info.duration : undefined, fps: isVideo ? info.fps : undefined,
      filename: `${base}-enhanced-${suffix}.${info.ext}`,
    };
    job.status = 'succeeded';
    job.step = 'done';
    job.finishedAt = Date.now();
    console.log(`[job ${job.id}] succeeded (${job.type})`);
  }

  get(id) { return this.jobs.get(id) || null; }

  view(job) {
    const ttl = this.cfg.fileTtlMinutes * 60 * 1000;
    const v = {
      id: job.id, type: job.type, status: job.status, step: job.step,
      replicateStatus: job.replicateStatus, createdAt: job.createdAt,
      elapsedMs: (job.finishedAt || Date.now()) - job.createdAt,
      params: job.params,
      original: job.original && {
        name: safeDisplayName(job.original.name), size: job.original.size, width: job.original.width,
        height: job.original.height, duration: job.original.duration, fps: job.original.fps, mime: job.original.mime,
      },
      error: job.error || null,
      result: null,
    };
    if (job.result && job.status === 'succeeded') {
      v.result = {
        size: job.result.size, width: job.result.width, height: job.result.height,
        duration: job.result.duration, fps: job.result.fps, mime: job.result.mime, filename: job.result.filename,
        url: `/api/jobs/${job.id}/result`, downloadUrl: `/api/jobs/${job.id}/result?download=1`,
      };
      v.expiresAt = job.finishedAt + ttl;
    }
    return v;
  }

  async deleteJob(job) {
    this.jobs.delete(job.id);
    if (this.dedupe.get(job.key) === job.id) this.dedupe.delete(job.key);
    await fs.promises.rm(job.dir, { recursive: true, force: true });
  }

  /** Deletes files of finished jobs older than the TTL and orphaned uploads. */
  async sweep(now = Date.now()) {
    const ttl = this.cfg.fileTtlMinutes * 60 * 1000;
    for (const job of [...this.jobs.values()]) {
      if (job.status === 'running') {
        // Hard stop for stuck jobs: processing timeout + generous margin.
        const max = ((job.type === 'video' ? this.cfg.videoTimeoutSec : this.cfg.imageTimeoutSec) + 600) * 1000;
        if (now - job.createdAt > max) this.fail(job, new AppError('PROCESSING_TIMEOUT'));
        continue;
      }
      if (job.finishedAt && now - job.finishedAt > ttl) await this.deleteJob(job);
    }
    const up = path.join(this.cfg.tmpDir, 'uploads');
    try {
      for (const f of await fs.promises.readdir(up)) {
        const p = path.join(up, f);
        const st = await fs.promises.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > 10 * 60 * 1000) await fs.promises.rm(p, { force: true });
      }
    } catch (_) { /* ignore */ }
  }

  /** Remove everything left over from a previous run. */
  purgeAll() {
    try { fs.rmSync(this.cfg.tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    fs.mkdirSync(path.join(this.cfg.tmpDir, 'uploads'), { recursive: true });
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { JobManager, RES_HEIGHT };
