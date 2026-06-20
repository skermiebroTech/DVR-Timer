/* ============================================================
   laps.js — Lap data model and table rendering
   ============================================================ */

const Laps = (() => {
  let laps = [];         // [{ id, startTime, endTime }]
  let selectedId = null;
  let nextId = 1;
  let groupSize = 3;
  let onChange = null;   // called with current laps array after every mutation
  let flashId = null;    // id of a just-added lap, flashed once in the next render
  let editingId = null;  // lap currently open in the edit modal

  // ── Helpers ──────────────────────────────────────────────

  function formatTime(seconds) {
    if (seconds == null || isNaN(seconds)) return '—';
    // Integer-ms math so rounding carries into seconds (29.9995 → 0:30.000,
    // never 0:29.1000).
    const total = Math.round(seconds * 1000);
    const ms    = total % 1000;
    const secs  = Math.floor(total / 1000);
    const m     = Math.floor(secs / 60);
    return `${m}:${String(secs % 60).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
  }

  function lapDuration(lap) {
    if (lap.startTime == null || lap.endTime == null) return null;
    return lap.endTime - lap.startTime;
  }

  // Find the fastest group of `n` consecutive laps (by total duration).
  // Returns the starting index of the best group, or -1 if not enough complete laps.
  function findFastestGroup(n) {
    const complete = laps.filter(l => l.startTime != null && l.endTime != null);
    if (complete.length < n) return { total: null, ids: new Set() };

    let bestTotal = Infinity;
    let bestStart = 0;
    for (let i = 0; i <= complete.length - n; i++) {
      let total = 0;
      for (let j = i; j < i + n; j++) total += lapDuration(complete[j]);
      if (total < bestTotal) { bestTotal = total; bestStart = i; }
    }

    const bestGroup = complete.slice(bestStart, bestStart + n);
    const bestIds = new Set(bestGroup.map(l => l.id));
    return { total: bestTotal, ids: bestIds };
  }

  // ── Public API ────────────────────────────────────────────

  function init(savedLaps) {
    laps = savedLaps || [];
    nextId = laps.length ? Math.max(...laps.map(l => l.id)) + 1 : 1;
    initModal();
    render();
  }

  // Add a new lap. If the last lap has no end time, set its end time first.
  // Then create a new lap with startTime = currentTime.
  function addLap(currentTime) {
    const last = laps[laps.length - 1];
    if (last && last.endTime == null) {
      last.endTime = currentTime;
    }
    const id = nextId++;
    laps.push({ id, startTime: currentTime, endTime: null });
    flashId = id;          // highlight this row once on the next render
    Storage.save(laps);
    render();
  }

  function updateLap(id, startTime, endTime) {
    const lap = laps.find(l => l.id === id);
    if (!lap) return;
    lap.startTime = startTime;
    lap.endTime = endTime;
    Storage.save(laps);
    render();
  }

  function deleteLap(id) {
    const idx = laps.findIndex(l => l.id === id);
    if (idx === -1) return;

    // Re-number: if deleting a lap that has an end, we don't need to stitch—
    // just remove it. Visual lap numbers recompute from order.
    laps.splice(idx, 1);
    if (selectedId === id) selectedId = null;
    Storage.save(laps);
    render();
  }

  function selectLap(id) {
    selectedId = selectedId === id ? null : id;
    render();
  }

  function getSelected() {
    return laps.find(l => l.id === selectedId) || null;
  }

  function deleteSelected() {
    if (selectedId != null) deleteLap(selectedId);
  }

  function setGroupSize(n) {
    groupSize = Math.max(1, n);
    render();
  }

  function setLaps(newLaps) {
    laps = newLaps;
    nextId = laps.length ? Math.max(...laps.map(l => l.id)) + 1 : 1;
    selectedId = null;
    Storage.save(laps);
    render();
  }

  function getLaps() { return laps; }

  function getFastestGroup() { return findFastestGroup(groupSize); }

  // ── Render ────────────────────────────────────────────────

  function render() {
    const tbody = document.getElementById('lap-tbody');
    const table = document.getElementById('lap-table');
    const noMsg = document.getElementById('no-laps-msg');
    const countEl = document.getElementById('lap-count');
    const summaryEl = document.getElementById('fastest-summary');

    if (!tbody) return;

    countEl.textContent = laps.length;

    if (laps.length === 0) {
      table.classList.add('hidden');
      noMsg.classList.remove('hidden');
      summaryEl.textContent = '—';
      // Clear any stale overlay state from before the last lap was removed, and
      // still notify subscribers (overlay splits + header buttons) of the empty set.
      const overlayFastest = document.getElementById('overlay-fastest');
      if (overlayFastest) overlayFastest.classList.add('hidden');
      if (typeof VideoPlayer !== 'undefined') VideoPlayer.setFastestIds(new Set());
      if (onChange) onChange(laps);
      return;
    }

    table.classList.remove('hidden');
    noMsg.classList.add('hidden');

    const { ids: fastIds, total: fastTotal } = findFastestGroup(groupSize);

    // Sync fastest IDs into the timer overlay splits
    if (typeof VideoPlayer !== 'undefined') VideoPlayer.setFastestIds(fastIds || new Set());

    // Update fastest summary (sidebar) and overlay
    const overlayFastest = document.getElementById('overlay-fastest');
    if (fastIds && fastIds.size > 0) {
      summaryEl.textContent = `Fastest ${groupSize}: ${formatTime(fastTotal)}`;
      if (overlayFastest) {
        overlayFastest.textContent = `Best ${groupSize}: ${formatTime(fastTotal)}`;
        overlayFastest.classList.remove('hidden');
      }
    } else {
      summaryEl.textContent = `Need ${groupSize}+ complete laps`;
      if (overlayFastest) overlayFastest.classList.add('hidden');
    }

    tbody.innerHTML = '';
    laps.forEach((lap, i) => {
      const dur = lapDuration(lap);
      const tr = document.createElement('tr');
      tr.className = 'lap-row' +
        (lap.id === selectedId ? ' selected' : '') +
        (fastIds && fastIds.has(lap.id) ? ' fastest' : '') +
        (lap.id === flashId ? ' just-added' : '');
      tr.dataset.id = lap.id;

      tr.innerHTML = `
        <td class="lap-num">${i + 1}</td>
        <td>
          <button class="btn-lap-action seek" data-seek="${lap.startTime}" title="Jump to start">
            ${formatTime(lap.startTime)}
          </button>
        </td>
        <td>
          ${lap.endTime != null
            ? `<button class="btn-lap-action seek" data-seek="${lap.endTime}" title="Jump to end">${formatTime(lap.endTime)}</button>`
            : '<span style="color:var(--yellow)">In progress…</span>'}
        </td>
        <td>${dur != null ? formatTime(dur) : '—'}</td>
        <td class="lap-actions">
          <button class="btn-lap-action edit" data-id="${lap.id}" title="Edit lap">Edit</button>
          <button class="btn-lap-action delete" data-id="${lap.id}" title="Delete lap">Del</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    flashId = null;  // one-shot: don't re-flash on subsequent (non-add) renders

    // Wire up row/button events
    tbody.querySelectorAll('.lap-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Don't select row when clicking action buttons
        if (e.target.closest('.btn-lap-action')) return;
        selectLap(Number(row.dataset.id));
      });
    });

    tbody.querySelectorAll('.btn-lap-action.seek').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = parseFloat(btn.dataset.seek);
        if (!isNaN(t)) VideoPlayer.seekTo(t);
      });
    });

    tbody.querySelectorAll('.btn-lap-action.edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(Number(btn.dataset.id));
      });
    });

    tbody.querySelectorAll('.btn-lap-action.delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteLap(Number(btn.dataset.id));
      });
    });

    if (onChange) onChange(laps);
  }

  // ── Edit modal ────────────────────────────────────────────
  // Listeners are wired exactly once in initModal(); openEditModal() only fills
  // the fields and records which lap is being edited. (The previous version
  // re-attached save/cancel handlers on every open and relied on its own close()
  // to detach them — closing the modal another way, e.g. a backdrop click, left
  // them attached and stacked duplicate handlers on the next open.)

  function initModal() {
    const modal      = document.getElementById('edit-modal');
    const startInput = document.getElementById('edit-start');
    const endInput   = document.getElementById('edit-end');
    const errorEl    = document.getElementById('edit-error');
    const saveBtn    = document.getElementById('edit-save');
    const cancelBtn  = document.getElementById('edit-cancel');
    if (!modal) return;

    const closeModal = () => {
      modal.classList.add('hidden');
      if (errorEl) errorEl.classList.add('hidden');
      editingId = null;
    };

    const save = () => {
      if (editingId == null) return;
      const s = parseFloat(startInput.value);
      const e = parseFloat(endInput.value);
      const sv = isNaN(s) ? null : s;
      const ev = isNaN(e) ? null : e;
      // A lap's end must come after its start — block the invalid case instead of
      // silently storing a negative duration (these times feed race results).
      if (sv != null && ev != null && ev <= sv) {
        if (errorEl) errorEl.classList.remove('hidden');
        return;
      }
      updateLap(editingId, sv, ev);
      closeModal();
    };

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (modal.classList.contains('hidden')) return;
      if (e.key === 'Escape')     { e.preventDefault(); closeModal(); }
      else if (e.key === 'Enter') { e.preventDefault(); save(); }
    });
  }

  function openEditModal(id) {
    const lap = laps.find(l => l.id === id);
    if (!lap) return;
    editingId = id;

    const modal      = document.getElementById('edit-modal');
    const startInput = document.getElementById('edit-start');
    const endInput   = document.getElementById('edit-end');
    const errorEl    = document.getElementById('edit-error');

    startInput.value = lap.startTime != null ? lap.startTime.toFixed(3) : '';
    endInput.value   = lap.endTime   != null ? lap.endTime.toFixed(3)   : '';
    if (errorEl) errorEl.classList.add('hidden');

    modal.classList.remove('hidden');
    startInput.focus();
    startInput.select();
  }

  function setOnChange(fn) { onChange = fn; }

  return { init, addLap, updateLap, deleteLap, selectLap, getSelected,
           deleteSelected, setGroupSize, setLaps, getLaps, getFastestGroup, formatTime, setOnChange };
})();
