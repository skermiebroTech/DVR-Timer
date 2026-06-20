# Vendored ffmpeg.wasm

Self-hosted so the app stays static, offline-capable, and same-origin (ffmpeg.wasm
spawns an internal Worker, which can't be constructed from a cross-origin CDN URL).
Used only by the **Export MP4 (background)** feature (`js/export-ffmpeg.js`).

| File | Source | Notes |
|------|--------|-------|
| `ffmpeg/ffmpeg.js`       | `@ffmpeg/ffmpeg@0.12.10` `dist/umd/ffmpeg.js`       | UMD main thread; defines `window.FFmpegWASM`. |
| `ffmpeg/814.ffmpeg.js`   | `@ffmpeg/ffmpeg@0.12.10` `dist/umd/814.ffmpeg.js`   | Its worker chunk; auto-loaded same-origin as a **classic** worker so `importScripts` works. |
| `core/ffmpeg-core.js`    | `@ffmpeg/core@0.12.6` `dist/umd/ffmpeg-core.js`     | Single-thread core loader. |
| `core/ffmpeg-core.wasm`  | `@ffmpeg/core@0.12.6` `dist/umd/ffmpeg-core.wasm`   | ~32 MB; fetched lazily on first export. |

Single-thread core only: the multi-thread core deadlocks on `exec` when the source
is mounted via WORKERFS (its pthreads can't reach the main thread's `FileReaderSync`),
and WORKERFS is required to read multi-GB `.ts` files without copying them into the heap.

To update, re-download the same paths from unpkg, e.g.:

```bash
curl -sSL -o vendor/ffmpeg/ffmpeg.js     https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js
curl -sSL -o vendor/ffmpeg/814.ffmpeg.js https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js
curl -sSL -o vendor/core/ffmpeg-core.js   https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js
curl -sSL -o vendor/core/ffmpeg-core.wasm https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm
```
