'use strict';
// [E2E-MOBILE] Drives the real UI in a phone-sized Chromium against our server + a LOCAL mock of Replicate.
// Requires Playwright:  npm i -D playwright  (and a Chromium; set CHROMIUM_PATH if needed).
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
let pw;
try { pw = require('playwright'); } catch (_) { pw = require('/opt/npm-tools/node_modules/playwright'); }
const { makeFixtures, startMockReplicate, startApp } = require('../helpers');
const V = require('../../server/validate');

const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'enhance-ai-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); console.log('PASS', name); } catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n   ', e.message); } };

(async () => {
  const fx = makeFixtures();
  const mock = await startMockReplicate();
  const app = await startApp({}, mock);
  const appOff = await startApp({ replicateToken: '', videoToken: '', videoEnabled: false });
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...pw.devices['iPhone 13'], locale: 'ar', acceptDownloads: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

  await page.goto(app.base);
  await page.waitForSelector('#panel-image .dropzone:not(.disabled)');

  await check('phone viewport: Arabic RTL by default, no horizontal scroll', async () => {
    assert.strictEqual(await page.getAttribute('html', 'dir'), 'rtl');
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
    assert.ok(w.s <= w.i, `overflow ${w.s} > ${w.i}`);
    assert.ok((await page.textContent('h1')).includes('الذكاء الاصطناعي'));
    await page.screenshot({ path: path.join(SHOTS, '01-mobile-ar.png'), fullPage: true });
  });

  await check('language toggle switches to English / LTR and back', async () => {
    await page.click('#langBtn');
    assert.strictEqual(await page.getAttribute('html', 'dir'), 'ltr');
    assert.ok((await page.textContent('h1')).includes('Enhance your photos'));
    assert.ok((await page.textContent('#tab-video')).includes('Video'));
    await page.click('#langBtn');
    assert.strictEqual(await page.getAttribute('html', 'dir'), 'rtl');
  });

  await check('unsupported image is rejected in the UI (no job created)', async () => {
    await page.setInputFiles('#panel-image [data-el=file]', fx['fake.png']);
    // fake.png has a .png name so it passes the client hint; the SERVER must reject it by content.
    await page.click('#panel-image [data-el=go]');
    await page.waitForSelector('#panel-image .notice.err');
    assert.ok((await page.textContent('#panel-image .notice.err')).includes('غير مدعوم'));
    await page.screenshot({ path: path.join(SHOTS, '02-mobile-error.png'), fullPage: true });
  });

  await check('image: preview, 4x enhance, real result shown with verified sizes, download opens as 640x480 PNG', async () => {
    await page.setInputFiles('#panel-image [data-el=file]', fx['ok.png']);
    await page.waitForSelector('#panel-image [data-el=originalImg][src^="blob:"]');
    await page.waitForSelector('#panel-image [data-el=options]:not([hidden])');
    await page.check('#panel-image input[name=scale][value="4"]', { force: true });
    await page.click('#panel-image [data-el=go]');
    await page.waitForSelector('#panel-image .steps');
    await page.waitForSelector('#panel-image a.btn.ok', { timeout: 30000 });
    const table = await page.textContent('#panel-image table.cmp');
    assert.ok(table.includes('160×120') && table.includes('640×480'), table);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#panel-image a.btn.ok')]);
    const out = path.join(SHOTS, 'downloaded-image.png'); await dl.saveAs(out);
    const info = await V.inspectImage(out);
    assert.deepStrictEqual([info.width, info.height], [640, 480]);
    const natural = await page.evaluate(() => { const i = document.querySelector('#panel-image .job img'); return [i.naturalWidth, i.naturalHeight]; });
    assert.deepStrictEqual(natural, [640, 480]);
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
    assert.ok(w.s <= w.i, 'overflow after result');
    await page.screenshot({ path: path.join(SHOTS, '03-mobile-image-result.png'), fullPage: true });
  });

  await page.click('#tab-video');
  // The Chromium bundled with Playwright has no H.264 decoder, so the browser-side metadata pre-check
  // (a convenience) cannot run there. The server-side check is authoritative and is what we assert.
  const canH264 = await page.evaluate(() => !!document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'));
  console.log('INFO browser can decode H.264:', canH264);

  await check('video: 12s video is refused with a clear message and no AI call is made', async () => {
    const before = mock.state.calls.length;
    await page.setInputFiles('#panel-video [data-el=file]', fx['v12.mp4']);
    if (canH264) {
      await page.waitForSelector('#panel-video .notice.err', { timeout: 10000 });
      assert.ok(await page.isDisabled('#panel-video [data-el=go]'), 'client pre-check should block');
    } else {
      await page.waitForSelector('#panel-video [data-el=go]:not([hidden])');
      await page.click('#panel-video [data-el=go]');
      await page.waitForSelector('#panel-video .notice.err', { timeout: 15000 });
    }
    assert.ok((await page.textContent('#panel-video .notice.err')).includes('10'));
    assert.strictEqual(mock.state.calls.length, before, 'AI service must not be called');
    await page.screenshot({ path: path.join(SHOTS, '04-mobile-video-too-long.png'), fullPage: true });
  });

  await check('video: 3s MP4 processed, result is a playable video; downloaded file is a valid MP4', async () => {
    await page.setInputFiles('#panel-video [data-el=file]', fx['v3.mp4']);
    await page.waitForSelector('#panel-video [data-el=originalVideo][src^="blob:"]');
    if (canH264) await page.waitForFunction(() => /160×120/.test(document.querySelector('#panel-video [data-el=originalMeta]').textContent));
    await page.check('#panel-video input[name=resolution][value="720p"]', { force: true });
    await page.click('#panel-video [data-el=go]');
    await page.waitForSelector('#panel-video a.btn.ok', { timeout: 60000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#panel-video a.btn.ok')]);
    const out = path.join(SHOTS, 'downloaded-video.mp4'); await dl.saveAs(out);
    const info = await V.inspectResultVideo(app.cfg, out);
    assert.strictEqual(info.height, 720);
    if (canH264) {
      const state = await page.evaluate(async () => { const v = document.querySelector('#panel-video .job video'); await new Promise((r) => { if (v.readyState >= 1) r(); else v.onloadedmetadata = r; setTimeout(r, 5000); }); return [v.videoHeight, v.duration]; });
      assert.strictEqual(state[0], 720);
    } else console.log('INFO in-browser playback of the result skipped (no H.264 in this Chromium); file validity verified with ffprobe+decode instead');
    await page.screenshot({ path: path.join(SHOTS, '05-mobile-video-result.png'), fullPage: true });
  });

  await check('not configured: banners shown, controls disabled, no fake processing', async () => {
    const p2 = await ctx.newPage();
    await p2.goto(appOff.base);
    await p2.waitForSelector('#panel-image .notice.warn:not([hidden])');
    assert.ok((await p2.textContent('#panel-image .notice.warn')).includes('غير مهيأة'));
    assert.ok(await p2.isDisabled('#panel-image [data-el=file]'));
    assert.ok(await p2.isDisabled('#panel-image [data-el=go]'));
    await p2.click('#tab-video');
    assert.ok((await p2.textContent('#panel-video .notice.warn')).includes('غير مهيأ'));
    await p2.screenshot({ path: path.join(SHOTS, '06-mobile-not-configured.png'), fullPage: true });
    await p2.close();
  });

  await check('no console errors / CSP violations during the whole session', async () => {
    assert.deepStrictEqual(problems.filter((p) => !/Failed to load resource: the server responded with a status of 4\d\d/.test(p)), []);
  });

  await browser.close(); await app.close(); await appOff.close(); await mock.close();
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\nE2E mobile: ${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
