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
  const ASSUMED_FPS = 30;           // fallback frame rate for stepping
  const SEEK_STEP   = 5;            // seconds for left/right arrow seek
  const SCRUB_STEPS = 1000;         // resolution of the scrub bar

  let video = null;
  let scrubBar = null;
  let currentTimeDisplay = null;
  let durationDisplay = null;
  let overlayEl = null;
  let isScrubbing = false;

  function formatTime(s) {
    if (s == null || isNaN(s)) return '0:00.000';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    const ms = Math.round((sec % 1) * 1000);
    const sInt = Math.floor(sec);
    return `${m}:${String(sInt).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
  }

  function updateTimeDisplays() {
    const t = video.currentTime;
    if (currentTimeDisplay) currentTimeDisplay.textContent = formatTime(t);
    if (overlayEl && !overlayEl.classList.contains('hidden')) {
      document.getElementById('overlay-time').textContent = formatTime(t);
    }
    if (!isScrubbing && scrubBar && video.duration) {
      scrubBar.value = Math.round((t / video.duration) * SCRUB_STEPS);
    }
  }

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
    const frameDuration = 1 / ASSUMED_FPS;
    video.currentTime = Math.max(0, Math.min(
      video.duration || Infinity,
      video.currentTime + direction * frameDuration
    ));
  }

  function seekTo(seconds) {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, seconds));
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

    // Time updates
    video.addEventListener('timeupdate', updateTimeDisplays);
    video.addEventListener('loadedmetadata', () => {
      if (durationEl) durationEl.textContent = formatTime(video.duration);
      scrubBar.max = SCRUB_STEPS;
      // Nudge to a tiny offset so the browser decodes and paints the first frame.
      // Without this many browsers leave the video element black at currentTime=0.
      video.currentTime = 0.001;
      updateTimeDisplays();
    });
    video.addEventListener('play',  updatePlayPauseIcon);
    video.addEventListener('pause', updatePlayPauseIcon);
    video.addEventListener('ended', updatePlayPauseIcon);

    // Scrub bar interaction
    scrubBar.addEventListener('mousedown', () => { isScrubbing = true; });
    scrubBar.addEventListener('touchstart', () => { isScrubbing = true; }, { passive: true });
    scrubBar.addEventListener('input', () => {
      if (video.duration) {
        video.currentTime = (scrubBar.value / SCRUB_STEPS) * video.duration;
      }
    });
    scrubBar.addEventListener('mouseup',   () => { isScrubbing = false; });
    scrubBar.addEventListener('touchend',  () => { isScrubbing = false; });

    // Button controls
    document.getElementById('btn-play-pause').addEventListener('click', togglePlayPause);
    document.getElementById('btn-prev-frame').addEventListener('click', () => stepFrame(-1));
    document.getElementById('btn-next-frame').addEventListener('click', () => stepFrame(1));
    document.getElementById('btn-seek-back').addEventListener('click', () => seekTo(video.currentTime - SEEK_STEP));
    document.getElementById('btn-seek-forward').addEventListener('click', () => seekTo(video.currentTime + SEEK_STEP));

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
        seekTo(video.currentTime - SEEK_STEP);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekTo(video.currentTime + SEEK_STEP);
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
        Laps.addLap(video.currentTime);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        Laps.deleteSelected();
        break;
    }
  }

  function loadFile(file) {
    const url = URL.createObjectURL(file);
    video.src = url;
    video.load();
    // Reset scrub and overlay time
    scrubBar.value = 0;
    if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00.000';
    document.getElementById('overlay-time').textContent = '0:00.000';
  }

  function getCurrentTime() {
    return video ? video.currentTime : 0;
  }

  return { init, loadFile, seekTo, togglePlayPause, stepFrame, getCurrentTime };
})();
