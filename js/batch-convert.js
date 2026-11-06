/* ============================================================
   batch-convert.js — Batch frame-rate conversion via ffmpeg.wasm
   ============================================================

   Drop several files on the upload area and this module opens a
   queue. Each file is converted, one at a time, to an MP4 at the
   selected frame rate (default 60 fps) and downloaded. The source
   files are never modified.

   Implementation notes:
     • Uses its OWN FFmpeg instance, separate from ExportFfmpeg's
       cached one, so a batch cancel (terminate) can never kill an
       instance the overlay exporter still holds.
     • Sources are mounted with WORKERFS so a multi-GB .ts is read
       in slices instead of being copied into the WASM heap.
     • fps=N duplicates/drops frames without changing timestamps,
       so the footage timing stays exact — only the frame rate of
       the container changes.
   ============================================================ */

const BatchConvert = (() => {
  const CORE_DIR = 'vendor/core';
  const EXT_RE   = /\.(mp4|webm|mkv|mov|avi|ts|m2ts|mts)$/i;

  let ffmpeg    = null;   // private instance (see header note)
  let running   = false;
  let cancelled = false;
  let queue     = [];     // [{ file, state, rowEl, barEl, statusEl }]
  let blobUrls  = [];     // object URLs for the per-file Save links; revoked on close

  const $ = (id) => document.getElementById(id);

  // ── ffmpeg loading (mirrors ExportFfmpeg.load, own instance) ──────────────
  const toBlobURL = async (url, type) => {
    const buf = await (await fetch(url)).arrayBuffer();
    return URL.createObjectURL(new Blob([buf], { type }));
  };

  async function load() {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;
    if (!window.FFmpegWASM) throw new Error('ffmpeg.wasm not loaded (vendor/ffmpeg/ffmpeg.js missing)');
    const { FFmpeg } = FFmpegWASM;
    ffmpeg = new FFmpeg();
    setSummary('Loading encoder (first time only)…');
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_DIR}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_DIR}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    return ffmpeg;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function baseName(file) {
    return file.name
      .replace(/\.[^/.]+$/, '')
      .replace(/[/\\?%*:|"<>]/g, '_')
      .trim() || 'video';
  }

  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
  }

  // Start the automatic download AND put a Save link on the row. Browsers often
  // block the second and later automatic downloads of a batch, so the link is
  // the guaranteed path to every output. URLs are revoked when the modal closes.
  function deliverOutput(item, blob, filename) {
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    if (item.statusEl) {
      item.statusEl.innerHTML = '';
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.textContent = 'Save';
      a.className = 'batch-save';
      item.statusEl.append('Done — ', a);
    }
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  }

  // Duration of a file, needed for a correct per-file progress fraction.
  // .ts comes from the PTS parser; native formats from a probe <video> element.
  async function getDuration(file) {
    if (/\.(ts|m2ts|mts)$/i.test(file.name) && typeof Transcoder !== 'undefined') {
      try { return await Transcoder.getTsDuration(file); } catch (_) { return null; }
    }
    return new Promise((resolve) => {
      const v   = document.createElement('video');
      const url = URL.createObjectURL(file);
      let settled = false;
      const done = (d) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        v.removeAttribute('src');
        resolve(d);
      };
      v.preload = 'metadata';
      v.onloadedmetadata = () => done(isFinite(v.duration) && v.duration > 0 ? v.duration : null);
      v.onerror = () => done(null);
      setTimeout(() => done(null), 10000);
      v.src = url;
    });
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  function setSummary(text) {
    const el = $('batch-summary');
    if (el) el.textContent = text;
  }

  function setItemStatus(item, text) {
    if (item.statusEl) item.statusEl.textContent = text;
  }

  function setItemProgress(item, frac) {
    if (item.barEl) item.barEl.style.width = `${Math.round(frac * 100)}%`;
    setItemStatus(item, `Converting… ${Math.round(frac * 100)}%`);
  }

  function renderQueue() {
    const list = $('batch-list');
    list.innerHTML = '';
    for (const item of queue) {
      const row = document.createElement('div');
      row.className = 'batch-row';
      row.innerHTML =
        `<div class="batch-row-top">` +
          `<span class="batch-name" title="${item.file.name}">${item.file.name}</span>` +
          `<span class="batch-size">${fmtSize(item.file.size)}</span>` +
          `<span class="batch-status">Waiting</span>` +
        `</div>` +
        `<div class="batch-bar-track"><div class="batch-bar"></div></div>`;
      list.appendChild(row);
      item.rowEl    = row;
      item.statusEl = row.querySelector('.batch-status');
      item.barEl    = row.querySelector('.batch-bar');
    }
  }

  function setRunningUi(on) {
    $('batch-start').classList.toggle('hidden', on);
    $('batch-cancel').classList.toggle('hidden', !on);
    $('batch-close').disabled = on;
    $('batch-fps').disabled = on;
  }

  function selectedFps() {
    const v = parseInt($('batch-fps')?.value, 10);
    return (v === 30 || v === 60 || v === 90) ? v : 60;
  }

  // ── Conversion ────────────────────────────────────────────────────────────

  async function convertOne(item, fps) {
    const ff  = await load();
    const dur = await getDuration(item.file);
    if (cancelled) return null;

    const onProgress = ({ time }) => {
      if (dur && time) setItemProgress(item, Math.min(1, (time / 1e6) / dur));
    };
    ff.on('progress', onProgress);
    try {
      const name = /\.[a-z0-9]+$/i.test(item.file.name) ? item.file.name : 'source.ts';
      await ff.createDir('/input');
      await ff.mount('WORKERFS', { files: [item.file] }, '/input');
      // fps=N resamples to the exact output rate; timestamps stay correct.
      // crf 18 + ultrafast matches the overlay exporter: visually lossless, fast.
      await ff.exec([
        '-i', `/input/${name}`,
        '-vf', `fps=${fps}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-r', String(fps),
        '-movflags', '+faststart',
        'out.mp4',
      ]);
      if (cancelled) return null;
      const data = await ff.readFile('out.mp4');
      return new Blob([data.buffer], { type: 'video/mp4' });
    } finally {
      // A cancel terminates the instance; skip FS cleanup on a dead instance.
      if (ffmpeg) {
        try { ff.off('progress', onProgress); } catch (_) {}
        try { await ff.unmount('/input'); }    catch (_) {}
        try { await ff.deleteDir('/input'); }  catch (_) {}
        try { await ff.deleteFile('out.mp4'); } catch (_) {}
      }
    }
  }

  async function start() {
    if (running || queue.length === 0) return;
    running   = true;
    cancelled = false;
    setRunningUi(true);
    const fps = selectedFps();

    let done = 0, failed = 0;
    for (const item of queue) {
      if (cancelled) { setItemStatus(item, 'Cancelled'); continue; }
      item.state = 'converting';
      setItemStatus(item, 'Converting… 0%');
      setSummary(`Converting file ${done + failed + 1} of ${queue.length}…`);
      try {
        const blob = await convertOne(item, fps);
        if (blob) {
          item.state = 'done';
          setItemProgress(item, 1);
          deliverOutput(item, blob, `${baseName(item.file)}-${fps}fps.mp4`);
          done++;
        } else {
          item.state = 'cancelled';
          setItemStatus(item, 'Cancelled');
        }
      } catch (err) {
        if (cancelled) {
          item.state = 'cancelled';
          setItemStatus(item, 'Cancelled');
        } else {
          item.state = 'error';
          setItemStatus(item, 'Failed');
          console.error('[BatchConvert]', item.file.name, err);
          failed++;
        }
      }
    }

    running = false;
    setRunningUi(false);
    if (cancelled) setSummary(`Cancelled — ${done} of ${queue.length} file(s) converted.`);
    else if (failed) setSummary(`Finished — ${done} converted, ${failed} failed. See the console for errors.`);
    else setSummary(`Finished — ${done} file(s) converted. If a download was blocked, use the Save links.`);
  }

  function cancel() {
    if (!running) return;
    cancelled = true;
    setSummary('Cancelling…');
    // terminate() hard-aborts an in-flight exec; the instance is then dead
    // and reloads lazily on the next batch.
    try { ffmpeg?.terminate(); } catch (_) {}
    ffmpeg = null;
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  function open(files) {
    const vids = Array.from(files).filter(f => EXT_RE.test(f.name));
    if (vids.length === 0) {
      alert('No supported video files found.\nSupported: MP4, WebM, MKV, MOV, AVI, TS, M2TS, MTS.');
      return;
    }
    if (running) {
      alert('A batch conversion is already in progress.');
      return;
    }
    queue = vids.map(f => ({ file: f, state: 'waiting' }));
    renderQueue();
    setRunningUi(false);
    setSummary(`${vids.length} file(s) ready. Each converts to a new MP4 and downloads automatically.`);
    $('batch-modal').classList.remove('hidden');
  }

  function close() {
    if (running) return;  // Close is disabled while running; belt and braces
    $('batch-modal').classList.add('hidden');
    blobUrls.forEach(u => URL.revokeObjectURL(u));
    blobUrls = [];
    queue = [];
  }

  function init() {
    $('batch-start').addEventListener('click', start);
    $('batch-cancel').addEventListener('click', cancel);
    $('batch-close').addEventListener('click', close);
  }

  return { init, open, cancel };
})();
