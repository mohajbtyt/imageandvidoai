# Enhance AI — تحسين الصور والفيديو بالذكاء الاصطناعي

Image and short-video enhancement website. Node.js backend (no npm dependencies), static frontend (Arabic/English, dark, mobile-first).

| Feature | Real engine | Notes |
|---|---|---|
| Images (JPG/PNG/WebP) | Replicate `nightmareai/real-esrgan` (input: `image`, `scale`, `face_enhance`) | 2x / 4x, optional face enhancement |
| Video (MP4, < 10 s) | Replicate `topazlabs/video-upscale` (input: `video`, `target_resolution` 720p/1080p/4k, `target_fps`) | **Paid per second of video. Off by default.** |

Nothing is simulated: if a key or engine is missing, the UI says so and refuses; a result is shown only after the server downloaded it from the AI service and verified it is a valid image/video.

---

## 1) Requirements
- Node.js 20 or newer
- `ffmpeg` (provides `ffprobe`) — **only needed for video** (duration check, corruption check, output verification). Images work without it. Without it the video tab shows "unavailable".
- A Replicate account + API token: https://replicate.com/account/api-tokens (add billing credit)

## 2) Run locally
```bash
cd enhance-ai
cp .env.example .env        # then edit .env and set REPLICATE_API_TOKEN
npm start                   # no `npm install` needed: zero dependencies
# open http://localhost:3000
```
To use it from your phone on the same Wi-Fi: open `http://<computer-IP>:3000`.

## 3) API setup
1. Put your token in `.env`: `REPLICATE_API_TOKEN=r8_...` (server only; never sent to the browser).
2. Video (optional, costs money): set `VIDEO_ENGINE_ENABLED=true`. Uses the same token unless you set `REPLICATE_VIDEO_API_TOKEN`.
3. Public site? Set `ACCESS_CODE=something` so strangers cannot spend your credit. Also review `DAILY_JOB_CAP`, `RATE_LIMIT_PER_HOUR`.
4. Check startup log: it prints whether each engine is configured.

## 4) Deploy (step by step, phone-friendly)
**Render.com (Docker, includes ffmpeg):**
1. Push this folder to a GitHub repo (`.env` is git-ignored; don't commit keys).
2. Render → New → Blueprint → select the repo (`render.yaml` is included), or New → Web Service → Docker.
3. Set environment variables in the Render dashboard: `REPLICATE_API_TOKEN`, `ACCESS_CODE`, and `VIDEO_ENGINE_ENABLED=true` if wanted. `TRUST_PROXY=1` is already set.
4. Deploy and open the URL. Keep **one instance** (jobs live in memory and temp files on local disk).

Other hosts (Railway, Fly.io, VPS): use the `Dockerfile`, or `node server/index.js` with Node 20+ and ffmpeg installed. Put it behind HTTPS and set `TRUST_PROXY` to the number of proxies in front.

## 5) Security & privacy design
- Secrets only in server env vars; static files contain none (tested).
- Uploads are validated by **real bytes** (PNG/JPEG/WebP signatures, truncation check; MP4 via ffprobe + full ffmpeg decode), never by file name. Video duration is read from the file; must be **strictly < 10 s**.
- Limits: file size, image megapixels, video size/resolution, processing timeout (prediction is cancelled on timeout), per-IP hourly attempts, per-IP and global concurrency, daily job cap.
- Duplicate protection: the same file + same options returns the existing job instead of creating a second paid prediction.
- No user-supplied URLs are ever fetched. The server only downloads the result URL returned by the AI service, and only from `replicate.delivery` (https, no redirects, size-capped).
- Temp files: original is deleted as soon as it is handed to Replicate; the result is deleted after `FILE_TTL_MINUTES` (default 30) or when the user presses "Delete my files now"; leftovers are purged at startup.
- Privacy notice is shown on the page: files are sent to Replicate (third party), kept temporarily here, not used for anything else. Review Replicate's own retention terms for your use and add your own legal policy if you run a public service.
- Video "levels": only resolutions higher than the source are accepted; source frame rate is kept (clamped 15–60) so Topaz does not silently change it.

## 6) Tests
```bash
npm test            # local + mock-API tests (needs ffmpeg for fixtures); no key, no cost
npm run test:e2e    # phone-size browser test (needs: npm i -D playwright + a Chromium; CHROMIUM_PATH optional)
npm run test:live   # REAL Replicate call; skips itself if no key. LIVE_VIDEO=1 adds the paid video test
```
Test labels: `[LOCAL]` = our code only; `[MOCK-API]` = our server against a local imitation of Replicate (proves the pipeline, error handling and verification — **not** AI quality); `[LIVE]` = real service.

## 7) Troubleshooting
| Message | Meaning / fix |
|---|---|
| Not configured | Missing `REPLICATE_API_TOKEN`, or `VIDEO_ENGINE_ENABLED` not `true` |
| Video unavailable (ffprobe) | Install ffmpeg or use the Docker image |
| AI service rejected the API key / insufficient credit | Check token / add Replicate billing |
| Resolution not higher | Choose a higher target for that video |
| Processing timed out | Increase `IMAGE_TIMEOUT_SEC` / `VIDEO_TIMEOUT_SEC`; cold model starts can be slow |

Verified model facts and caveats: Real-ESRGAN input/output taken from Replicate's version API page; Topaz input names (`video`, `target_resolution`, `target_fps`) come from a third-party report of its schema, not Replicate's own page (not reachable from the build environment) — confirm on the model's API tab; override via `REPLICATE_VIDEO_MODEL` if it changes.
