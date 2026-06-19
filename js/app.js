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
  let tsDuration = null; // set when a .ts file is loaded; used by seek override

  function showPlayer() {
    uploadArea.classList.add('hidden');
    videoContainer.classList.remove('hidden');
  }

  function hidePlayer() {
    videoContainer.classList.add('hidden');
    uploadArea.classList.remove('hidden');
  }

  function loadVideo(file) {
    if (!file) return;

    if (Transcoder.isTsFile(file)) {
      tsDuration = null;
      const videoEl = document.getElementById('main-video');
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
      Transcoder.destroyActive();
      VideoPlayer.setSeekOverride(null);
      VideoPlayer.loadFile(file);
      showPlayer();
      listenForMovError(file);
    } else {
      tsDuration = null;
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
