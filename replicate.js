'use strict';
const fs = require('fs');
const { AppError } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Secrets must never leak into messages: strip anything that looks like a token.
function scrub(text, token) {
  let s = String(text == null ? '' : text);
  if (token) s = s.split(token).join('[redacted]');
  return s.replace(/r8_[A-Za-z0-9]{10,}/g, '[redacted]');
}

class ReplicateClient {
  constructor(cfg) { this.cfg = cfg; this.versionCache = new Map(); }

  async _fetch(token, url, init = {}) {
    const headers = { Authorization: `Bearer ${token}`, ...(init.headers || {}) };
    let res;
    try {
      res = await fetch(url, { ...init, headers, signal: init.signal || AbortSignal.timeout(60000) });
    } catch (e) {
      throw new AppError('UPSTREAM_UNAVAILABLE', scrub(e && e.message, token));
    }
    return res;
  }

  async _json(token, res) {
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
    if (res.ok) {
      if (body === null) throw new AppError('UPSTREAM_UNAVAILABLE', 'Invalid JSON from API');
      return body;
    }
    const detail = scrub((body && (body.detail || body.title || body.error)) || `HTTP ${res.status}`, token);
    if (res.status === 401 || res.status === 403) throw new AppError('REPLICATE_AUTH', detail);
    if (res.status === 402) throw new AppError('REPLICATE_BILLING', detail);
    if (res.status === 429) throw new AppError('REPLICATE_RATE', detail);
    if (res.status === 422 || res.status === 400) throw new AppError('REPLICATE_INVALID_INPUT', detail);
    if (res.status === 404) throw new AppError('UPSTREAM_UNAVAILABLE', `Model or resource not found (${detail})`);
    throw new AppError('UPSTREAM_UNAVAILABLE', detail);
  }

  /** Uploads a local file to Replicate's Files API and returns a URL the model can read. */
  async uploadFile(token, filePath, filename, mime) {
    const data = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.append('content', new Blob([data], { type: mime }), filename);
    const res = await this._fetch(token, `${this.cfg.apiBase}/v1/files`, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) });
    const body = await this._json(token, res);
    const url = body && body.urls && body.urls.get;
    if (!url) throw new AppError('UPSTREAM_UNAVAILABLE', 'Files API returned no URL');
    return url;
  }

  async resolveVersion(token, model, pinned) {
    if (pinned) return pinned;
    if (this.versionCache.has(model)) return this.versionCache.get(model);
    const res = await this._fetch(token, `${this.cfg.apiBase}/v1/models/${model}`);
    const body = await this._json(token, res);
    const id = body && body.latest_version && body.latest_version.id;
    if (!id) throw new AppError('UPSTREAM_UNAVAILABLE', 'Could not resolve model version');
    this.versionCache.set(model, id);
    return id;
  }

  /** kind: 'image' (community model, pinned/resolved version) | 'video' (official model or pinned version). */
  async createPrediction(token, { model, version, input, useVersion }) {
    let res;
    if (useVersion) {
      const v = await this.resolveVersion(token, model, version);
      res = await this._fetch(token, `${this.cfg.apiBase}/v1/predictions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: v, input }),
      });
    } else {
      res = await this._fetch(token, `${this.cfg.apiBase}/v1/models/${model}/predictions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }),
      });
    }
    return this._json(token, res);
  }

  async getPrediction(token, id) {
    const res = await this._fetch(token, `${this.cfg.apiBase}/v1/predictions/${encodeURIComponent(id)}`);
    return this._json(token, res);
  }

  async cancelPrediction(token, id) {
    try { await this._fetch(token, `${this.cfg.apiBase}/v1/predictions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); } catch (_) { /* best effort */ }
  }

  /**
   * Polls until the prediction finishes. onStatus(status) is called when it changes.
   * Transient polling errors are tolerated a few times; hard errors abort.
   */
  async waitForPrediction(token, prediction, { timeoutMs, pollMs, onStatus }) {
    const deadline = Date.now() + timeoutMs;
    let current = prediction;
    let transient = 0;
    let last = null;
    for (;;) {
      if (current.status !== last) { last = current.status; if (onStatus) onStatus(current.status); }
      if (current.status === 'succeeded') return current;
      if (current.status === 'failed') throw new AppError('PROCESSING_FAILED', scrub(current.error || 'Model reported failure', token));
      if (current.status === 'canceled') throw new AppError('PROCESSING_FAILED', 'Prediction was canceled');
      if (Date.now() > deadline) {
        await this.cancelPrediction(token, current.id);
        throw new AppError('PROCESSING_TIMEOUT');
      }
      await sleep(pollMs);
      try {
        current = await this.getPrediction(token, current.id);
        transient = 0;
      } catch (e) {
        const hard = ['REPLICATE_AUTH', 'REPLICATE_BILLING', 'REPLICATE_INVALID_INPUT'].includes(e.code);
        if (hard || ++transient > 5) throw e;
      }
    }
  }

  /** Checks a result URL against the host allowlist (SSRF guard). Only URLs returned by the model are ever fetched. */
  assertAllowedResultUrl(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch (_) { throw new AppError('OUTPUT_HOST_BLOCKED'); }
    const okProto = u.protocol === 'https:' || (this.cfg.allowInsecureResultHosts && u.protocol === 'http:');
    const host = u.hostname.toLowerCase();
    const okHost = this.cfg.allowedResultHosts.some((h) => host === h || host.endsWith('.' + h));
    if (!okProto || !okHost || u.username || u.password) throw new AppError('OUTPUT_HOST_BLOCKED');
    return u;
  }

  /** Downloads the result to destPath with a hard size cap. Does not follow redirects. */
  async downloadResult(urlStr, destPath) {
    const u = this.assertAllowedResultUrl(urlStr);
    let res;
    try { res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(300000) }); }
    catch (e) { throw new AppError('OUTPUT_DOWNLOAD_FAILED', scrub(e && e.message)); }
    if (!res.ok || !res.body) throw new AppError('OUTPUT_DOWNLOAD_FAILED', `HTTP ${res.status}`);
    const max = this.cfg.maxOutputMB * 1024 * 1024;
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared > max) throw new AppError('OUTPUT_DOWNLOAD_FAILED', 'Result too large');
    const out = fs.createWriteStream(destPath);
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > max) throw new AppError('OUTPUT_DOWNLOAD_FAILED', 'Result too large');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
    } catch (e) {
      out.destroy();
      await fs.promises.rm(destPath, { force: true });
      throw e instanceof AppError ? e : new AppError('OUTPUT_DOWNLOAD_FAILED', scrub(e && e.message));
    }
    return total;
  }
}

function pickOutputUrl(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0];
  if (output && typeof output === 'object' && typeof output.url === 'string') return output.url;
  return null;
}

module.exports = { ReplicateClient, pickOutputUrl, scrub };
