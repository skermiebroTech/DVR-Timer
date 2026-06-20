/* ============================================================
   export.js — JSON and CSV export / JSON import
   ============================================================ */

const Export = (() => {
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  function toJSON() {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      laps: Laps.getLaps()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${baseName()}-laps-${dateStamp()}.json`);
  }

  function toCSV() {
    const laps = Laps.getLaps();
    const rows = [['Lap', 'Start (s)', 'End (s)', 'Duration (s)', 'Start', 'End', 'Duration']];
    laps.forEach((lap, i) => {
      const dur = (lap.startTime != null && lap.endTime != null)
        ? (lap.endTime - lap.startTime).toFixed(3)
        : '';
      rows.push([
        i + 1,
        lap.startTime != null ? lap.startTime.toFixed(3) : '',
        lap.endTime   != null ? lap.endTime.toFixed(3)   : '',
        dur,
        Laps.formatTime(lap.startTime),
        Laps.formatTime(lap.endTime),
        dur !== '' ? Laps.formatTime(parseFloat(dur)) : ''
      ]);
    });
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    downloadBlob(blob, `${baseName()}-laps-${dateStamp()}.csv`);
  }

  function fromJSON(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        const imported = Array.isArray(data) ? data
          : (data.laps && Array.isArray(data.laps)) ? data.laps
          : null;
        if (!imported) { alert('Invalid JSON format.'); return; }
        // Validate shape
        const valid = imported.every(l =>
          typeof l.id === 'number' &&
          (l.startTime == null || typeof l.startTime === 'number') &&
          (l.endTime   == null || typeof l.endTime   === 'number')
        );
        if (!valid) { alert('JSON lap data is malformed.'); return; }
        Laps.setLaps(imported);
      } catch {
        alert('Could not parse JSON file.');
      }
    };
    reader.readAsText(file);
  }

  function dateStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  // Prefix exports with the loaded source clip's name (falling back to 'race'
  // when none is loaded). ExportFfmpeg owns the source File.
  function baseName() {
    return (typeof ExportFfmpeg !== 'undefined' && ExportFfmpeg.sourceBaseName()) || 'race';
  }

  return { toJSON, toCSV, fromJSON };
})();
