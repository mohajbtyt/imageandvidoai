'use strict';
// [LOCAL] Security tests: no secret leaks, SSRF guard, headers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeFixtures, startMockReplicate, startApp, upload, waitJob, TEST_TOKEN } = require('./helpers');

const fx = makeFixtures();
const ROOT = path.join(__dirname, '..');

test('[LOCAL] no secret / env var name appears in any file served to the browser', async () => {
  const app = await startApp({});
  try {
    const pub = fs.readdirSync(path.join(ROOT, 'public'));
    for (const f of pub) {
      const text = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
      assert.ok(!text.includes(TEST_TOKEN), f);
      assert.ok(!/r8_[A-Za-z0-9]{10,}/.test(text), f);
      assert.ok(!/REPLICATE_API_TOKEN|REPLICATE_VIDEO_API_TOKEN|process\.env/.test(text), f + ' mentions server secrets');
      const served = await fetch(app.base + '/' + f);
      assert.strictEqual(served.status, 200, f);
      assert.ok(!(await served.text()).includes(TEST_TOKEN));
    }
    const cfgText = await (await fetch(app.base + '/api/config')).text();
    assert.ok(!cfgText.includes(TEST_TOKEN));
    assert.ok(!/token|secret|apiBase/i.test(cfgText));
    // server source files are not reachable through the static handler
    for (const p of ['/../server/config.js', '/..%2fserver/config.js', '/%2e%2e/.env', '/.env', '/server/config.js']) {
      const r = await fetch(app.base + p);
      assert.notStrictEqual(r.status, 200, p);
    }
  } finally { await app.close(); }
});

test('[MOCK-API] secret never appears in job JSON or error bodies, even when the API echoes it', async () => {
  const mock = await startMockReplicate();
  const app = await startApp({}, mock);
  try {
    mock.state.mode = 'modelfail';
    const r = await upload(app.base, 'type=image&scale=2', fx['ok.png']);
    const job = await waitJob(app.base, r.body.job.id);
    assert.ok(!JSON.stringify(job).includes(TEST_TOKEN));
    mock.state.mode = 'auth401';
    const png = Buffer.concat([fs.readFileSync(fx['ok.png']), Buffer.alloc(3)]);
    const r2 = await upload(app.base, 'type=image&scale=2', png);
    const job2 = await waitJob(app.base, r2.body.job.id);
    assert.strictEqual(job2.error.code, 'REPLICATE_AUTH');
    assert.ok(!JSON.stringify(job2).includes(TEST_TOKEN));
  } finally { await app.close(); await mock.close(); }
});

test('[MOCK-API] SSRF: result URLs on non-allowlisted hosts are never fetched', async () => {
  const mock = await startMockReplicate();
  const app = await startApp({ allowedResultHosts: ['replicate.delivery'], allowInsecureResultHosts: false }, mock);
  try {
    mock.state.mode = 'evilhost';
    for (const evil of ['http://169.254.169.254/latest/meta-data', 'https://evil.example.com/x.png', 'https://replicate.delivery.evil.com/x.png', 'file:///etc/passwd', 'https://user:pw@replicate.delivery/x.png']) {
      mock.state.evilUrl = evil;
      mock.state.delivered = 0;
      const png = Buffer.concat([fs.readFileSync(fx['ok.png']), Buffer.from(evil)]);
      const r = await upload(app.base, 'type=image&scale=2', png);
      const job = await waitJob(app.base, r.body.job.id);
      assert.strictEqual(job.status, 'failed', evil);
      assert.strictEqual(job.error.code, 'OUTPUT_HOST_BLOCKED', evil);
      assert.strictEqual(mock.state.delivered, 0);
    }
  } finally { await app.close(); await mock.close(); }
});

test('[LOCAL] users cannot make the server fetch URLs: URL-like params/bodies are not fetched', async () => {
  const mock = await startMockReplicate();
  const app = await startApp({}, mock);
  try {
    const r = await fetch(app.base + '/api/jobs?type=image&scale=2&image=http://127.0.0.1:1/x.png&url=http://127.0.0.1:1/x', { method: 'POST', body: Buffer.from('http://127.0.0.1:1/x.png') });
    assert.strictEqual((await r.json()).error.code, 'UNSUPPORTED_TYPE');
    assert.strictEqual(mock.state.calls.length, 0);
  } finally { await app.close(); await mock.close(); }
});

test('[LOCAL] security headers and unguessable job ids', async () => {
  const app = await startApp({});
  try {
    const r = await fetch(app.base + '/');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual((await fetch(app.base + '/api/jobs/' + '0'.repeat(32))).status, 404);
    assert.strictEqual((await fetch(app.base + '/api/jobs/short')).status, 404);
    const html = await r.text();
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline scripts');
    assert.ok(!/\sstyle=/.test(html), 'no inline style attributes');
  } finally { await app.close(); }
});
