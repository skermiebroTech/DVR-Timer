/* ============================================================
   export-video.js — Record video + timer overlay to a file
   ============================================================ */

const ExportVideo = (() => {
  function fmtMs(s) {
    if (s == null || isNaN(s) || !isFinite(s)) return '--:--.---';
    // Integer-ms math so rounding carries into seconds (29.9995 → 0:30.000).
    const total = Math.round(s * 1000);
    const ms    = total % 1000;
    const secs  = Math.floor(total / 1000);
    const m     = Math.floor(secs / 60);
    return `${m}:${String(secs % 60).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
  }

  function fmtParts(s) {
    if (s == null || isNaN(s)) return { main: '--:--', frac: '.---' };
    const total = Math.round(s * 1000);
    const ms    = total % 1000;
    const secs  = Math.floor(total / 1000);
    return {
      main: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2,'0')}`,
      frac: `.${String(ms).padStart(3,'0')}`,
    };
  }

  function getActiveLapIdx(laps, t) {
    for (let i = 0; i < laps.length; i++) {
      const l = laps[i];
      if (t >= l.startTime && (l.endTime == null || t < l.endTime)) return i;
    }
    return -1;
  }

  // Actual rendered content rect of the video (accounting for object-fit: contain)
  function videoContentRect(videoEl) {
    const vW = videoEl.videoWidth;
    const vH = videoEl.videoHeight;
    const r  = videoEl.getBoundingClientRect();
    if (!vW || !vH) return r;
    const vAspect = vW / vH;
    const eAspect = r.width / r.height;
    let cW, cH, cX, cY;
    if (vAspect > eAspect) {
      cW = r.width;  cH = r.width / vAspect;
      cX = r.left;   cY = r.top + (r.height - cH) / 2;
    } else {
      cH = r.height; cW = r.height * vAspect;
      cX = r.left + (r.width - cW) / 2; cY = r.top;
    }
    return { left: cX, top: cY, width: cW, height: cH };
  }

  function drawOverlay(ctx, videoEl, overlayEl, t, laps, fastestIds, groupSize, fastTotal) {
    if (!overlayEl || overlayEl.classList.contains('hidden') || laps.length === 0) return;

    const vW     = videoEl.videoWidth;
    const vH     = videoEl.videoHeight;
    const cRect  = videoContentRect(videoEl);
    const wRect  = overlayEl.parentElement.getBoundingClientRect();

    const oLeft  = parseFloat(overlayEl.style.left) || 12;
    const oTop   = parseFloat(overlayEl.style.top)  || 12;
    const scaleX = vW / cRect.width;
    const scaleY = vH / cRect.height;
    const scale  = (scaleX + scaleY) / 2;

    const cx = (wRect.left + oLeft - cRect.left) * scaleX;
    const cy = (wRect.top  + oTop  - cRect.top)  * scaleY;
    const fs = (parseFloat(overlayEl.style.fontSize) || 14) * scale;

    const raceT = Math.max(0, t - laps[0].startTime);
    const { main, frac } = fmtParts(raceT);

    const activeIdx = getActiveLapIdx(laps, t);
    const visible   = [];
    for (let i = 0; i < laps.length; i++) {
      const lap = laps[i];
      const isCurrent = i === activeIdx;
      if (isCurrent || (lap.endTime != null && t >= lap.endTime)) {
        visible.push({ lap, idx: i, isCurrent });
      }
    }
    const rows       = visible.slice(-5).reverse();
    const hasFastest = fastestIds && fastestIds.size > 0 && fastTotal != null;

    const mainFs  = fs * 2.8;
    const fracFs  = fs * 1.65;
    const numFs   = fs * 0.88;
    const splitFs = fs * 1.1;
    const fastFs  = fs * 0.9;
    const lineH   = splitFs * 1.6;
    const padX    = fs * 0.8;
    const padYT   = fs * 0.35;
    const padYB   = fs * 0.35;

    ctx.save();

    // Measure box width
    ctx.font = `bold ${mainFs}px "Courier New",monospace`;
    const mainW = ctx.measureText(main).width;
    ctx.font = `bold ${fracFs}px "Courier New",monospace`;
    let boxW = mainW + ctx.measureText(frac).width + padX * 2;

    rows.forEach(({ lap, idx, isCurrent }) => {
      const dur = isCurrent ? Math.max(0, t - lap.startTime) : lap.endTime - lap.startTime;
      ctx.font = `bold ${numFs}px "Courier New",monospace`;
      const nw = ctx.measureText(`L${idx + 1}`).width;
      ctx.font = `bold ${splitFs}px "Courier New",monospace`;
      const rowW = nw + ctx.measureText(fmtMs(dur)).width + fs * 0.6 + padX * 2;
      if (rowW > boxW) boxW = rowW;
    });
    if (hasFastest) {
      ctx.font = `bold ${fastFs}px "Courier New",monospace`;
      const fw = ctx.measureText(`Best ${groupSize}: ${fmtMs(fastTotal)}`).width + padX * 2;
      if (fw > boxW) boxW = fw;
    }

    const mainRowH = mainFs * 1.05;
    const splitsH  = rows.length > 0 ? rows.length * lineH + padYT : 0;
    const fastRowH = hasFastest ? fastFs * 2 : 0;
    const boxH     = padYT + mainRowH + splitsH + fastRowH + padYB;

    // Background
    ctx.fillStyle = 'rgba(6,7,10,0.90)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cx, cy, boxW, boxH, 2);
    else ctx.rect(cx, cy, boxW, boxH);
    ctx.fill();

    // Left green border
    ctx.fillStyle = '#00e060';
    ctx.fillRect(cx, cy, Math.max(3, 3 * scaleX), boxH);

    // Main time
    const baseX = cx + padX;
    let curY = cy + padYT + mainFs * 0.88;

    ctx.font        = `bold ${mainFs}px "Courier New",monospace`;
    ctx.fillStyle   = '#ffffff';
    ctx.shadowColor = 'rgba(0,230,96,0.25)';
    ctx.shadowBlur  = mainFs * 0.3;
    ctx.fillText(main, baseX, curY);
    ctx.shadowBlur  = 0;

    ctx.font = `bold ${mainFs}px "Courier New",monospace`;
    const mainTextW = ctx.measureText(main).width;
    ctx.font      = `bold ${fracFs}px "Courier New",monospace`;
    ctx.fillStyle = 'rgba(195,210,220,0.70)';
    ctx.fillText(frac, baseX + mainTextW, curY);

    curY += mainRowH * 0.17;

    // Splits
    if (rows.length > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = Math.max(1, scaleX * 0.5);
      ctx.beginPath(); ctx.moveTo(cx, curY); ctx.lineTo(cx + boxW, curY); ctx.stroke();
      curY += padYT;

      rows.forEach(({ lap, idx, isCurrent }) => {
        const dur       = isCurrent ? Math.max(0, t - lap.startTime) : lap.endTime - lap.startTime;
        const isFastest = fastestIds && fastestIds.has(lap.id);
        curY += lineH;

        ctx.font      = `bold ${numFs}px "Courier New",monospace`;
        ctx.fillStyle = isFastest ? 'rgba(0,224,96,0.7)'
                      : isCurrent ? 'rgba(255,225,70,0.65)'
                      : 'rgba(130,148,165,0.65)';
        ctx.fillText(`L${idx + 1}`, baseX, curY);
        const nw = ctx.measureText(`L${idx + 1}`).width;

        ctx.font = `bold ${splitFs}px "Courier New",monospace`;
        if (isFastest) {
          ctx.fillStyle   = '#00e060';
          ctx.shadowColor = 'rgba(0,224,96,0.85)';
          ctx.shadowBlur  = splitFs * 0.4;
        } else {
          ctx.fillStyle = isCurrent ? '#ffe040' : 'rgba(195,212,225,0.88)';
        }
        ctx.fillText(fmtMs(dur), baseX + nw + fs * 0.5, curY);
        ctx.shadowBlur = 0;
      });
    }

    // Best N row
    if (hasFastest) {
      curY += padYT;
      ctx.strokeStyle = 'rgba(0,224,96,0.25)';
      ctx.lineWidth   = Math.max(1, scaleX * 0.5);
      ctx.beginPath(); ctx.moveTo(cx, curY); ctx.lineTo(cx + boxW, curY); ctx.stroke();

      curY += fastFs * 1.2;
      ctx.font        = `bold ${fastFs}px "Courier New",monospace`;
      ctx.fillStyle   = '#00e060';
      ctx.shadowColor = 'rgba(0,224,96,0.9)';
      ctx.shadowBlur  = fastFs * 0.5;
      ctx.fillText(`Best ${groupSize}: ${fmtMs(fastTotal)}`, baseX, curY);
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

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

  // Seconds of media buffered ahead of the playhead. For a .ts via mpegts.js
  // this is the SourceBuffer range; at high playback rates it shrinks fast.
  function bufferedAhead(v) {
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.currentTime >= v.buffered.start(i) - 0.25 && v.currentTime <= v.buffered.end(i) + 0.25) {
        return v.buffered.end(i) - v.currentTime;
      }
    }
    return 0;
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

  async function fastPath(videoEl, canvas, draw, progressEl, config) {
    setStatus('Loading encoder (first time only)…');
    const { Muxer, ArrayBufferTarget } = await import(
      'https://unpkg.com/webm-muxer@5.1.4/build/webm-muxer.mjs'
    );

    const target = new ArrayBufferTarget();
    const muxer  = new Muxer({
      target,
      video: { codec: 'V_VP9', width: canvas.width, height: canvas.height },
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
    let rateIdx = 0, stallStreak = 0;
    videoEl.playbackRate = RATE_STEPS[0];
    setStatus(`Encoding at ${RATE_STEPS[0]}× speed…`);
    watchdog = setInterval(() => {
      if (stopped || videoEl.paused) { stallStreak = 0; return; }
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
      async function onFrame(_, { mediaTime }) {
        if (stopped) { resolve(); return; }
        draw(mediaTime);
        const vf = new VideoFrame(canvas, { timestamp: Math.round(mediaTime * 1_000_000) });
        try {
          encoder.encode(vf, { keyFrame: n++ % 150 === 0 });
        } finally {
          vf.close(); // always close, even if encode() throws
        }
        if (videoEl.ended) { resolve(); return; }

        // Pace the capture. At 4× a .ts drains mpegts's lazy buffer faster than
        // it can reload, and a slow encoder lets its queue grow without bound —
        // either stalls playback for seconds (the "freeze"). When the buffer
        // runs low or the encoder falls behind, pause and let them catch up.
        if (encoder.encodeQueueSize > 8 || bufferedAhead(videoEl) < 1.5) {
          videoEl.pause();
          const t0 = performance.now();
          while (!stopped &&
                 (encoder.encodeQueueSize > 2 || bufferedAhead(videoEl) < 4) &&
                 performance.now() - t0 < 4000) {        // cap so EOF can't deadlock
            await new Promise(r => setTimeout(r, 25));
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

  function slowPath(videoEl, canvas, draw, progressEl) {
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

    const canvas = document.createElement('canvas');
    canvas.width  = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const draw = t => {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      drawOverlay(ctx, videoEl, overlayEl, t + timeOffset, laps, fastestIds, groupSize, fastTotal);
    };

    // "Export w/ Overlay" must include the overlay even when the on-screen
    // toggle is off. drawOverlay reads the element's live geometry, so the
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

    // Assigning currentTime its existing value fires no 'seeked' event, so an
    // unconditional await would hang forever when the video is already at 0
    // (e.g. exporting right after load). Only wait when a real seek happens.
    if (videoEl.currentTime > 0.01) {
      const seeked = new Promise(r => videoEl.addEventListener('seeked', r, { once: true }));
      videoEl.currentTime = 0;
      await seeked;
    }

    try {
      if (cancelledDuringRewind) return;

      const canFast  = window.VideoEncoder && videoEl.requestVideoFrameCallback;
      const fastCfg  = canFast ? await supportedFastConfig(canvas) : null;
      if (fastCfg) await fastPath(videoEl, canvas, draw, progressEl, fastCfg);
      else         await slowPath(videoEl, canvas, draw, progressEl);
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
