/* ============================================================
   export-ffmpeg.js — Player-free background export via ffmpeg.wasm
   ============================================================

   Unlike export-video.js (which drives the on-screen player and captures it),
   this path runs entirely off the player:

     1. Render the race-timer overlay (OverlayRender) to a transparent PNG
        sequence in a worker-side canvas — independent of playback.
     2. Mount the source file lazily with WORKERFS so ffmpeg reads it in slices
        (a 1 GB .ts never gets copied into the WASM heap).
     3. ffmpeg decodes the source, composites the overlay, and encodes H.264 MP4,
        emitting progress for a real status bar.

   The visible player stays free for scrubbing/marking laps while this runs.
   Self-hosted ffmpeg files live in /vendor (see vendor/README).
   ============================================================ */

const ExportFfmpeg = (() => {
  const CORE_ST_DIR = 'vendor/core';    // self-hosted single-thread ffmpeg.wasm core (relative: works under a Pages subpath)

  let ffmpeg      = null;   // cached FFmpeg instance (core load is ~32 MB)
  let cancelled   = false;
  let running     = false;
  let sourceFile  = null;   // original File from the loader, retained for export

  // Registered by app.js whenever a video is loaded.
  function setSource(file) { sourceFile = file || null; }

  // Source file name without its extension, sanitized for use in a download
  // filename. Shared by every export path (JSON/CSV/WebM/MP4) so outputs are
  // named after the clip they came from. Returns null when no clip is loaded.
  function sourceBaseName() {
    if (!sourceFile || !sourceFile.name) return null;
    return sourceFile.name
      .replace(/\.[^/.]+$/, '')        // drop extension
      .replace(/[/\\?%*:|"<>]/g, '_')  // strip filesystem-unsafe chars
      .trim() || null;
  }

  // ── tiny @ffmpeg/util equivalents (avoid an extra dependency) ─────────────
  const toBlobURL = async (url, type) => {
    const buf = await (await fetch(url)).arrayBuffer();
    return URL.createObjectURL(new Blob([buf], { type }));
  };

  // Single-thread core only. The multi-thread core deadlocks on exec when the
  // source is mounted via WORKERFS (its pthreads can't reach the main thread's
  // FileReaderSync handle), and WORKERFS is non-negotiable for multi-GB .ts files
  // (a 1 GB writeFile would blow the WASM heap). So we trade threads for memory.
  async function load(onStatus) {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;
    if (!window.FFmpegWASM) throw new Error('ffmpeg.wasm not loaded (vendor/ffmpeg/ffmpeg.js missing)');
    const { FFmpeg } = FFmpegWASM;
    ffmpeg = new FFmpeg();
    onStatus?.('Loading encoder (first time only)…');

    // No classWorkerURL: ffmpeg.js is same-origin so it auto-loads its 814 worker
    // as a *classic* worker, where importScripts (used to pull in the UMD core)
    // works. A classWorkerURL would force a module worker, which can't.
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_ST_DIR}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_ST_DIR}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    return ffmpeg;
  }

  // Scale a geometry by a resolution factor so the overlay is rendered at the
  // (possibly upscaled) output resolution — crisp text instead of blurry pixels
  // that scaling the composited frame would give. Every pixel quantity scales.
  function scaleGeom(g, f) {
    return {
      cx: g.cx * f, cy: g.cy * f, fs: g.fs * f,
      scaleX: g.scaleX * f, scaleY: g.scaleY * f, scale: g.scale * f,
    };
  }

  // Resolve the output dimensions + overlay geometry for a target height
  // (null = keep source). Preserves aspect ratio; width rounded to even (yuv420p).
  function resolveResolution(opts) {
    const srcW = opts.width, srcH = opts.height;
    const f = opts.targetHeight ? opts.targetHeight / srcH : 1;
    if (f === 1) return { f, outW: srcW, outH: srcH, geom: opts.geom };
    const outH = opts.targetHeight;
    const outW = Math.round((srcW * f) / 2) * 2;
    return { f, outW, outH, geom: scaleGeom(opts.geom, f) };
  }

  // Measure the largest overlay box across the whole race. The box only changes
  // size at lap boundaries (a row appears/completes), so sampling those moments
  // is exhaustive. Returns an even-aligned crop rect at the fixed box origin.
  function measureCrop(opts) {
    const { width, height, geom, laps, fastestIds, fastTotal, groupSize } = opts;
    const scratch = document.createElement('canvas');
    scratch.width = width; scratch.height = height;
    const sctx = scratch.getContext('2d');

    // Sample within the exported clip window [trimStart, trimEnd] (absolute file
    // times) so the crop box fits whatever the overlay shows over that range.
    const a = opts.trimStart, b = opts.trimEnd;
    const samples = new Set([a, Math.max(a, b - 0.01)]);
    for (const l of laps) {
      if (l.startTime != null) samples.add(l.startTime + 0.05);
      if (l.endTime   != null) { samples.add(l.endTime - 0.05); samples.add(l.endTime + 0.05); }
    }
    let maxW = 0, maxH = 0;
    for (const t of samples) {
      if (t < a || t > b) continue;
      sctx.clearRect(0, 0, width, height);
      const r = OverlayRender.drawOverlay(sctx, geom, t, laps, fastestIds, groupSize, fastTotal);
      if (r) { if (r.w > maxW) maxW = r.w; if (r.h > maxH) maxH = r.h; }
    }
    if (maxW === 0) return null; // no laps → no overlay

    let cropX = Math.max(0, Math.floor(geom.cx) - 2);
    let cropY = Math.max(0, Math.floor(geom.cy) - 2);
    cropX -= cropX % 2; cropY -= cropY % 2;            // even offsets for yuv420p
    let cropW = Math.ceil(maxW + (geom.cx - cropX)) + 4;
    let cropH = Math.ceil(maxH + (geom.cy - cropY)) + 4;
    cropW = Math.min(cropW, width  - cropX); cropW -= cropW % 2;
    cropH = Math.min(cropH, height - cropY); cropH -= cropH % 2;
    return { cropX, cropY, cropW, cropH };
  }

  // Render the overlay-only PNG sequence into ffmpeg's MEMFS under /ov, cropped
  // to the box (≈6× fewer pixels than full-frame → far faster PNG encoding).
  // Transparent background; each frame compresses to a couple KB.
  async function writeOverlaySequence(ff, opts, crop, onStatus) {
    const { overlayFps, geom, laps, fastestIds, fastTotal, groupSize } = opts;
    const span    = opts.spanSec;
    const startAt = opts.trimStart;   // absolute file time the clip begins at
    const { cropX, cropY, cropW, cropH } = crop;

    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(cropW, cropH)
      : Object.assign(document.createElement('canvas'), { width: cropW, height: cropH });
    const ctx = canvas.getContext('2d');
    const toPng = canvas.convertToBlob
      ? () => canvas.convertToBlob({ type: 'image/png' })
      : () => new Promise(res => canvas.toBlob(res, 'image/png'));

    const total = Math.max(1, Math.ceil(span * overlayFps));
    await ff.createDir('/ov');
    for (let i = 0; i < total; i++) {
      if (cancelled) throw new Error('cancelled');
      // Output frame i maps to absolute file time startAt + i/fps, so lap/race
      // times stay correct even when the clip starts partway through the file.
      const t = startAt + i / overlayFps;
      ctx.clearRect(0, 0, cropW, cropH);
      // Draw the absolutely-positioned box into the crop window.
      ctx.save();
      ctx.translate(-cropX, -cropY);
      OverlayRender.drawOverlay(ctx, geom, t, laps, fastestIds, groupSize, fastTotal);
      ctx.restore();
      const buf = new Uint8Array(await (await toPng()).arrayBuffer());
      await ff.writeFile(`/ov/${String(i).padStart(6, '0')}.png`, buf);
      if (i % 30 === 0) onStatus?.(`Rendering overlay… ${Math.round((i / total) * 100)}%`);
    }
    return total;
  }

  // Mount the source File lazily so ffmpeg reads slices on demand instead of
  // copying the whole (possibly multi-GB) file into the WASM heap.
  async function mountSource(ff, file) {
    const name = (file.name && /\.[a-z0-9]+$/i.test(file.name)) ? file.name : 'source.ts';
    await ff.createDir('/input');
    await ff.mount('WORKERFS', { files: [file] }, '/input');
    return `/input/${name}`;
  }

  async function cleanup(ff, overlayCount) {
    try { await ff.unmount('/input'); } catch (_) {}
    try { await ff.deleteDir('/input'); } catch (_) {}
    for (let i = 0; i < overlayCount; i++) {
      try { await ff.deleteFile(`/ov/${String(i).padStart(6, '0')}.png`); } catch (_) {}
    }
    try { await ff.deleteDir('/ov'); } catch (_) {}
    try { await ff.deleteFile('out.mp4'); } catch (_) {}
  }

  /**
   * Core, app-independent export. Returns a Blob (MP4) or null if cancelled.
   * @param opts {sourceFile, laps, fastestIds, fastTotal, groupSize, geom,
   *              width, height, durationSec, overlayFps, targetHeight, onStatus, onProgress}
   *   targetHeight — null/undefined keeps source resolution; 1080 or 2160 upscales.
   */
  async function run(opts) {
    const { onStatus, onProgress, durationSec } = opts;
    // Clip window [trimStart, trimEnd] in absolute file seconds. Defaults to the
    // whole file; trimmed is true when the user pulled either handle in.
    const trimStart = Math.max(0, opts.trimStart || 0);
    const trimEnd   = (opts.trimEnd && opts.trimEnd <= durationSec + 0.001) ? opts.trimEnd : durationSec;
    const spanSec   = Math.max(0.001, trimEnd - trimStart);
    const trimmed   = trimStart > 0.001 || trimEnd < durationSec - 0.001;
    cancelled = false;
    let overlayCount = 0;
    const ff = await load(onStatus);

    // Progress: ffmpeg reports the encoded media time; divide by the clip span.
    const onLogProgress = ({ time }) => {
      if (time && spanSec) onProgress?.(Math.min(1, (time / 1e6) / spanSec));
    };
    ff.on('progress', onLogProgress);
    const onLog = opts.onLog ? ({ message }) => opts.onLog(message) : null;
    if (onLog) ff.on('log', onLog);

    // Output resolution: keep source, or upscale to 1080p/4K with the overlay
    // re-rendered (not stretched) at that resolution. renderOpts carries the
    // scaled dimensions + geometry into the overlay renderer, plus the resolved
    // clip window so the overlay sequence and crop measurement match the cut.
    const { f, outW, outH, geom } = resolveResolution(opts);
    const renderOpts = { ...opts, width: outW, height: outH, geom, trimStart, trimEnd, spanSec };

    try {
      const crop = measureCrop(renderOpts);
      if (crop) {
        onStatus?.('Rendering overlay…');
        overlayCount = await writeOverlaySequence(ff, renderOpts, crop, onStatus);
      }
      if (cancelled) return null;

      onStatus?.('Preparing source…');
      const inputPath = await mountSource(ff, opts.sourceFile);
      if (cancelled) return null;

      // Downsample to the overlay rate (default 30 fps). HDZero records 90 fps,
      // which triples decode+encode work for no review benefit — the burned-in
      // timer is still millisecond-exact at every output frame, and the lap data
      // itself is untouched. Output fps == overlay fps keeps the two 1:1 aligned.
      const fps = opts.overlayFps;
      // Source filter chain: optional Lanczos upscale, then fps. The overlay PNGs
      // are already at the output resolution, so they composite 1:1.
      const srcChain = [];
      if (f !== 1) srcChain.push(`scale=${outW}:${outH}:flags=lanczos`);
      srcChain.push(`fps=${fps}`);

      onStatus?.('Encoding… 0%');
      // -ss before -i seeks the source to the in-point (accurate seek: ffmpeg
      // decodes from the prior keyframe and rebases output to 0). The overlay PNG
      // input is unaffected and stays aligned: output time τ shows file time
      // trimStart+τ for both source and overlay. -t caps the duration to the clip.
      const args = [];
      if (trimStart > 0.001) args.push('-ss', trimStart.toFixed(3));
      args.push('-i', inputPath);
      if (crop) {
        args.push(
          '-framerate', String(fps), '-i', '/ov/%06d.png',
          '-filter_complex',
          `[0:v]${srcChain.join(',')}[v];[v][1:v]overlay=x=${crop.cropX}:y=${crop.cropY}:eof_action=repeat`,
        );
      } else {
        args.push('-vf', srcChain.join(','));
      }
      args.push(
        // crf 18 = visually lossless (vs the source's own compression); we are not
        // re-crushing the footage. ultrafast keeps it fast at the cost of a larger
        // file, which is the point — "not compressed".
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-r', String(fps),
        ...(trimmed ? ['-t', spanSec.toFixed(3)] : []),
        '-movflags', '+faststart',
        'out.mp4',
      );
      await ff.exec(args);
      if (cancelled) return null;

      onStatus?.('Saving…');
      const data = await ff.readFile('out.mp4');
      return new Blob([data.buffer], { type: 'video/mp4' });
    } finally {
      ff.off('progress', onLogProgress);
      if (onLog) ff.off('log', onLog);
      // If the instance was terminated by cancel(), it's already gone.
      if (ffmpeg) { try { await cleanup(ff, overlayCount); } catch (_) {} }
    }
  }

  function cancel() {
    if (!running) return;
    cancelled = true;
    // terminate() hard-aborts an in-flight exec; the instance is then dead.
    try { ffmpeg?.terminate(); } catch (_) {}
    ffmpeg = null;
  }

  // ── App entry point ───────────────────────────────────────────────────────

  function setStatus(text) {
    const el = document.getElementById('export-status-text');
    if (el) el.textContent = text;
  }
  function setProgress(frac) {
    const bar = document.getElementById('export-progress-bar');
    if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
    setStatus(`Encoding… ${Math.round(frac * 100)}%`);
  }
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function start() {
    const videoEl   = document.getElementById('main-video');
    const overlayEl = document.getElementById('time-overlay');
    const progressEl = document.getElementById('export-progress');
    if (!videoEl?.videoWidth) { alert('No video loaded.'); return; }
    if (!sourceFile)          { alert('Original file unavailable — reload the video and try again.'); return; }
    if (running)              { alert('Export already in progress.'); return; }

    const laps = Laps.getLaps();
    if (laps.length === 0 && !confirm('No laps marked — export anyway?')) return;
    const fastestIds = VideoPlayer.getFastestIds();
    const { total: fastTotal } = Laps.getFastestGroup();
    const groupSize  = parseInt(document.getElementById('group-size').value, 10) || 3;

    // Compute overlay geometry once, with the overlay element visible.
    const overlayWasHidden = overlayEl.classList.contains('hidden');
    if (overlayWasHidden) overlayEl.classList.remove('hidden');
    const geom = OverlayRender.overlayGeometry(videoEl, overlayEl);
    if (overlayWasHidden) overlayEl.classList.add('hidden');

    const durationSec = VideoPlayer.getDurationSec?.() || videoEl.duration || 0;

    // Clip trim from the timeline (absolute file seconds). Full range → no cut.
    const trim = (typeof Timeline !== 'undefined' && Timeline.getTrim) ? Timeline.getTrim() : null;
    const trimStart = (trim && trim.isTrimmed) ? trim.startSec : 0;
    const trimEnd   = (trim && trim.isTrimmed) ? trim.endSec   : durationSec;

    // Output resolution: 'source' keeps native; 1080/2160 upscale. Never downscale
    // below source — picking a target taller than the source just keeps source.
    const resSel = document.getElementById('export-resolution');
    const reqH   = resSel && resSel.value !== 'source' ? parseInt(resSel.value, 10) : null;
    const targetHeight = (reqH && reqH > videoEl.videoHeight) ? reqH : null;

    running = true;
    progressEl?.classList.remove('hidden');
    progressEl?.classList.add('ffmpeg-mode');
    setProgress(0);

    try {
      const blob = await run({
        sourceFile, laps, fastestIds, fastTotal, groupSize, geom,
        width: videoEl.videoWidth, height: videoEl.videoHeight,
        durationSec, trimStart, trimEnd,
        overlayFps: 30,
        targetHeight,
        onStatus: setStatus,
        onProgress: setProgress,
      });
      if (blob) {
        setStatus('Done — downloading…');
        triggerDownload(blob, `${sourceBaseName() || 'race'}-overlay.mp4`);
      } else {
        setStatus('Cancelled.');
      }
    } catch (err) {
      if (!cancelled) {
        setStatus(`Error: ${err.message}`);
        console.error('[ExportFfmpeg]', err);
      }
    } finally {
      running = false;
      progressEl?.classList.add('hidden');
      progressEl?.classList.remove('ffmpeg-mode');
    }
  }

  return { start, cancel, setSource, sourceBaseName, run, load };
})();
