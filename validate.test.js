'use strict';
// [LOCAL] Unit tests for file validation. No network, no AI service.
const test = require('node:test');
const assert = require('node:assert');
const { makeFixtures } = require('./helpers');
const V = require('../server/validate');
const { loadConfig } = require('../server/config');

const fx = makeFixtures();
const cfg = loadConfig({});

test('[LOCAL] accepts real PNG/JPEG/WebP and reads true dimensions', async () => {
  for (const [name, kind] of [['ok.png', 'png'], ['ok.jpg', 'jpeg'], ['ok.webp', 'webp']]) {
    const info = await V.inspectImage(fx[name]);
    assert.strictEqual(info.kind, kind);
    assert.strictEqual(info.width, 160);
    assert.strictEqual(info.height, 120);
  }
});

test('[LOCAL] rejects unsupported / fake / empty / truncated images by content, not name', async () => {
  const code = async (f) => { try { await V.inspectImage(f); return 'ACCEPTED'; } catch (e) { return e.code; } };
  assert.strictEqual(await code(fx['fake.png']), 'UNSUPPORTED_TYPE'); // text named .png
  assert.strictEqual(await code(fx['ok.gif']), 'UNSUPPORTED_TYPE');
  assert.strictEqual(await code(fx['empty.png']), 'EMPTY_FILE');
  assert.strictEqual(await code(fx['trunc.png']), 'CORRUPT_FILE');
  assert.strictEqual(await code(fx['trunc.jpg']), 'CORRUPT_FILE');
  assert.strictEqual(await code(fx['v3.mp4']), 'UNSUPPORTED_TYPE'); // a video is not an image
});

test('[LOCAL] video: accepts <10s MP4 using real duration', async () => {
  const a = await V.inspectVideoUpload(cfg, fx['v3.mp4']);
  assert.ok(a.duration > 2.9 && a.duration < 3.2);
  const b = await V.inspectVideoUpload(cfg, fx['v9.mp4']);
  assert.ok(b.duration < 10);
  assert.strictEqual(b.width, 160);
});

test('[LOCAL] video: rejects exactly 10s and 12s', async () => {
  for (const n of ['v10.mp4', 'v12.mp4']) {
    await assert.rejects(() => V.inspectVideoUpload(cfg, fx[n]), (e) => e.code === 'VIDEO_TOO_LONG');
  }
});

test('[LOCAL] video: rejects corrupt, truncated, text and renamed-image files', async () => {
  for (const n of ['garbage.mp4', 'trunc.mp4', 'text.mp4', 'png-as.mp4']) {
    await assert.rejects(() => V.inspectVideoUpload(cfg, fx[n]), (e) => ['CORRUPT_FILE', 'UNSUPPORTED_TYPE', 'VIDEO_NO_STREAM'].includes(e.code), n);
  }
});

test('[LOCAL] video: rejects non-MP4 containers (WebM)', async () => {
  await assert.rejects(() => V.inspectVideoUpload(cfg, fx['v3.webm']), (e) => e.code === 'UNSUPPORTED_TYPE');
});
