/* ============================================================
   app.js — Application bootstrap and top-level wiring
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  // ── Init sub-modules ──────────────────────────────────────
  VideoPlayer.init();
  Laps.init(Storage.load());
  // Keep the overlay splits panel in sync with the lap table
  Laps.setOnChange(laps => VideoPlayer.setLapSplits(laps));
  VideoPlayer.setLapSplits(Laps.getLaps()); // seed with any restored laps

  // ── File upload wiring ────────────────────────────────────
  const uploadArea      = document.getElementById('upload-area');
  const fileInput       = document.getElementById('file-input');
  const videoContainer  = document.getElementById('video-container');
  let tsDuration = null;     // set when a .ts file is loaded; used by seek override
  let currentTsFile = null;  // the .ts currently loaded (null for native / none)
  let tsErrorShown = false;  // guard: show the decode notice only once per load
  const mainVideoEl = document.getElementById('main-video');

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

  function loadVideo(file) {
    if (!file) return;

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
        VideoPlayer.showSeekCanvas();
        // startTime is a provisional constant-bitrate estimate so the display
        // isn't blank while the slice loads; onOffset replaces it with the exact
        // PTS-derived time once parsed, which is what keeps lap times precise.
        const startTime = Transcoder.seekTsTo(
          t,
          tsDuration || 0,
          () => { VideoPlayer.hideSeekCanvas(); },
          (realOffset) => { VideoPlayer.setTimeOffset(realOffset); }
        );
        VideoPlayer.setTimeOffset(startTime);
      });
      // Parse duration from binary PTS — mpegts.js always reports Infinity.
      Transcoder.getTsDuration(file)
        .then(dur => {
          tsDuration = dur;
          if (dur) VideoPlayer.setDuration(dur);
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

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadVideo(e.target.files[0]);
  });

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadVideo(file);
  });
  uploadArea.addEventListener('click', () => fileInput.click());

  document.getElementById('btn-change-video').addEventListener('click', () => {
    Transcoder.destroyActive();
    hidePlayer();
    fileInput.value = '';
  });

  document.getElementById('btn-export-overlay').addEventListener('click', () => ExportVideo.start());
  document.getElementById('btn-cancel-export').addEventListener('click', () => ExportVideo.cancel());

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
    if (confirm('Clear all lap data? This cannot be undone.')) {
      Storage.clear();
      Laps.setLaps([]);
    }
  });

  // ── Modal: close on backdrop click ───────────────────────
  document.getElementById('edit-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
});
