/* ============================================================
   app.js — Application bootstrap and top-level wiring
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  // ── Init sub-modules ──────────────────────────────────────
  VideoPlayer.init();
  Laps.init(Storage.load());

  // ── File upload wiring ────────────────────────────────────
  const uploadArea   = document.getElementById('upload-area');
  const fileInput    = document.getElementById('file-input');
  const videoContainer = document.getElementById('video-container');

  function loadVideo(file) {
    if (!file || !file.type.startsWith('video/') && !file.name.match(/\.(ts|m2ts|mpeg|mpg)$/i)) {
      // Still attempt to load; browser will reject unsupported formats
    }
    VideoPlayer.loadFile(file);
    uploadArea.classList.add('hidden');
    videoContainer.classList.remove('hidden');
  }

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadVideo(e.target.files[0]);
  });

  // Drag-and-drop on upload area
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

  // Change video button
  document.getElementById('btn-change-video').addEventListener('click', () => {
    videoContainer.classList.add('hidden');
    uploadArea.classList.remove('hidden');
    fileInput.value = '';
  });

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
