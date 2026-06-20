/* ============================================================
   video.js — Video player controls and frame stepping
   ============================================================

   Frame stepping note:
   Browsers do not expose a reliable "go to exact frame N" API.
   The requestVideoFrameCallback (rVFC) API exists in Chrome/Edge 83+
   but is not universally supported. As a practical solution we:
     1. Pause the video.
     2. Advance currentTime by one estimated frame duration
        (1 / assumedFPS, default 30 fps).
     3. Use rVFC when available to confirm the frame advanced; otherwise
        rely on the browser to seek to the nearest keyframe or decoded frame.
   This is accurate to ±1 frame in most cases. For highly compressed
   video (large GOP sizes) the browser may snap to the nearest keyframe,
   causing apparent larger jumps. Using lower playback speed and manual
   scrubbing provides maximum precision in those cases.
   ============================================================ */

const VideoPlayer = (() => {
  const ASSUMED_FPS = 30;           // fallback frame rate until real fps is detected
  const SEEK_STEP   = 5;            // seconds for left/right arrow seek
  const SCRUB_STEPS = 1000;         // resolution of the scrub bar

  let video = null;
  let scrubBar = null;
  let currentTimeDisplay = null;
  let durationDisplay = null;
  let overlayEl = null;
  let overlayMainEl = null;
  let overlayFracEl = null;
  let isScrubbing = false;
  let firstFrameShown = false;
  let parsedDuration = null;
  let lapSplits = [];        // mirror of Laps data for overlay rendering
  let fastestIds = new Set(); // IDs of laps in the current fastest group
  let rafId = null;          // requestAnimationFrame handle while playing
  let prevActiveLapIdx = -2; // -2 = uninitialized sentinel; forces first-tick rebuild
  // Real frame duration (seconds). null until detected; stepFrame falls back to
  // 1/ASSUMED_FPS meanwhile. Lets frame stepping move exactly one frame on
  // high-rate footage (e.g. 90 fps HDZero) instead of three.
  let frameDuration       = null;
  let frameDurationLocked = false; // set from an authoritative source (TS PTS)
  let frameSamples        = [];    // rVFC frame-gap samples (native fallback)
  let lastSampleTime      = null;  // previous frame's mediaTime, for delta sampling
  let vfcSamplerId        = null;  // requestVideoFrameCallback handle for the sampler
  // Added to video.currentTime for all display/lap purposes.
  // For .ts sub-blob seeks mpegts.js normalises PTS to ~0 for every new player,
  // so we track how far into the original file we started and add it back.
  let timeOffset = 0;
  // When set, all seek operations go through this instead of setting
  // video.currentTime directly.
  let seekOverride = null;
  // Canvas overlay painted before a TS player rebuild so the old frame stays
  // visible during the black gap while the new player loads.
  let seekCanvas = null;
  // Blob URL for the currently loaded native file, revoked on the next load
  // so swapping (multi-GB) videos doesn't leak memory.
  let objectUrl = null;

  function effectiveDuration() {
    const d = video ? video.duration : null;
    return (d && isFinite(d)) ? d : parsedDuration;
  }

  // The "real" time in the original file — video.currentTime plus any sub-blob offset.
  function actualTime() { return (video ? video.currentTime : 0) + timeOffset; }

  function formatTime(s) {
    if (s == null || isNaN(s) || !isFinite(s)) return '--:--.---';
    // Work in integer ms so rounding carries cleanly (e.g. 29.9995 → 0:30.000,
    // not 0:29.1000). Matches formatTimeParts.
    const total = Math.round(s * 1000);
    const ms    = total % 1000;
    const secs  = Math.floor(total / 1000);
    const m     = Math.floor(secs / 60);
    return `${m}:${String(secs % 60).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
  }

  // Returns the { main, frac } parts for the LiveSplit-style split display.
  function formatTimeParts(s) {
    if (s == null || isNaN(s) || !isFinite(s)) return { main: '--:--', frac: '.---' };
    const total = Math.round(s * 1000); // work in integer ms to avoid float drift
    const ms    = total % 1000;
    const secs  = Math.floor(total / 1000);
    return {
      main: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
      frac: `.${String(ms).padStart(3, '0')}`,
    };
  }

  function setOverlayTime(t) {
    if (!overlayEl || overlayEl.classList.contains('hidden') || !overlayMainEl) return;
    // Race timer: 0:00 at the first lap, counting up from there.
    // Shows --:-- until the first lap is marked.
    if (lapSplits.length === 0) {
      overlayMainEl.textContent = '--:--';
      if (overlayFracEl) overlayFracEl.textContent = '.---';
      return;
    }
    // Clamp to last lap's end time once the race is complete
    const lastLap = lapSplits[lapSplits.length - 1];
    const tClamped = (lastLap.endTime != null && t > lastLap.endTime) ? lastLap.endTime : t;
    const raceT = Math.max(0, tClamped - lapSplits[0].startTime);
    const { main, frac } = formatTimeParts(raceT);
    overlayMainEl.textContent = main;
    if (overlayFracEl) overlayFracEl.textContent = frac;
  }

  function updateTimeDisplays() {
    const t   = actualTime();
    const dur = effectiveDuration();
    if (currentTimeDisplay) currentTimeDisplay.textContent = formatTime(t);
    setOverlayTime(t);
    tickSplits(t);
    if (!isScrubbing && scrubBar && dur) {
      scrubBar.value = Math.round((t / dur) * SCRUB_STEPS);
    }
    // Drive the trim timeline's playhead + progressive thumbnail capture.
    if (typeof Timeline !== 'undefined') Timeline.onTimeUpdate(t, dur);
  }

  // ── rAF loop — 60 fps while playing, stops when paused/ended ─────────────
  function startRaf() {
    if (rafId) return;
    function tick() {
      updateTimeDisplays();
      if (video && !video.paused && !video.ended) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function stopRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ── Frame-rate detection ────────────────────────────────────────────────────
  // Frame duration comes from one of two sources:
  //   • TS files: parsed exactly from PTS up front (setFrameDuration, locked).
  //   • Native files: sampled from requestVideoFrameCallback media-times while
  //     playing, taking the MEDIAN gap (robust to jitter and dropped frames).
  // rVFC doesn't fire for backgrounded tabs, so the parsed value is preferred.
  const currentFrameDuration = () => frameDuration || (1 / ASSUMED_FPS);

  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  function startFrameSampler() {
    // Skip if we already know the rate exactly, or rVFC is unavailable.
    if (frameDurationLocked || !video || !video.requestVideoFrameCallback || vfcSamplerId != null) return;
    lastSampleTime = null;
    frameSamples = [];
    const sample = (_now, meta) => {
      vfcSamplerId = null;
      const mt = meta.mediaTime;
      if (lastSampleTime != null) {
        const d = mt - lastSampleTime;
        if (d > 0.002 && d < 0.2) frameSamples.push(d); // ignore dup/seek/implausible
      }
      lastSampleTime = mt;
      // Once enough samples accrue, lock in the median frame period.
      if (frameSamples.length >= 12) {
        frameDuration = median(frameSamples);
        updateFrameStepHint();
        return; // stop sampling
      }
      if (video && !video.paused && !video.ended) {
        vfcSamplerId = video.requestVideoFrameCallback(sample);
      }
    };
    vfcSamplerId = video.requestVideoFrameCallback(sample);
  }

  function stopFrameSampler() {
    if (vfcSamplerId != null && video?.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(vfcSamplerId);
    }
    vfcSamplerId = null;
    lastSampleTime = null;
    // Finalize with whatever we gathered if it's a usable sample set.
    if (!frameDurationLocked && frameSamples.length >= 4) {
      frameDuration = median(frameSamples);
      updateFrameStepHint();
    }
  }

  // Set the frame duration from an authoritative source (TS PTS parsing) —
  // exact and available before playback. Locks out the rVFC sampler.
  function setFrameDuration(seconds) {
    if (seconds > 0.002 && seconds < 0.2) {
      frameDuration = seconds;
      frameDurationLocked = true;
      updateFrameStepHint();
    }
  }

  // Surface the detected rate on the frame-step buttons so it's clear stepping
  // is now frame-exact (reassuring for precise timing).
  function updateFrameStepHint() {
    if (frameDuration == null) return;
    const fps  = Math.round(1 / frameDuration);
    const prev = document.getElementById('btn-prev-frame');
    const next = document.getElementById('btn-next-frame');
    if (prev) prev.title = `Previous frame (${fps} fps)`;
    if (next) next.title = `Next frame (${fps} fps)`;
  }

  // ── Splits panel ──────────────────────────────────────────────────────────

  // Which lap index contains time t? Returns -1 if none.
  // A lap with endTime == null is always "active" once started (live marking).
  function getActiveLapIndex(t) {
    for (let i = 0; i < lapSplits.length; i++) {
      const lap = lapSplits[i];
      if (t >= lap.startTime && (lap.endTime == null || t < lap.endTime)) return i;
    }
    return -1;
  }

  // Per-frame driver: rebuilds DOM only when the active lap changes;
  // otherwise just updates the one time-text element (cheap).
  function tickSplits(t) {
    const idx = getActiveLapIndex(t);
    if (idx !== prevActiveLapIdx) {
      prevActiveLapIdx = idx;
      buildSplitsDom(t);
    } else {
      updateLiveSplitText(t);
    }
  }

  // Full DOM rebuild — newest lap on top, only shows laps that have started.
  function buildSplitsDom(t) {
    const splitsEl = document.getElementById('overlay-splits');
    if (!splitsEl) return;

    // Laps visible so far: completed (endTime <= t) + current (contains t)
    const visible = [];
    for (let i = 0; i < lapSplits.length; i++) {
      const lap = lapSplits[i];
      const isCurrent = (i === prevActiveLapIdx);
      const isDone    = lap.endTime != null && t >= lap.endTime;
      if (isCurrent || isDone) visible.push({ lap, idx: i, isCurrent });
    }

    if (visible.length === 0) {
      splitsEl.classList.add('hidden');
      splitsEl.innerHTML = '';
      return;
    }

    splitsEl.classList.remove('hidden');

    // Newest first, cap at 5 rows
    const rows = visible.slice(-5).reverse();
    splitsEl.innerHTML = rows.map(({ lap, idx, isCurrent }) => {
      const dur     = isCurrent
        ? Math.max(0, t - lap.startTime)
        : lap.endTime - lap.startTime;
      const isFastest = fastestIds.has(lap.id);
      return `<div class="ls-split-row${isCurrent ? ' ls-split-current' : ''}${isFastest ? ' ls-split-fastest' : ''}">` +
             `<span class="ls-split-num">L${idx + 1}</span>` +
             `<span class="ls-split-time">${formatTime(dur)}</span>` +
             `</div>`;
    }).join('');
  }

  // Lightweight per-frame update — only rewrites the current lap's time text.
  function updateLiveSplitText(t) {
    if (prevActiveLapIdx < 0) return;
    const lap = lapSplits[prevActiveLapIdx];
    if (!lap || lap.startTime == null) return;
    const splitsEl = document.getElementById('overlay-splits');
    if (!splitsEl || splitsEl.classList.contains('hidden')) return;
    const timeEl = splitsEl.querySelector('.ls-split-current .ls-split-time');
    if (timeEl) timeEl.textContent = formatTime(Math.max(0, t - lap.startTime));
  }

  // Called by app.js via Laps.setOnChange whenever laps are added/edited/deleted.
  function setLapSplits(laps) {
    lapSplits = laps || [];
    const _t = actualTime();
    prevActiveLapIdx = getActiveLapIndex(_t);
    buildSplitsDom(_t);
  }

  function setFastestIds(ids) {
    fastestIds = ids || new Set();
    prevActiveLapIdx = -2; // force DOM rebuild so glow classes update
    buildSplitsDom(actualTime());
  }

  function getFastestIds() { return fastestIds; }
  function getTimeOffset()  { return timeOffset; }

  function updatePlayPauseIcon() {
    const playIcon  = document.getElementById('icon-play');
    const pauseIcon = document.getElementById('icon-pause');
    if (!playIcon || !pauseIcon) return;
    if (video.paused) {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
    } else {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    }
  }

  // Step one frame forward or backward.
  // Uses rVFC when available for accuracy feedback; otherwise direct time nudge.
  function stepFrame(direction) {
    if (!video) return;
    video.pause();
    // Step within the current sub-blob (video.currentTime only, no offset needed)
    video.currentTime = Math.max(0, Math.min(
      video.duration || Infinity,
      video.currentTime + direction * currentFrameDuration()
    ));
  }

  function seekTo(seconds) {
    if (!video) return;
    const t = Math.max(0, Math.min(effectiveDuration() || Infinity, seconds));
    if (seekOverride) seekOverride(t);
    else video.currentTime = t;
  }

  function setSeekOverride(fn) { seekOverride = fn; }
  // Refresh displays so a corrected offset (parsed async after a seek) shows
  // immediately even while paused — updateTimeDisplays reads timeOffset live.
  function setTimeOffset(offset) { timeOffset = offset; updateTimeDisplays(); }

  // Capture the current video frame into a canvas overlay so the old frame
  // stays visible while the mpegts.js player is being rebuilt for a TS seek.
  function showSeekCanvas() {
    if (!video || !video.videoWidth || seekCanvas) return;
    const wrapper = video.parentElement;
    if (!wrapper) return;
    seekCanvas = document.createElement('canvas');
    seekCanvas.width  = video.videoWidth;
    seekCanvas.height = video.videoHeight;
    seekCanvas.getContext('2d').drawImage(video, 0, 0);
    Object.assign(seekCanvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      zIndex: '2', objectFit: 'contain', background: '#000',
    });
    wrapper.appendChild(seekCanvas);
  }

  function hideSeekCanvas() {
    if (seekCanvas) { seekCanvas.remove(); seekCanvas = null; }
  }

  function togglePlayPause() {
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  function init() {
    video              = document.getElementById('main-video');
    scrubBar           = document.getElementById('scrub-bar');
    currentTimeDisplay = document.getElementById('current-time-display');
    const durationEl   = document.getElementById('duration-display');
    overlayEl          = document.getElementById('time-overlay');
    overlayMainEl      = document.getElementById('overlay-time-main');
    overlayFracEl      = document.getElementById('overlay-time-frac');

    // Time updates — rAF at ~60 fps while playing; seeked/loadedmetadata for paused state.
    // (timeupdate fires at only ~4 Hz which makes the milliseconds jitter visibly.)
    video.addEventListener('loadedmetadata', () => {
      if (durationEl && isFinite(video.duration)) {
        durationEl.textContent = formatTime(video.duration);
      }
      scrubBar.max = SCRUB_STEPS;
      updateTimeDisplays();
    });
    video.addEventListener('durationchange', () => {
      if (durationEl && isFinite(video.duration)) {
        durationEl.textContent = formatTime(video.duration);
      }
    });
    video.addEventListener('seeked',     updateTimeDisplays);
    video.addEventListener('timeupdate', updateTimeDisplays); // fallback for paused scrub on some browsers

    // canplay fires once the browser has decoded at least one frame and can paint
    // it. Setting currentTime here (not on loadedmetadata) guarantees a visible
    // frame — loadedmetadata only means headers parsed, not pixels available.
    video.addEventListener('canplay', () => {
      if (!firstFrameShown) {
        firstFrameShown = true;
        video.currentTime = 0.001;
      }
    });
    video.addEventListener('play', () => {
      updatePlayPauseIcon();
      startRaf();
      startFrameSampler();
    });
    video.addEventListener('pause', () => {
      updatePlayPauseIcon();
      stopRaf();
      stopFrameSampler();
      updateTimeDisplays();
    });
    video.addEventListener('ended', () => {
      updatePlayPauseIcon();
      stopRaf();
      stopFrameSampler();
      updateTimeDisplays();
    });

    // Scrub bar interaction.
    // For native video: seek on every input event (smooth live scrub).
    // For TS files (seekOverride set): just update the time display during drag
    // and commit the seek only on release — otherwise every drag pixel destroys
    // and recreates the mpegts.js player causing a continuous black flash.
    scrubBar.addEventListener('mousedown', () => { isScrubbing = true; });
    scrubBar.addEventListener('touchstart', () => { isScrubbing = true; }, { passive: true });
    scrubBar.addEventListener('input', () => {
      const dur = effectiveDuration();
      if (!dur) return;
      const t = (scrubBar.value / SCRUB_STEPS) * dur;
      if (seekOverride) {
        // Preview the target time in the display without rebuilding the player.
        if (currentTimeDisplay) currentTimeDisplay.textContent = formatTime(t);
        setOverlayTime(t);
      } else {
        video.currentTime = t;
      }
    });

    function commitScrub() {
      isScrubbing = false;
      if (!seekOverride) return; // native video was already seeked on input
      const dur = effectiveDuration();
      if (!dur) return;
      const t = (scrubBar.value / SCRUB_STEPS) * dur;
      seekOverride(t);
    }
    scrubBar.addEventListener('mouseup',  commitScrub);
    scrubBar.addEventListener('touchend', commitScrub);

    // Button controls
    document.getElementById('btn-play-pause').addEventListener('click', togglePlayPause);
    document.getElementById('btn-prev-frame').addEventListener('click', () => stepFrame(-1));
    document.getElementById('btn-next-frame').addEventListener('click', () => stepFrame(1));
    document.getElementById('btn-seek-back').addEventListener('click', () => seekTo(actualTime() - SEEK_STEP));
    document.getElementById('btn-seek-forward').addEventListener('click', () => seekTo(actualTime() + SEEK_STEP));

    // Playback speed
    document.getElementById('playback-speed').addEventListener('change', (e) => {
      video.playbackRate = parseFloat(e.target.value);
    });

    // Overlay toggle
    document.getElementById('toggle-overlay').addEventListener('change', (e) => {
      if (e.target.checked) {
        overlayEl.classList.remove('hidden');
        updateTimeDisplays(); // sync immediately
      } else {
        overlayEl.classList.add('hidden');
      }
    });

    // Keyboard shortcuts (only when not focused on an input)
    document.addEventListener('keydown', handleKeydown);

    initOverlayDrag();
  }

  function handleKeydown(e) {
    const tag = document.activeElement.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (!video || video.src === '' || video.readyState === 0) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlayPause();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekTo(actualTime() - SEEK_STEP);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekTo(actualTime() + SEEK_STEP);
        break;
      case ',':
        e.preventDefault();
        stepFrame(-1);
        break;
      case '.':
        e.preventDefault();
        stepFrame(1);
        break;
      case 'l':
      case 'L':
        e.preventDefault();
        Laps.addLap(actualTime());
        break;
      case '[':
        e.preventDefault();
        if (typeof Timeline !== 'undefined') Timeline.setInToCurrent();
        break;
      case ']':
        e.preventDefault();
        if (typeof Timeline !== 'undefined') Timeline.setOutToCurrent();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        Laps.deleteSelected();
        break;
    }
  }

  function prepareForLoad() {
    firstFrameShown = false;
    parsedDuration  = null;
    timeOffset      = 0;
    frameDuration   = null;   // re-detect for the new file
    frameDurationLocked = false;
    frameSamples    = [];
    stopFrameSampler();
    scrubBar.value  = 0;
    const durationEl = document.getElementById('duration-display');
    if (durationEl) durationEl.textContent = '--:--.---';
    if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00.000';
    if (overlayMainEl) overlayMainEl.textContent = '0:00';
    if (overlayFracEl) overlayFracEl.textContent = '.000';
  }

  function loadFile(file) {
    firstFrameShown = false;
    parsedDuration  = null;
    timeOffset      = 0;
    frameDuration   = null;   // re-detect for the new file
    frameDurationLocked = false;
    frameSamples    = [];
    stopFrameSampler();
    if (objectUrl) URL.revokeObjectURL(objectUrl); // release the previous file
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    video.load();
    scrubBar.value = 0;
    if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00.000';
    if (overlayMainEl) overlayMainEl.textContent = '0:00';
    if (overlayFracEl) overlayFracEl.textContent = '.000';
  }

  function getCurrentTime() {
    return actualTime();
  }

  // Called by app.js with the PTS-parsed duration for .ts files so the
  // scrub bar and display work correctly when video.duration is Infinity.
  function setDuration(seconds) {
    parsedDuration = seconds;
    const durationEl = document.getElementById('duration-display');
    if (durationEl) durationEl.textContent = formatTime(seconds);
  }

  function initOverlayDrag() {
    const overlay = document.getElementById('time-overlay');
    const grip    = overlay.querySelector('.ls-resize-grip');
    const wrapper = overlay.parentElement; // .video-wrapper (position: relative)
    let drag = null;

    // ── Move: drag anywhere on the timer except the resize grip ──────────────
    overlay.addEventListener('mousedown', (e) => {
      if (grip && grip.contains(e.target)) return;
      e.preventDefault();
      const oRect = overlay.getBoundingClientRect();
      drag = { type: 'move', offX: e.clientX - oRect.left, offY: e.clientY - oRect.top };
    });

    // ── Resize: drag the bottom-right corner grip to scale font size ─────────
    if (grip) {
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        drag = {
          type: 'resize',
          startX: e.clientX,
          startY: e.clientY,
          startSize: parseFloat(overlay.style.fontSize) || 14,
        };
      });
    }

    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const wRect = wrapper.getBoundingClientRect();

      if (drag.type === 'move') {
        const x = Math.max(0, Math.min(wRect.width  - overlay.offsetWidth,  e.clientX - wRect.left - drag.offX));
        const y = Math.max(0, Math.min(wRect.height - overlay.offsetHeight, e.clientY - wRect.top  - drag.offY));
        overlay.style.left = x + 'px';
        overlay.style.top  = y + 'px';
      } else {
        // Diagonal drag: right+down = bigger, left+up = smaller
        const delta = ((e.clientX - drag.startX) + (e.clientY - drag.startY)) / 2 * 0.25;
        overlay.style.fontSize = Math.max(8, Math.min(48, drag.startSize + delta)) + 'px';
      }
    });

    document.addEventListener('mouseup', () => { drag = null; });
  }

  return { init, loadFile, prepareForLoad, setDuration, setSeekOverride, setTimeOffset,
           setFrameDuration, seekTo, togglePlayPause, stepFrame, getCurrentTime,
           showSeekCanvas, hideSeekCanvas, setLapSplits, setFastestIds,
           getFastestIds, getTimeOffset, getDurationSec: effectiveDuration };
})();
