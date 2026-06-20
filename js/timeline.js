/* ============================================================
   timeline.js — Thumbnail filmstrip + clip trimming
   ============================================================

   Renders a strip of screenshots across the whole video plus two draggable
   in/out handles. Dragging the handles (or pressing [ and ]) defines a sub-range
   — the "clip" — that the export paths read via getTrim() and cut to. Clicking
   the strip seeks; a red playhead tracks the current time.

   Thumbnails come from one of two sources:
     • Native files (mp4/webm/mkv/mov): a throwaway offscreen <video> is seeked
       across the duration and each frame drawn to a tiny canvas — the whole
       strip fills in up front without touching the on-screen player.
     • .ts files (HDZero): an offscreen <video> can't decode them, so the cells
       fill in progressively from the live player as the user scrubs/plays.

   Trim state is stored as fractions of the duration (0..1) so it survives the
   .ts case where the exact duration is parsed asynchronously after load.
   ============================================================ */

const Timeline = (() => {
  const THUMB_W = 160;           // offscreen thumbnail width (height follows aspect)

  let timelineEl, trackEl, stripEl, shadeLeft, shadeRight, regionEl;
  let handleLeft, handleRight, playheadEl, rangeLabel, resetBtn, videoEl;
  let durationProvider = () => 0;

  let slots   = [];              // [{ el, filled }]
  let mode    = 'idle';          // 'idle' | 'native' | 'progressive'
  let genToken = 0;              // bumped on each load to cancel stale thumbnail jobs
  let drag    = null;            // 'left' | 'right' while dragging a handle

  let trimStart = 0;             // in-point  as a fraction of duration
  let trimEnd   = 1;             // out-point as a fraction of duration

  let thumbCanvas = null, thumbCtx = null;

  const byId = (id) => document.getElementById(id);

  function fmt(s) {
    if (s == null || isNaN(s) || !isFinite(s)) return '--:--.---';
    const total = Math.round(s * 1000);
    const ms    = total % 1000;
    const secs  = Math.floor(total / 1000);
    const m     = Math.floor(secs / 60);
    return `${m}:${String(secs % 60).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  // Smallest allowed gap between handles, in fraction units (≈0.4s, never < laps
  // need but enough to keep the region grabbable on short clips).
  function minGap() {
    const d = durationProvider();
    if (!d) return 0.02;
    return Math.max(0.005, Math.min(0.5, 0.4 / d));
  }

  // ── Thumbnails ──────────────────────────────────────────────────────────────

  function pickCount() {
    const w = (trackEl && trackEl.clientWidth) || 900;
    return Math.max(6, Math.min(18, Math.round(w / 90)));
  }

  function buildSlots(count) {
    slots = [];
    stripEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'tl-cell';
      stripEl.appendChild(el);
      slots.push({ el, filled: false });
    }
  }

  function ensureCanvas(vW, vH) {
    if (!thumbCanvas) {
      thumbCanvas = document.createElement('canvas');
      thumbCtx = thumbCanvas.getContext('2d');
    }
    const W = THUMB_W;
    const H = Math.max(1, Math.round(W * (vH / vW)));
    if (thumbCanvas.width !== W || thumbCanvas.height !== H) {
      thumbCanvas.width = W;
      thumbCanvas.height = H;
    }
  }

  // Draw a video element's current frame into one strip cell as a JPEG data URL.
  function drawCell(cell, vEl) {
    if (!vEl || !vEl.videoWidth) return;
    try {
      ensureCanvas(vEl.videoWidth, vEl.videoHeight);
      thumbCtx.drawImage(vEl, 0, 0, thumbCanvas.width, thumbCanvas.height);
      cell.el.style.backgroundImage = `url("${thumbCanvas.toDataURL('image/jpeg', 0.6)}")`;
      cell.el.classList.add('filled');
      cell.filled = true;
    } catch (_) { /* drawImage throws if the frame isn't decodable yet — skip */ }
  }

  function waitEvent(el, name, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const on = () => { if (done) return; done = true; el.removeEventListener(name, on); resolve(); };
      el.addEventListener(name, on, { once: true });
      if (timeoutMs) setTimeout(on, timeoutMs);
    });
  }

  // Fill the whole strip up front from a throwaway offscreen <video>. Falls back
  // to progressive mode if the browser can't decode the file off-player.
  async function generateThumbsNative(file, token) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    const cleanup = () => {
      try { v.removeAttribute('src'); v.load(); } catch (_) {}
      URL.revokeObjectURL(url);
    };
    try {
      await waitEvent(v, 'loadedmetadata', 8000);
      const d = v.duration;
      if (!isFinite(d) || d <= 0) throw new Error('no finite duration');
      for (let i = 0; i < slots.length; i++) {
        if (token !== genToken) return;        // superseded by a newer load
        const cell = slots[i];
        if (cell.filled) continue;
        const target = ((i + 0.5) / slots.length) * d;
        v.currentTime = Math.max(0, Math.min(d - 0.01, target));
        await waitEvent(v, 'seeked', 3000);
        if (token !== genToken) return;
        drawCell(cell, v);
      }
    } catch (_) {
      if (token === genToken) mode = 'progressive'; // let the live player fill it in
    } finally {
      cleanup();
    }
  }

  // Live-player fallback: when the playhead enters an empty cell's time window and
  // the player has a frame ready, grab it. Each cell is captured at most once.
  function captureProgressive(t, d) {
    if (!d || !slots.length) return;
    const idx = Math.min(slots.length - 1, Math.max(0, Math.floor((t / d) * slots.length)));
    const cell = slots[idx];
    if (!cell || cell.filled) return;
    if (!videoEl || !videoEl.videoWidth || videoEl.readyState < 2) return;
    drawCell(cell, videoEl);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!trackEl) return;
    const sP = trimStart * 100, eP = trimEnd * 100;
    shadeLeft.style.width  = sP + '%';
    shadeRight.style.width = (100 - eP) + '%';
    regionEl.style.left    = sP + '%';
    regionEl.style.width   = (eP - sP) + '%';
    handleLeft.style.left  = sP + '%';
    handleRight.style.left = eP + '%';
    updateLabel();
    updateResetState();
  }

  function updateLabel() {
    if (!rangeLabel) return;
    const d = durationProvider();
    if (!d) { rangeLabel.textContent = 'Clip: full length'; return; }
    if (trimStart <= 0.001 && trimEnd >= 0.999) {
      rangeLabel.textContent = `Clip: full length (${fmt(d)})`;
    } else {
      const a = d * trimStart, b = d * trimEnd;
      rangeLabel.textContent = `Clip: ${fmt(a)} → ${fmt(b)}  ·  ${fmt(b - a)}`;
    }
  }

  function isTrimmed() { return trimStart > 0.001 || trimEnd < 0.999; }

  function updateResetState() {
    if (resetBtn) resetBtn.disabled = !isTrimmed();
  }

  // ── Pointer interaction ─────────────────────────────────────────────────────

  function fracFromClientX(x) {
    const r = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width));
  }

  function seekFrac(f) {
    const d = durationProvider();
    if (d && typeof VideoPlayer !== 'undefined' && VideoPlayer.seekTo) VideoPlayer.seekTo(f * d);
  }

  function startHandleDrag(which, e) {
    e.preventDefault();
    e.stopPropagation();
    drag = which;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
  }

  function onDragMove(e) {
    if (!drag) return;
    const f = fracFromClientX(e.clientX);
    const gap = minGap();
    if (drag === 'left') trimStart = Math.max(0, Math.min(f, trimEnd - gap));
    else                 trimEnd   = Math.min(1, Math.max(f, trimStart + gap));
    render();
  }

  function onDragEnd() {
    const which = drag;
    drag = null;
    window.removeEventListener('pointermove', onDragMove);
    // Park the playhead on the boundary frame the user just set.
    seekFrac(which === 'left' ? trimStart : trimEnd);
  }

  // Clicking the strip (anywhere but a handle) seeks there.
  function onTrackSeek(e) {
    if (drag) return;
    if (e.target.closest && e.target.closest('.tl-handle')) return;
    const f = fracFromClientX(e.clientX);
    if (playheadEl) playheadEl.style.left = (f * 100) + '%';
    seekFrac(f);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  // Called every frame from the player to move the playhead and (in progressive
  // mode) opportunistically fill thumbnail cells.
  function onTimeUpdate(t, dur) {
    const d = dur || durationProvider();
    if (d && playheadEl) {
      playheadEl.style.left = (Math.max(0, Math.min(1, t / d)) * 100) + '%';
    }
    if (mode === 'progressive') captureProgressive(t, d);
    updateLabel(); // refresh once the async .ts duration lands
  }

  function setInToCurrent() {
    const d = durationProvider();
    if (!d) return;
    const t = (typeof VideoPlayer !== 'undefined' && VideoPlayer.getCurrentTime) ? VideoPlayer.getCurrentTime() : 0;
    const f = Math.max(0, Math.min(1, t / d));
    trimStart = Math.max(0, Math.min(f, trimEnd - minGap()));
    render();
  }

  function setOutToCurrent() {
    const d = durationProvider();
    if (!d) return;
    const t = (typeof VideoPlayer !== 'undefined' && VideoPlayer.getCurrentTime) ? VideoPlayer.getCurrentTime() : 0;
    const f = Math.max(0, Math.min(1, t / d));
    trimEnd = Math.min(1, Math.max(f, trimStart + minGap()));
    render();
  }

  function resetTrim() {
    trimStart = 0;
    trimEnd = 1;
    render();
  }

  // Returns the current clip range. startSec/endSec are absolute file times;
  // isTrimmed is false when the handles still span the whole video.
  function getTrim() {
    const d = durationProvider() || 0;
    return {
      startSec: d * trimStart,
      endSec:   d * trimEnd,
      startFrac: trimStart,
      endFrac:   trimEnd,
      isTrimmed: isTrimmed(),
    };
  }

  // Start a fresh filmstrip for a newly loaded file.
  function load(file) {
    if (!trackEl || !file) return;
    genToken++;
    const token = genToken;
    trimStart = 0;
    trimEnd = 1;
    buildSlots(pickCount());
    render();
    const isTs = (typeof Transcoder !== 'undefined' && Transcoder.isTsFile && Transcoder.isTsFile(file));
    if (isTs) {
      mode = 'progressive';           // offscreen decode unavailable for .ts
    } else {
      mode = 'native';
      generateThumbsNative(file, token);
    }
  }

  // Clear everything when the video is unloaded ("Change Video").
  function reset() {
    genToken++;
    mode = 'idle';
    trimStart = 0;
    trimEnd = 1;
    slots = [];
    if (stripEl) stripEl.innerHTML = '';
    if (playheadEl) playheadEl.style.left = '0%';
    render();
  }

  function init() {
    timelineEl  = byId('timeline');
    trackEl     = byId('timeline-track');
    stripEl     = byId('timeline-strip');
    shadeLeft   = byId('tl-shade-left');
    shadeRight  = byId('tl-shade-right');
    regionEl    = byId('tl-region');
    handleLeft  = byId('tl-handle-left');
    handleRight = byId('tl-handle-right');
    playheadEl  = byId('tl-playhead');
    rangeLabel  = byId('tl-range-label');
    resetBtn    = byId('btn-trim-reset');
    videoEl     = byId('main-video');
    durationProvider = () =>
      (typeof VideoPlayer !== 'undefined' && VideoPlayer.getDurationSec)
        ? (VideoPlayer.getDurationSec() || 0) : 0;
    if (!trackEl) return;

    handleLeft.addEventListener('pointerdown',  (e) => startHandleDrag('left', e));
    handleRight.addEventListener('pointerdown', (e) => startHandleDrag('right', e));
    trackEl.addEventListener('pointerdown', onTrackSeek);
    if (resetBtn) resetBtn.addEventListener('click', resetTrim);

    render();
  }

  return { init, load, reset, getTrim, onTimeUpdate, setInToCurrent, setOutToCurrent, resetTrim };
})();
