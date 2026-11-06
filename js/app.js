/* ============================================================
   app.js — Application bootstrap and top-level wiring
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  // ── Init sub-modules ──────────────────────────────────────
  VideoPlayer.init();
  Timeline.init();
  Laps.init(Storage.load());
  DroneDash.init();
  BatchConvert.init();
  Tutorial.init();   // auto-opens on the very first visit; ? button replays it
  // Keep the overlay splits, timeline markers + header buttons in sync with laps
  Laps.setOnChange(laps => {
    VideoPlayer.setLapSplits(laps);
    Timeline.setLaps(laps);
    refreshLapButtons(laps);
  });
  VideoPlayer.setLapSplits(Laps.getLaps()); // seed with any restored laps
  Timeline.setLaps(Laps.getLaps());
  refreshLapButtons(Laps.getLaps());

  // Export/Clear act on lap data — disable them when there are no laps so it's
  // clear there's nothing to act on (and we never download an empty file).
  function refreshLapButtons(laps) {
    const has = laps.length > 0;
    ['btn-export-json', 'btn-export-csv', 'btn-clear-session'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = !has;
    });
  }

  // ── File upload wiring ────────────────────────────────────
  const uploadArea      = document.getElementById('upload-area');
  const fileInput       = document.getElementById('file-input');
  const videoContainer  = document.getElementById('video-container');
  let tsDuration = null;     // set when a .ts file is loaded; used by seek override
  let currentTsFile = null;  // the .ts currently loaded (null for native / none)
  let tsErrorShown = false;  // guard: show the decode notice only once per load
  let pendingSessionFile = null; // file whose per-video lap session to activate once duration is known
  const mainVideoEl = document.getElementById('main-video');

  // Laps are stored per video — keyed by file name + duration — so each clip
  // keeps its own race times. Called as soon as the duration is known (native /
  // MOV on loadedmetadata; .ts after the PTS duration is parsed), it switches the
  // active storage key and loads that clip's laps (empty if it's never been seen).
  function activateSession(file, durationSec) {
    if (!file || !durationSec || !isFinite(durationSec) || durationSec <= 0) return;
    const key = Storage.sessionKey(file.name, durationSec);
    if (Storage.getSessionKey() === key) return;  // already on this clip's session
    Storage.setSessionKey(key);
    Laps.setLaps(Storage.load());
  }

  function showPlayer() {
    uploadArea.classList.add('hidden');
    videoContainer.classList.remove('hidden');
  }

  function hidePlayer() {
    videoContainer.classList.add('hidden');
    uploadArea.classList.remove('hidden');
  }

  // A .ts whose H.264 the browser's decoder rejects (classic Firefox-on-macOS
  // VideoToolbox case) otherwise fails to a silent black screen. Surface
  // actionable guidance instead. The failure shows up as a media-element error
  // (code 3 = MEDIA_ERR_DECODE) and/or an mpegts MEDIA_ERROR — hook both, once.
  function reportTsDecodeError() {
    if (!currentTsFile || tsErrorShown) return;
    tsErrorShown = true;
    alert(
      `Could not decode "${currentTsFile.name}" in this browser.\n\n` +
      `Firefox on macOS uses Apple's hardware H.264 decoder, which rejects some ` +
      `HDZero recordings. To fix, either:\n` +
      `  • Use Chrome or Edge (recommended), or\n` +
      `  • In Firefox, open about:config and set\n` +
      `    media.hardware-video-decoding.enabled = false, then reload.`
    );
    Transcoder.destroyActive();
    hidePlayer();
  }
  mainVideoEl.addEventListener('error', () => {
    if (mainVideoEl.error && mainVideoEl.error.code === 3) reportTsDecodeError();
  });
  Transcoder.onTsError((type) => {
    if (!mpegts.ErrorTypes || type === mpegts.ErrorTypes.MEDIA_ERROR) reportTsDecodeError();
  });

  // Native / MOV: the duration is finite here, so load this clip's saved laps.
  // (.ts reports Infinity and is activated from its parsed PTS duration instead.)
  mainVideoEl.addEventListener('loadedmetadata', () => {
    if (pendingSessionFile && isFinite(mainVideoEl.duration) && mainVideoEl.duration > 0) {
      activateSession(pendingSessionFile, mainVideoEl.duration);
    }
  });

  function loadVideo(file) {
    if (!file) return;

    // Remember this file so its per-video lap session activates once the
    // duration is known (see the loadedmetadata listener / the .ts parse below).
    pendingSessionFile = file;

    // Retain the original File so the background MP4 export can mount it directly
    // (WORKERFS) instead of going back through the player.
    ExportFfmpeg.setSource(file);

    // Scrub previews from the previous file (frames, codec) are now invalid.
    if (typeof ScrubPreview !== 'undefined') ScrubPreview.reset();

    if (Transcoder.isTsFile(file)) {
      // No Media Source Extensions → mpegts.js can't run at all (e.g. iOS Safari).
      if (!window.mpegts || !mpegts.isSupported()) {
        alert(
          `Your browser can't play HDZero .ts files — it lacks Media Source ` +
          `Extensions. Please use Chrome or Edge on a desktop.`
        );
        return;
      }
      tsDuration = null;
      currentTsFile = file;
      tsErrorShown = false;
      const videoEl = mainVideoEl;
      VideoPlayer.prepareForLoad();
      Transcoder.loadTsFile(file, videoEl);
      showPlayer();
      // Seek by slicing the file to the target byte offset (sub-blob).
      // mpegts.js normalises PTS to ~0 for each new player, so seekTsTo
      // returns the real start time and we store it as a timeOffset so
      // actualTime() = video.currentTime + offset = correct race time.
      VideoPlayer.setSeekOverride((t) => {
        // Fast path: if the target maps into the current sub-blob's buffered
        // range, jump directly — instant, frame-exact, no player rebuild (and
        // none of the rebuild's async races). Covers arrow-key ±5 s hops and
        // frame steps, which usually stay inside the ~8 s buffer window.
        const sub = t - VideoPlayer.getTimeOffset();
        const buf = mainVideoEl.buffered;
        for (let i = 0; i < buf.length; i++) {
          if (sub >= buf.start(i) && sub <= buf.end(i) - 0.05) {
            mainVideoEl.currentTime = sub;
            return;
          }
        }
        VideoPlayer.showSeekCanvas();
        // startTime is a provisional constant-bitrate estimate so the display
        // isn't blank while the slice loads; onOffset replaces it with the exact
        // PTS-derived time once parsed, which is what keeps lap times precise.
        const startTime = Transcoder.seekTsTo(
          t,
          tsDuration || 0,
          () => { VideoPlayer.hideSeekCanvas(); VideoPlayer.endSeekHold(); },
          (realOffset) => { VideoPlayer.setTimeOffset(realOffset); }
        );
        // null = the seek was dropped (rebuild already in flight) — leave the
        // offset alone or the display would show a position we never went to.
        if (startTime == null) { VideoPlayer.hideSeekCanvas(); return; }
        // Hold every readout (time, overlay, playhead) at the target while the
        // player rebuilds — the slice starts ~3 s early for a keyframe, and
        // without the hold everything visibly skips back and re-lands.
        VideoPlayer.beginSeekHold(t);
        VideoPlayer.setTimeOffset(startTime);
      });
      // Parse duration from binary PTS — mpegts.js always reports Infinity.
      Transcoder.getTsDuration(file)
        .then(dur => {
          tsDuration = dur;
          if (dur) {
            VideoPlayer.setDuration(dur);
            activateSession(file, dur);  // load this .ts clip's saved laps
          }
        })
        .catch(() => {});
      // Detect the real frame rate from PTS so frame-stepping moves exactly one
      // frame (HDZero footage is often 90 fps, not the 30 fps fallback).
      Transcoder.getFrameDuration()
        .then(fd => { if (fd) VideoPlayer.setFrameDuration(fd); })
        .catch(() => {});
    } else if (Transcoder.isMovFile(file)) {
      tsDuration = null;
      currentTsFile = null;
      Transcoder.destroyActive();
      VideoPlayer.setSeekOverride(null);
      VideoPlayer.loadFile(file);
      showPlayer();
      listenForMovError(file);
    } else {
      tsDuration = null;
      currentTsFile = null;
      Transcoder.destroyActive();
      VideoPlayer.setSeekOverride(null);
      VideoPlayer.loadFile(file);
      showPlayer();
    }

    // Build the trim timeline + filmstrip for the freshly loaded clip.
    Timeline.load(file);
  }

  function listenForMovError(file) {
    const videoEl = document.getElementById('main-video');
    let done = false;

    function onError() {
      if (done) return;
      done = true;
      cleanup();
      alert(
        `Could not play "${file.name}" natively.\n\n` +
        'Chrome supports H.264 MOV but not ProRes or HEVC. ' +
        'Try converting to MP4 first (e.g. with HandBrake).'
      );
      hidePlayer();
    }
    function onCanPlay() {
      if (done) return;
      done = true;
      cleanup();
    }
    function cleanup() {
      videoEl.removeEventListener('error', onError);
      videoEl.removeEventListener('canplay', onCanPlay);
    }

    videoEl.addEventListener('error', onError);
    videoEl.addEventListener('canplay', onCanPlay);
  }

  // One file → load it in the player. Several files → batch 60 fps conversion.
  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (files.length > 1) BatchConvert.open(files);
    else loadVideo(files[0]);
  }

  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';  // allow re-picking the same file(s)
  });

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
  uploadArea.addEventListener('click', () => fileInput.click());

  document.getElementById('btn-change-video').addEventListener('click', () => {
    Transcoder.destroyActive();
    Timeline.reset();
    hidePlayer();
    fileInput.value = '';
  });

  document.getElementById('btn-export-mp4').addEventListener('click', () => ExportFfmpeg.start());
  document.getElementById('btn-export-timer').addEventListener('click', () => ExportFfmpeg.startTimerOnly());
  document.getElementById('btn-cancel-export').addEventListener('click', () => ExportFfmpeg.cancel());

  // ── Timer overlay colour customiser ───────────────────────
  // Drives the on-screen overlay via CSS variables; the export renderer reads
  // the same picker values so burned-in frames match. Choices persist.
  const overlayEl   = document.getElementById('time-overlay');
  const accentInput = document.getElementById('overlay-accent');
  const textInput   = document.getElementById('overlay-text');
  const fontInput   = document.getElementById('overlay-font');

  function applyOverlayColors(c) {
    if (!overlayEl) return;
    if (c.accent) overlayEl.style.setProperty('--timer-accent', c.accent);
    if (c.text)   overlayEl.style.setProperty('--timer-text',   c.text);
    if (c.font)   overlayEl.style.setProperty('--timer-font',    c.font);
  }

  const savedColors = Storage.loadOverlayColors();
  if (savedColors) {
    if (savedColors.accent) accentInput.value = savedColors.accent;
    if (savedColors.text)   textInput.value   = savedColors.text;
    if (savedColors.font)   fontInput.value   = savedColors.font;
  }
  applyOverlayColors({ accent: accentInput.value, text: textInput.value, font: fontInput.value });

  function onOverlayColorChange() {
    const c = { accent: accentInput.value, text: textInput.value, font: fontInput.value };
    applyOverlayColors(c);
    Storage.saveOverlayColors(c);
  }
  accentInput.addEventListener('input', onOverlayColorChange);
  textInput.addEventListener('input', onOverlayColorChange);
  fontInput.addEventListener('change', onOverlayColorChange);

  // ── Add lap button ────────────────────────────────────────
  document.getElementById('btn-add-lap').addEventListener('click', () => {
    Laps.addLap(VideoPlayer.getCurrentTime());
  });

  // ── Fastest group size ────────────────────────────────────
  document.getElementById('group-size').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v) && v >= 1) Laps.setGroupSize(v);
  });

  // ── Export / import ───────────────────────────────────────
  document.getElementById('btn-export-json').addEventListener('click', () => Export.toJSON());
  document.getElementById('btn-export-csv').addEventListener('click',  () => Export.toCSV());

  const importInput = document.getElementById('import-input');
  document.getElementById('btn-import').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', (e) => {
    if (e.target.files[0]) {
      Export.fromJSON(e.target.files[0]);
      e.target.value = '';
    }
  });

  // ── Clear session ─────────────────────────────────────────
  document.getElementById('btn-clear-session').addEventListener('click', () => {
    if (confirm('Clear the lap data for this video? This cannot be undone.')) {
      Storage.clear();
      Laps.setLaps([]);
    }
  });
  // (The edit-lap modal wires its own backdrop/Escape/Enter handling in Laps.)
});
