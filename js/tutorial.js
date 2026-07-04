/* ============================================================
   tutorial.js — First-run walkthrough
   ============================================================

   Opens automatically the first time the page loads; a localStorage flag is
   set as soon as it opens (skipping counts as seen) so it never auto-opens
   again. The ? button in the header replays it any time. Skip closes the
   whole tour in one click; Back / Next (or ← / →) step through it.
   ============================================================ */

const Tutorial = (() => {
  const STEPS = [
    {
      title: 'Welcome to DVR Race Timer',
      body: 'Turn your FPV DVR footage into millisecond-exact lap times. ' +
            'This 30-second tour covers the essentials — <strong>Skip</strong> closes it, ' +
            'and the <strong>?</strong> button in the top bar replays it any time.',
    },
    {
      title: 'Load your footage',
      body: 'Drop a video onto the upload area or click <strong>browse</strong>. ' +
            'MP4, WebM, MKV, MOV and AVI play natively; HDZero <strong>.ts</strong> recordings ' +
            'are demuxed right in the browser.',
    },
    {
      title: 'Mark your laps',
      body: 'Play — or frame-step with <kbd>←</kbd> <kbd>→</kbd> — to each gate crossing and press ' +
            '<kbd>L</kbd>: one press ends the current lap and starts the next. ' +
            'Click a lap’s start/end time to jump there, or <strong>Edit</strong> it to the exact millisecond.',
    },
    {
      title: 'Fastest consecutive laps',
      body: 'Set the group size in the <strong>Fastest Consecutive Laps</strong> panel and your best ' +
            'consecutive run is highlighted green — in the lap table, on the timer overlay, ' +
            'and in the Import from Club preview.',
    },
    {
      title: 'Import from Club',
      body: '<strong>Import from Club</strong> pulls official transponder times from your club’s ' +
            'DroneDash results. Pick your race and pilot, anchor them to the video at the race start, ' +
            'and every lap lands millisecond-exact — with the event’s official consec window applied.',
    },
    {
      title: 'Save and share',
      body: 'Export laps as <strong>JSON</strong> or <strong>CSV</strong> from the header, or burn the race timer ' +
            'overlay into an <strong>MP4</strong> from the video toolbar. Laps auto-save per video — ' +
            'reload the same clip and they come right back. Have a good race!',
    },
  ];

  let idx = 0;
  const $ = (id) => document.getElementById(id);

  function render() {
    $('tutorial-title').textContent = STEPS[idx].title;
    $('tutorial-body').innerHTML = STEPS[idx].body;

    const dots = $('tutorial-dots');
    dots.innerHTML = '';
    STEPS.forEach((_, i) => {
      const d = document.createElement('span');
      d.className = 'tutorial-dot' + (i === idx ? ' active' : '');
      d.title = STEPS[i].title;
      d.addEventListener('click', () => { idx = i; render(); });
      dots.appendChild(d);
    });

    $('tutorial-back').style.visibility = idx === 0 ? 'hidden' : 'visible';
    $('tutorial-next').textContent = idx === STEPS.length - 1 ? 'Done' : 'Next';
  }

  function open() {
    idx = 0;
    render();
    $('tutorial-modal').classList.remove('hidden');
    Storage.markTutorialSeen();   // even a skip counts — never auto-open again
    $('tutorial-next').focus();
  }

  function close() { $('tutorial-modal').classList.add('hidden'); }

  function next() {
    if (idx === STEPS.length - 1) { close(); return; }
    idx++;
    render();
  }

  function back() {
    if (idx === 0) return;
    idx--;
    render();
  }

  function init() {
    const modal = $('tutorial-modal');
    if (!modal) return;

    $('btn-help').addEventListener('click', open);
    $('tutorial-skip').addEventListener('click', close);   // one click, gone
    $('tutorial-next').addEventListener('click', next);
    $('tutorial-back').addEventListener('click', back);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    document.addEventListener('keydown', (e) => {
      if (modal.classList.contains('hidden')) return;
      if (e.key === 'Escape')          { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); back(); }
    });

    if (!Storage.isTutorialSeen()) open();
  }

  return { init, open };
})();
