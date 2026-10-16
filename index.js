'use strict';
const path = require('path');
const { loadConfig, loadDotEnv } = require('./config');
loadDotEnv(path.join(__dirname, '..', '.env'));
const cfg = loadConfig();
const { createApp } = require('./app');
const V = require('./validate');

(async () => {
  const { server } = createApp(cfg);
  server.listen(cfg.port, cfg.host, async () => {
    console.log(`Enhance AI listening on http://${cfg.host}:${cfg.port}`);
    console.log(`Image engine : ${cfg.replicateToken ? `configured (${cfg.imageModel})` : 'NOT configured - set REPLICATE_API_TOKEN'}`);
    if (!cfg.videoEnabled) console.log('Video engine : disabled (set VIDEO_ENGINE_ENABLED=true to enable)');
    else if (!cfg.videoToken) console.log('Video engine : NOT configured - missing API token');
    else if (!(await V.videoToolsAvailable(cfg))) console.log('Video engine : NOT available - ffprobe/ffmpeg not found');
    else console.log(`Video engine : configured (${cfg.videoModel})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})();
