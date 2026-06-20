/* ============================================================
   overlay-render.js — Shared canvas renderer for the race-timer overlay
   ============================================================

   Single source of truth for drawing the LiveSplit-style timer overlay onto
   a canvas. Used by BOTH export paths:
     • export-video.js  — WebCodecs/MediaRecorder, draws overlay over each
       decoded player frame.
     • export-ffmpeg.js — renders the overlay alone (transparent) to an image
       sequence that ffmpeg.wasm composites over the source.

   Keeping one renderer guarantees the burned-in times stay byte-for-byte
   consistent across export methods — the timing precision is the whole point
   of this tool, so the overlay math must never fork.

   Geometry is computed once (overlayGeometry) from the live on-screen player +
   overlay element, then reused for every frame (drawOverlay). Splitting the two
   lets the ffmpeg path render thousands of frames headlessly without touching
   the DOM per frame.
   ============================================================ */

const OverlayRender = (() => {
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

  // Map the on-screen overlay element's position/size into native video pixels.
  // Computed once per export (the overlay doesn't move while encoding), then fed
  // to drawOverlay for every frame. The on-screen video + overlay must be visible
  // (display:none reports a zero-size rect) when this is called.
  function overlayGeometry(videoEl, overlayEl) {
    const vW    = videoEl.videoWidth;
    const vH    = videoEl.videoHeight;
    const cRect = videoContentRect(videoEl);
    const wRect = overlayEl.parentElement.getBoundingClientRect();

    const oLeft  = parseFloat(overlayEl.style.left) || 12;
    const oTop   = parseFloat(overlayEl.style.top)  || 12;
    const scaleX = vW / cRect.width;
    const scaleY = vH / cRect.height;
    const scale  = (scaleX + scaleY) / 2;

    const cx = (wRect.left + oLeft - cRect.left) * scaleX;
    const cy = (wRect.top  + oTop  - cRect.top)  * scaleY;
    const fs = (parseFloat(overlayEl.style.fontSize) || 14) * scale;

    return { cx, cy, fs, scaleX, scaleY, scale };
  }

  // Draw the overlay at race time `t` (already includes any timeOffset) using a
  // precomputed geometry. Does nothing if there are no laps yet. Returns the box
  // rect { x, y, w, h } in native-video pixels (used by the ffmpeg path to crop
  // the overlay image sequence); null when nothing was drawn.
  function drawOverlay(ctx, geom, t, laps, fastestIds, groupSize, fastTotal) {
    if (!geom || !laps || laps.length === 0) return null;

    const { cx, cy, fs, scaleX } = geom;

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
    return { x: cx, y: cy, w: boxW, h: boxH };
  }

  return { overlayGeometry, drawOverlay, fmtMs };
})();
