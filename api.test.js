'use strict';
// [MOCK-API] End-to-end tests of OUR server against a LOCAL mock of Replicate.
// They prove the pipeline (upload -> Replicate calls -> polling -> download -> verification), not the AI quality.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const { makeFixtures, startMockReplicate, startApp, upload, waitJob, TEST_TOKEN } = require('./helpers');
const V = require('../server/validate');

const fx = makeFixtures();
const ctx = {};
test.before(async () => { ctx.mock = await startMockReplicate(); });
test.after(async () => { await ctx.mock.close(); });
const fresh = async (o) => { ctx.mock.state.mode = 'success'; ctx.mock.state.calls.length = 0; return startApp(o, ctx.mock); };

test('[LOCAL] config reports unavailable engines honestly when no key is set', async () => {
  const app = await startApp({ replicateToken: '', videoToken: '', videoEnabled: false });
  try {
    const cfg = await (await fetch(app.base + '/api/config')).json();
    assert.strictEqual(cfg.image.available, false);
    assert.strictEqual(cfg.video.available, false);
    assert.strictEqual(cfg.video.reason, 'NOT_CONFIGURED_VIDEO');
  } finally { await app.close(); }
});

test('[LOCAL] no API key: image job is refused with NOT_CONFIGURED, no fake success, nothing created', async () => {
  const app = await startApp({ replicateToken: '' });
  try {
    const r = await upload(app.base, 'type=image&scale=2', fx['ok.png'], { type: 'image/png' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error.code, 'NOT_CONFIGURED_IMAGE');
    assert.ok(r.body.error.message_ar && r.body.error.message_en);
    assert.strictEqual(app.jobs.jobs.size, 0);
  } finally { await app.close(); }
});

test('[LOCAL] no video engine: video job refused with NOT_CONFIGURED_VIDEO (even if image key exists)', async () => {
  const app = await startApp({ videoEnabled: false });
  try {
    const r = await upload(app.base, 'type=video&resolution=1080p', fx['v3.mp4'], { type: 'video/mp4' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error.code, 'NOT_CONFIGURED_VIDEO');
    assert.strictEqual(app.jobs.jobs.size, 0);
  } finally { await app.close(); }
});

test('[MOCK-API] image: full pipeline, result downloadable and valid, scale respected', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    const r = await upload(app.base, 'type=image&scale=4&face_enhance=0', fx['ok.png'], { name: 'my photo.png', type: 'image/png' });
    assert.strictEqual(r.status, 202);
    const job = await waitJob(app.base, r.body.job.id);
    assert.strictEqual(job.status, 'succeeded', JSON.stringify(job.error));
    assert.strictEqual(job.original.width, 160);
    assert.strictEqual(job.result.width, 640);
    assert.strictEqual(job.result.height, 480);
    // Real model input was built correctly and the token went only to the (mock) API as a header
    assert.strictEqual(ctx.mock.state.lastInput.scale, 4);
    assert.strictEqual(ctx.mock.state.lastInput.face_enhance, false);
    assert.strictEqual(ctx.mock.state.lastVersion, 'mockversion123');
    assert.strictEqual(ctx.mock.state.lastAuth, 'Bearer ' + TEST_TOKEN);
    // download + open
    const dl = await fetch(app.base + job.result.downloadUrl);
    assert.strictEqual(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="my_photo-enhanced-4x\.png"/);
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.strictEqual(bytes.length, job.result.size);
    const tmp = app.tmpDir + '/dl.png'; fs.writeFileSync(tmp, bytes);
    const info = await V.inspectImage(tmp);
    assert.deepStrictEqual([info.width, info.height], [640, 480]);
  } finally { await app.close(); }
});

test('[MOCK-API] image: 2x with face enhance, JPEG and WebP accepted, array output handled', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    ctx.mock.state.mode = 'arrayoutput';
    for (const [n, t] of [['ok.jpg', 'image/jpeg'], ['ok.webp', 'image/webp']]) {
      const r = await upload(app.base, 'type=image&scale=2&face_enhance=1', fx[n], { type: t });
      assert.strictEqual(r.status, 202, n);
      const job = await waitJob(app.base, r.body.job.id);
      assert.strictEqual(job.status, 'succeeded', n + JSON.stringify(job.error));
      assert.strictEqual(job.result.width, 320);
      assert.strictEqual(ctx.mock.state.lastInput.face_enhance, true);
    }
  } finally { await app.close(); }
});

test('[LOCAL] unsupported / fake / corrupt / bad-param uploads are rejected and nothing is sent to the AI service', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    const cases = [
      ['type=image&scale=2', fx['fake.png'], 415, 'UNSUPPORTED_TYPE'],
      ['type=image&scale=2', fx['ok.gif'], 415, 'UNSUPPORTED_TYPE'],
      ['type=image&scale=2', fx['empty.png'], 400, 'EMPTY_FILE'],
      ['type=image&scale=2', fx['trunc.png'], 422, 'CORRUPT_FILE'],
      ['type=image&scale=3', fx['ok.png'], 400, 'INVALID_PARAMS'],
      ['type=audio', fx['ok.png'], 400, 'INVALID_PARAMS'],
    ];
    for (const [q, f, status, code] of cases) {
      const r = await upload(app.base, q, f);
      assert.strictEqual(r.status, status, q + ' ' + f);
      assert.strictEqual(r.body.error.code, code, q + ' ' + f);
    }
    assert.strictEqual(ctx.mock.state.calls.filter((c) => c.startsWith('POST')).length, 0, 'AI service must not be called');
    assert.strictEqual(app.jobs.jobs.size, 0);
  } finally { await app.close(); }
});

test('[LOCAL] oversized upload rejected (Content-Length and chunked), temp files cleaned', async () => {
  const app = await fresh({ maxImageMB: 0.0001, maxVideoMB: 0.0001 }, ctx.mock);
  try {
    const r = await upload(app.base, 'type=image&scale=2', fx['ok.png']);
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.body.error.code, 'FILE_TOO_LARGE');
    // chunked without Content-Length must be capped too
    const code = await new Promise((resolve, reject) => {
      const u = new URL(app.base + '/api/jobs?type=image&scale=2');
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      });
      req.on('error', reject);
      req.write(Buffer.alloc(4000, 1)); req.end();
    });
    assert.strictEqual(code.status, 413);
    assert.deepStrictEqual(fs.readdirSync(app.tmpDir + '/uploads'), []);
    const v = await upload(app.base, 'type=video&resolution=1080p', fx['v3.mp4']);
    assert.strictEqual(v.status, 413);
  } finally { await app.close(); }
});

test('[MOCK-API] API errors map to clear codes: 401, 402, 429, 422, 500, model failure', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    const expected = { auth401: 'REPLICATE_AUTH', billing402: 'REPLICATE_BILLING', rate429: 'REPLICATE_RATE', invalid422: 'REPLICATE_INVALID_INPUT', server500: 'UPSTREAM_UNAVAILABLE', modelfail: 'PROCESSING_FAILED' };
    for (const [mode, code] of Object.entries(expected)) {
      ctx.mock.state.mode = mode;
      const png = fs.readFileSync(fx['ok.png']);
      const r = await upload(app.base, 'type=image&scale=2', Buffer.concat([png, Buffer.alloc(1)]), { name: mode + '.png' }); // distinct bytes: avoid duplicate cache
      assert.strictEqual(r.status, 202, mode);
      const job = await waitJob(app.base, r.body.job.id);
      assert.strictEqual(job.status, 'failed', mode);
      assert.strictEqual(job.error.code, code, mode);
      assert.ok(job.error.message_ar.length > 5 && job.error.message_en.length > 5);
      assert.ok(!JSON.stringify(job).includes(TEST_TOKEN));
      // files cleaned after failure
      assert.strictEqual(fs.existsSync(app.cfg.tmpDir + '/' + job.id), false);
    }
  } finally { await app.close(); }
});

test('[MOCK-API] processing timeout cancels the prediction and fails clearly', async () => {
  const app = await fresh({ imageTimeoutSec: 1 }, ctx.mock);
  try {
    ctx.mock.state.mode = 'hang';
    const r = await upload(app.base, 'type=image&scale=2', fx['ok.png']);
    const job = await waitJob(app.base, r.body.job.id, 15000);
    assert.strictEqual(job.error.code, 'PROCESSING_TIMEOUT');
    assert.ok([...ctx.mock.state.predictions.values()].some((p) => p.cancelled), 'prediction should be cancelled');
  } finally { await app.close(); }
});

test('[MOCK-API] invalid result from the service (not an image) is NOT reported as success', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    ctx.mock.state.mode = 'badoutput';
    const r = await upload(app.base, 'type=image&scale=2', fx['ok.png']);
    const job = await waitJob(app.base, r.body.job.id);
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.error.code, 'BAD_OUTPUT');
    ctx.mock.state.mode = 'nooutput';
    const png = Buffer.concat([fs.readFileSync(fx['ok.png']), Buffer.alloc(2)]);
    const r2 = await upload(app.base, 'type=image&scale=2', png);
    assert.strictEqual((await waitJob(app.base, r2.body.job.id)).error.code, 'BAD_OUTPUT');
  } finally { await app.close(); }
});

test('[MOCK-API] duplicate requests do not create a second paid prediction', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    ctx.mock.state.polls = 6;
    const a = await upload(app.base, 'type=image&scale=2', fx['ok.png']);
    const b = await upload(app.base, 'type=image&scale=2', fx['ok.png']);
    assert.strictEqual(a.status, 202);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body.duplicate, true);
    assert.strictEqual(b.body.job.id, a.body.job.id);
    await waitJob(app.base, a.body.job.id);
    const c = await upload(app.base, 'type=image&scale=2', fx['ok.png']); // after success: cached result
    assert.strictEqual(c.body.duplicate, true);
    // a different scale is a different request
    const d = await upload(app.base, 'type=image&scale=4', fx['ok.png']);
    assert.strictEqual(d.status, 202);
    await waitJob(app.base, d.body.job.id);
    assert.strictEqual(ctx.mock.state.calls.filter((x) => x === 'POST /v1/predictions').length, 2);
  } finally { ctx.mock.state.polls = 3; await app.close(); }
});

test('[LOCAL] concurrency + rate limits + daily cap are enforced', async () => {
  const app = await fresh({ maxConcurrentPerIp: 1, rateLimitPerHour: 4, dailyJobCap: 2 }, ctx.mock);
  try {
    ctx.mock.state.polls = 8;
    const mk = (i) => Buffer.concat([fs.readFileSync(fx['ok.png']), Buffer.alloc(i)]);
    const a = await upload(app.base, 'type=image&scale=2', mk(1));
    assert.strictEqual(a.status, 202);
    const b = await upload(app.base, 'type=image&scale=2', mk(2));
    assert.strictEqual(b.status, 429); assert.strictEqual(b.body.error.code, 'BUSY');
    await waitJob(app.base, a.body.job.id);
    const c = await upload(app.base, 'type=image&scale=2', mk(3));
    assert.strictEqual(c.status, 202);
    await waitJob(app.base, c.body.job.id);
    const d = await upload(app.base, 'type=image&scale=2', mk(4)); // 4th attempt hits hourly limit? attempts: a,b,c,d => 4th allowed, daily cap (2) blocks
    assert.strictEqual(d.body.error.code, 'DAILY_LIMIT');
    const e = await upload(app.base, 'type=image&scale=2', mk(5)); // 5th attempt
    assert.strictEqual(e.status, 429); assert.strictEqual(e.body.error.code, 'RATE_LIMITED');
  } finally { ctx.mock.state.polls = 3; await app.close(); }
});

test('[LOCAL] temporary files are deleted after the TTL and on user request', async () => {
  const app = await fresh({ fileTtlMinutes: 0.001 }, ctx.mock); // ~60ms
  try {
    const r = await upload(app.base, 'type=image&scale=2', fx['ok.png']);
    const job = await waitJob(app.base, r.body.job.id);
    assert.ok(fs.existsSync(app.cfg.tmpDir + '/' + job.id));
    // original is removed as soon as it was handed to the AI service
    assert.strictEqual(fs.readdirSync(app.cfg.tmpDir + '/' + job.id).some((f) => f.startsWith('original')), false);
    await new Promise((s) => setTimeout(s, 200));
    await app.jobs.sweep();
    assert.strictEqual(fs.existsSync(app.cfg.tmpDir + '/' + job.id), false);
    assert.strictEqual((await fetch(app.base + job.result.url)).status, 404);
  } finally { await app.close(); }
  const app2 = await fresh({}, ctx.mock);
  try {
    const r = await upload(app2.base, 'type=image&scale=2', fx['ok.png']);
    const job = await waitJob(app2.base, r.body.job.id);
    const del = await fetch(app2.base + '/api/jobs/' + job.id, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(fs.existsSync(app2.cfg.tmpDir + '/' + job.id), false);
    assert.strictEqual((await fetch(app2.base + '/api/jobs/' + job.id)).status, 404);
  } finally { await app2.close(); }
});

// ----------------- video -----------------
test('[LOCAL] video: 10s+ rejected, corrupt rejected, WebM rejected — before any AI call', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    const q = 'type=video&resolution=1080p';
    const cases = [['v10.mp4', 'VIDEO_TOO_LONG'], ['v12.mp4', 'VIDEO_TOO_LONG'], ['garbage.mp4', 'CORRUPT_FILE'], ['trunc.mp4', 'CORRUPT_FILE'], ['text.mp4', 'UNSUPPORTED_TYPE'], ['png-as.mp4', 'UNSUPPORTED_TYPE'], ['v3.webm', 'UNSUPPORTED_TYPE']];
    for (const [n, code] of cases) {
      const r = await upload(app.base, q, fx[n], { type: 'video/mp4' });
      assert.ok(r.body && r.body.error, n + ' should be rejected');
      assert.ok(r.body.error.code === code || (n === 'trunc.mp4' && r.body.error.code === 'CORRUPT_FILE'), `${n}: got ${r.body.error.code}`);
    }
    assert.strictEqual(ctx.mock.state.calls.filter((c) => c.startsWith('POST')).length, 0);
  } finally { await app.close(); }
});

test('[LOCAL] video: target resolution must be higher than source', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    // source is 160x120 so 720p is higher: OK. A 1080-short-side source to 720p must be refused (checked via cfg-less path below)
    const r = await upload(app.base, 'type=video&resolution=nope', fx['v3.mp4']);
    assert.strictEqual(r.body.error.code, 'INVALID_PARAMS');
  } finally { await app.close(); }
});

test('[MOCK-API] video: full pipeline, result is a valid playable MP4, fps preserved, Range works', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    const r = await upload(app.base, 'type=video&resolution=720p', fx['v3.mp4'], { name: 'clip.mp4', type: 'video/mp4' });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    const job = await waitJob(app.base, r.body.job.id);
    assert.strictEqual(job.status, 'succeeded', JSON.stringify(job.error));
    assert.strictEqual(ctx.mock.state.lastCreatePath, '/v1/models/topazlabs/video-upscale/predictions');
    assert.strictEqual(ctx.mock.state.lastInput.target_resolution, '720p');
    assert.strictEqual(ctx.mock.state.lastInput.target_fps, 24);
    assert.strictEqual(job.result.height, 720);
    assert.ok(job.result.duration > 2.5 && job.result.duration < 3.5);
    const dl = await fetch(app.base + job.result.downloadUrl);
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.strictEqual(bytes.length, job.result.size);
    const tmp = app.tmpDir + '/out.mp4'; fs.writeFileSync(tmp, bytes);
    const info = await V.inspectResultVideo(app.cfg, tmp); // ffprobe + full decode of the downloaded file
    assert.strictEqual(info.height, 720);
    const part = await fetch(app.base + job.result.url, { headers: { Range: 'bytes=0-99' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual((await part.arrayBuffer()).byteLength, 100);
  } finally { await app.close(); }
});

test('[LOCAL] video: a corrupt result from the service is NOT reported as success', async () => {
  const app = await fresh({}, ctx.mock);
  try {
    ctx.mock.state.mode = 'badoutput';
    const r = await upload(app.base, 'type=video&resolution=720p', fx['v3.mp4'], { type: 'video/mp4' });
    const job = await waitJob(app.base, r.body.job.id);
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.error.code, 'BAD_OUTPUT');
  } finally { await app.close(); }
});

test('[MOCK-API] video: refuses a target that is not higher than the source; offers a higher one', async () => {
  const { execFileSync } = require('child_process');
  const path = require('path'); const os = require('os');
  const hd = path.join(os.tmpdir(), 'enhance-ai-fixtures', 'v720.mp4');
  if (!fs.existsSync(hd)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', hd]);
  const app = await fresh({}, ctx.mock);
  try {
    const r = await upload(app.base, 'type=video&resolution=720p', hd, { type: 'video/mp4' });
    assert.strictEqual(r.body.error.code, 'RESOLUTION_NOT_HIGHER');
    assert.strictEqual(ctx.mock.state.calls.filter((c) => c.startsWith('POST')).length, 0, 'no paid call for a pointless upscale');
    const ok = await upload(app.base, 'type=video&resolution=1080p', hd, { type: 'video/mp4' });
    assert.strictEqual(ok.status, 202);
    const job = await waitJob(app.base, ok.body.job.id);
    assert.strictEqual(job.status, 'succeeded', JSON.stringify(job.error));
    assert.strictEqual(job.result.height, 1080);
    assert.strictEqual(ctx.mock.state.lastInput.target_fps, 25);
  } finally { await app.close(); }
});

test('[LOCAL] optional ACCESS_CODE: wrong/missing code is refused before any work', async () => {
  const app = await fresh({ accessCode: 'letmein-123' }, ctx.mock);
  try {
    assert.strictEqual((await (await fetch(app.base + '/api/config')).json()).accessCodeRequired, true);
    const png = fs.readFileSync(fx['ok.png']);
    const noCode = await upload(app.base, 'type=image&scale=2', png);
    assert.strictEqual(noCode.status, 401); assert.strictEqual(noCode.body.error.code, 'ACCESS_DENIED');
    const bad = await fetch(app.base + '/api/jobs?type=image&scale=2', { method: 'POST', body: png, headers: { 'X-Access-Code': 'nope' } });
    assert.strictEqual(bad.status, 401);
    const good = await fetch(app.base + '/api/jobs?type=image&scale=2', { method: 'POST', body: png, headers: { 'X-Access-Code': 'letmein-123' } });
    assert.strictEqual(good.status, 202);
    assert.strictEqual(ctx.mock.state.calls.filter((c) => c === 'POST /v1/files').length <= 1, true);
    assert.ok(!(await fetch(app.base + '/api/config').then((r) => r.text())).includes('letmein-123'));
  } finally { await app.close(); }
});
