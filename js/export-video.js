/* ============================================================
   export-video.js — Record video + timer overlay to a file (WebCodecs path)
   ============================================================

   Captures the on-screen player frame-by-frame and burns in the race-timer
   overlay, encoding to WebM via WebCodecs (hardware VP9, up to 4× realtime) or
   MediaRecorder (1× fallback). The overlay itself is drawn by the shared
   OverlayRender module so it stays identical to the ffmpeg export path.

   For a player-free, background export to H.264 MP4 see export-ffmpeg.js.
   ============================================================ */

const ExportVideo = (() => {
  // ── Helpers ───────────────────────────────────────────────

  function setStatus(text) {
    const el = document.getElementById('export-status-text');
    if (el) el.textContent = text;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ── Fast path: WebCodecs + webm-muxer (hardware VP9, 4× realtime) ─────────

  // Pick a VP9 level that fits the resolution, then confirm the encoder
  // actually supports the config before committing to the fast path.
  // (vp09.00.10.08 = level 1.0 only covers tiny frames and is rejected for HD.)
  async function supportedFastConfig(canvas) {
    if (!window.VideoEncoder || !VideoEncoder.isConfigSupported) return null;
    const h = canvas.height;
    const level = h <= 480 ? '21' : h <= 720 ? '31' : h <= 1080 ? '41'
                : h <= 1440 ? '50' : '51';
    // No hardwareAcceleration hint: 'prefer-hardware' makes isConfigSupported
    // report false on machines without a hardware VP9 encoder, which would
    // wrongly force the slow path. The default uses hardware when available
    // and transparently falls back to software otherwise.
    const config = {
      codec:  `vp09.00.${level}.08`,
      width:  canvas.width,
      height: canvas.height,
      bitrate: 40_000_000,
    };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      return supported ? config : null;
    } catch {
      return null;
    }
  }

  async function fastPath(videoEl, canvas, draw, progressEl, config, stopAt) {
    setStatus('Loading encoder (first time only)…');
    const { Muxer, ArrayBufferTarget } = await import(
      'https://unpkg.com/webm-muxer@5.1.4/build/webm-muxer.mjs'
    );

    const target = new ArrayBufferTarget();
    const muxer  = new Muxer({
      target,
      video: { codec: 'V_VP9', width: canvas.width, height: canvas.height },
      // Capture starts mid-stream (the playhead has advanced past 0 by the time
      // the first frame is encoded), so the first chunk's timestamp isn't 0.
      // 'offset' rebases timestamps to start at 0; the default 'strict' throws on
      // every chunk, flooding errors and freezing the tab.
      firstTimestampBehavior: 'offset',
    });

    let encodeErr = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error:  e => { encodeErr = e; },
    });
    encoder.configure(config);

    let stopped = false, n = 0, watchdog = null;

    cancelExport = () => {
      stopped = true;
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      videoEl.pause();
      videoEl.playbackRate = 1;
      if (encoder.state !== 'closed') encoder.close();
      progressEl?.classList.add('hidden');
      cancelExport = null;
    };

    // Adaptive speed: 4× is too fast to *decode* high-fps footage (90 fps × 4 =
    // 360 fps) on many machines, so playback stalls and the export appears
    // frozen. A watchdog watches readyState and steps the rate down until
    // playback is sustainable — guaranteeing progress on any footage/hardware.
    const RATE_STEPS = [4, 3, 2, 1.5, 1];
    let rateIdx = 0, stallStreak = 0, lastCt = -1, stuckStreak = 0;
    let finishLoop = null;
    videoEl.playbackRate = RATE_STEPS[0];
    setStatus(`Encoding at ${RATE_STEPS[0]}× speed…`);
    watchdog = setInterval(() => {
      if (stopped || videoEl.paused) { stallStreak = 0; stuckStreak = 0; lastCt = videoEl.currentTime; return; }
      // EOF fallback: mpegts.js doesn't reliably fire 'ended' at the end of a
      // sub-blob, so the playhead can stick on the last frame forever. If it
      // hasn't advanced for ~2.8 s while playing, treat it as done and finalize.
      if (Math.abs(videoEl.currentTime - lastCt) < 0.02) {
        if (++stuckStreak >= 4 && finishLoop) { finishLoop(); return; }
      } else {
        stuckStreak = 0;
      }
      lastCt = videoEl.currentTime;
      if (videoEl.readyState <= 2) {                 // stalled: not enough decoded
        if (++stallStreak >= 2 && rateIdx < RATE_STEPS.length - 1) {
          videoEl.playbackRate = RATE_STEPS[++rateIdx];
          setStatus(`Encoding at ${RATE_STEPS[rateIdx]}× speed…`);
          stallStreak = 0;
        }
      } else {
        stallStreak = 0;
      }
    }, 700);

    await new Promise(resolve => {
      finishLoop = resolve;
      async function onFrame(_, { mediaTime }) {
        if (stopped) { resolve(); return; }
        // Reached the clip out-point — stop before encoding past it.
        if (mediaTime > stopAt) { resolve(); return; }
        draw(mediaTime);
        const vf = new VideoFrame(canvas, { timestamp: Math.round(mediaTime * 1_000_000) });
        try {
          encoder.encode(vf, { keyFrame: n++ % 150 === 0 });
        } finally {
          vf.close(); // always close, even if encode() throws
        }
        if (videoEl.ended) { resolve(); return; }

        // Encoder backpressure: if encoding falls behind, pause capture until the
        // queue drains so it can't grow without bound (memory) and freeze the tab.
        // Buffer starvation is handled separately by the rate watchdog (a starved
        // buffer drops readyState, which steps the speed down). The queue drains
        // quickly, so this never stalls near EOF.
        if (encoder.encodeQueueSize > 8) {
          videoEl.pause();
          while (!stopped && encoder.encodeQueueSize > 2) {
            await new Promise(r => setTimeout(r, 20));
          }
          if (stopped) { resolve(); return; }
          try { await videoEl.play(); } catch (_) {}
        }

        if (videoEl.ended) resolve();
        else if (!stopped) videoEl.requestVideoFrameCallback(onFrame);
      }
      videoEl.addEventListener('ended', resolve, { once: true });
      videoEl.requestVideoFrameCallback(onFrame);
      videoEl.play();
    });

    // Seal the loop BEFORE cleanup: microtasks (this code) run before the next
    // rVFC macrotask, so any pending callback will see stopped=true and abort.
    const wasCancelled = stopped;
    stopped = true;
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    videoEl.pause();
    videoEl.playbackRate = 1;
    cancelExport = null;
    if (wasCancelled) return;
    if (encodeErr) throw encodeErr;

    setStatus('Saving…');
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    triggerDownload(new Blob([target.buffer], { type: 'video/webm' }), 'race-overlay.webm');
    progressEl?.classList.add('hidden');
  }

  // ── Slow path: MediaRecorder, 1× realtime fallback ────────────────────────

  function slowPath(videoEl, canvas, draw, progressEl, stopAt) {
    // captureStream(120) auto-captures whenever the canvas changes (up to 120 fps)
    const stream   = canvas.captureStream(120);
    const recorder = new MediaRecorder(stream, { videoBitsPerSecond: 40_000_000 });
    const chunks   = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    let stopped = false;
    const stopRec = () => {
      if (stopped) return;
      stopped = true;
      if (recorder.state !== 'inactive') recorder.stop();
    };

    cancelExport = () => {
      recorder.onstop = null;
      stopRec();
      videoEl.pause();
      progressEl?.classList.add('hidden');
      cancelExport = null;
    };

    return new Promise(resolve => {
      recorder.onstop = () => {
        progressEl?.classList.add('hidden');
        cancelExport = null;
        if (chunks.length) {
          const mime = recorder.mimeType || 'video/webm';
          triggerDownload(new Blob(chunks, { type: mime }),
            `race-overlay.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
        }
        resolve();
      };

      setStatus('Recording at 1× speed…');
      recorder.start(500);

      function loop() {
        if (videoEl.currentTime > stopAt) { stopRec(); return; }
        draw(videoEl.currentTime);
        if (videoEl.ended) { stopRec(); return; }
        videoEl.requestVideoFrameCallback
          ? videoEl.requestVideoFrameCallback(loop)
          : requestAnimationFrame(loop);
      }
      videoEl.requestVideoFrameCallback
        ? videoEl.requestVideoFrameCallback(loop)
        : requestAnimationFrame(loop);

      videoEl.addEventListener('ended', stopRec, { once: true });
      videoEl.play();
    });
  }

  // ── Export entry point ─────────────────────────────────────────────────────

  let cancelExport = null;

  function cancel() {
    if (cancelExport) cancelExport();
  }

  async function start() {
    const videoEl   = document.getElementById('main-video');
    const overlayEl = document.getElementById('time-overlay');
    if (!videoEl?.videoWidth) { alert('No video loaded.'); return; }
    if (cancelExport)         { alert('Export already in progress.'); return; }

    const progressEl = document.getElementById('export-progress');
    const laps       = Laps.getLaps();
    const fastestIds = VideoPlayer.getFastestIds();
    const timeOffset = VideoPlayer.getTimeOffset();
    const { total: fastTotal } = Laps.getFastestGroup();
    const groupSize  = parseInt(document.getElementById('group-size').value, 10) || 3;

    // Clip trim. Only honoured for native playback (player time == file time);
    // for .ts the player holds a sub-blob window, so trimming there is the
    // background MP4 export's job (export-ffmpeg.js).
    const trim     = (typeof Timeline !== 'undefined' && Timeline.getTrim) ? Timeline.getTrim() : null;
    const applyTrim = !!(trim && trim.isTrimmed && timeOffset === 0);
    const startAt  = applyTrim ? trim.startSec : 0;
    const stopAt   = applyTrim ? trim.endSec   : Infinity;

    const canvas = document.createElement('canvas');
    canvas.width  = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Geometry is computed lazily on the first draw — by then the overlay has been
    // un-hidden below, so its element reports a real (non-zero) rect.
    let geom = null;
    const draw = t => {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      if (!geom) geom = OverlayRender.overlayGeometry(videoEl, overlayEl);
      OverlayRender.drawOverlay(ctx, geom, t + timeOffset, laps, fastestIds, groupSize, fastTotal);
    };

    // "Export w/ Overlay" must include the overlay even when the on-screen
    // toggle is off. overlayGeometry reads the element's live geometry, so the
    // element has to be visible (display:none reports a zero-size rect).
    const overlayWasHidden = overlayEl.classList.contains('hidden');
    if (overlayWasHidden) overlayEl.classList.remove('hidden');

    // Placeholder canceller so a click during "Rewinding…" is honoured before
    // fastPath/slowPath install their own.
    let cancelledDuringRewind = false;
    cancelExport = () => {
      cancelledDuringRewind = true;
      videoEl.pause();
      progressEl?.classList.add('hidden');
      cancelExport = null;
    };

    progressEl?.classList.remove('hidden');
    setStatus('Rewinding…');
    videoEl.pause();

    // Seek to the clip in-point (0 when untrimmed). Assigning currentTime its
    // existing value fires no 'seeked' event, so an unconditional await would
    // hang forever — only wait when a real seek happens.
    if (Math.abs(videoEl.currentTime - startAt) > 0.01) {
      const seeked = new Promise(r => videoEl.addEventListener('seeked', r, { once: true }));
      videoEl.currentTime = startAt;
      await seeked;
    }

    try {
      if (cancelledDuringRewind) return;

      const canFast  = window.VideoEncoder && videoEl.requestVideoFrameCallback;
      const fastCfg  = canFast ? await supportedFastConfig(canvas) : null;
      if (fastCfg) await fastPath(videoEl, canvas, draw, progressEl, fastCfg, stopAt);
      else         await slowPath(videoEl, canvas, draw, progressEl, stopAt);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      console.error('[ExportVideo]', err);
      progressEl?.classList.add('hidden');
    } finally {
      cancelExport = null;
      videoEl.playbackRate = 1;
      if (overlayWasHidden) overlayEl.classList.add('hidden');
    }
  }

  return { start, cancel };
})();
