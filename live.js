'use strict';
// [LIVE] Real Replicate API test. Needs REPLICATE_API_TOKEN in the environment or .env.
// Image test costs a fraction of a cent. The video test runs ONLY if LIVE_VIDEO=1 (it is paid).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadDotEnv, loadConfig } = require('../../server/config');
loadDotEnv(path.join(__dirname, '..', '..', '.env'));
if (!process.env.REPLICATE_API_TOKEN) {
  console.log('SKIPPED: REPLICATE_API_TOKEN is not set, so NO live API test was run.');
  process.exit(0);
}
const { createApp } = require('../../server/app');
const { makeFixtures, upload, waitJob } = require('../helpers');
const V = require('../../server/validate');

(async () => {
  const fx = makeFixtures();
  const cfg = loadConfig({ tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'enhance-live-')), videoEnabled: process.env.LIVE_VIDEO === '1' || loadConfig().videoEnabled, rateLimitPerHour: 100 });
  const { server } = createApp(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failed = false;
  const run = async (label, q, file, type, expect) => {
    const r = await upload(base, q, file, { type });
    if (r.status !== 202 && r.status !== 200) { console.log('FAIL', label, JSON.stringify(r.body)); failed = true; return; }
    const job = await waitJob(base, r.body.job.id, 20 * 60 * 1000);
    if (job.status !== 'succeeded') { console.log('FAIL', label, JSON.stringify(job.error)); failed = true; return; }
    const bytes = Buffer.from(await (await fetch(base + job.result.url)).arrayBuffer());
    const out = path.join(os.tmpdir(), 'live-' + job.result.filename); fs.writeFileSync(out, bytes);
    const info = job.type === 'video' ? await V.inspectResultVideo(cfg, out) : await V.inspectImage(out);
    console.log('PASS', label, `${job.original.width}x${job.original.height} -> ${info.width}x${info.height}, ${bytes.length} bytes, saved ${out}`);
    if (expect && !expect(info)) { console.log('FAIL', label, 'unexpected dimensions'); failed = true; }
  };
  await run('image 4x (Real-ESRGAN)', 'type=image&scale=4&face_enhance=0', fx['ok.png'], 'image/png', (i) => i.width > 160 * 3);
  if (process.env.LIVE_VIDEO === '1') await run('video 720p (Topaz)', 'type=video&resolution=720p', fx['v3.mp4'], 'video/mp4', (i) => i.height >= 720);
  else console.log('SKIPPED video live test (set LIVE_VIDEO=1 and VIDEO_ENGINE_ENABLED=true; it is paid).');
  server.close(); process.exit(failed ? 1 : 0);
})();
