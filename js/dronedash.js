/* ============================================================
   dronedash.js — Import official lap times from the DroneDash API
   ============================================================

   fpvrebels.com serves live/finished race results (per-pilot holeshot +
   lap durations, millisecond precision) with open CORS, so we fetch it
   directly from the browser. See https://fpvrebels.com/dronedash/api/docs

   The API's times are relative to the race start (StartMs); the app's laps
   are relative to the video. The user supplies the single missing piece —
   where the race sits in the footage — by seeking the video to the race
   start (or their first gate crossing) before importing. All lap boundaries
   are then laid out from official cumulative offsets, so lap durations match
   the transponder times exactly; the anchor only shifts everything uniformly.

   Cumulative offsets are accumulated in integer milliseconds so float drift
   can never move a lap boundary across a millisecond.
   ============================================================ */

const DroneDash = (() => {
  // Every AUFPV-affiliated club found serving the DroneDash API (probed via
  // /dronedash/api/current-meeting.json from https://aufpv.org.au/clubs).
  // FPV Rebels stays first — it's the home club. AUFPV is the national
  // instance (Nationals / AU championships); the rest are alphabetical.
  const CLUBS = [
    { name: 'FPV Rebels',                      base: 'https://fpvrebels.com' },
    { name: 'AUFPV (Nationals)',               base: 'https://aufpv.org.au' },
    { name: 'Adelaide FPV Racing',             base: 'https://adelaide.aufpv.org.au' },
    { name: 'Canberra Multirotor Racing Club', base: 'https://cmrc.aufpv.org.au' },
    { name: 'Eastside FPV',                    base: 'https://eastside.aufpv.org.au' },
    { name: 'MMRC',                            base: 'https://mmrc.aufpv.org.au' },
    { name: 'Outer Heaven Drone Racing',       base: 'https://outerheaven.aufpv.org.au' },
    { name: 'Panorama Drone Racing',           base: 'https://pdr.aufpv.org.au' },
    { name: 'Rotorcross',                      base: 'https://rox.aufpv.org.au' },
  ];

  let races = [];        // races for the loaded meeting
  let race = null;       // selected race
  let pilot = null;      // selected pilot
  let timeTicker = null; // interval updating the "current video time" readout

  const $ = (id) => document.getElementById(id);

  function fmt(sec) { return Laps.formatTime(sec); }

  function currentClub() {
    return CLUBS[Number($('dd-club').value) || 0] || CLUBS[0];
  }

  async function getJSON(path) {
    const res = await fetch(`${currentClub().base}/dronedash/api${path}`,
                            { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }

  function showError(msg) {
    const el = $('dd-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function clearError() { $('dd-error').classList.add('hidden'); }

  function videoLoaded() {
    const container = $('video-container');
    return container && !container.classList.contains('hidden');
  }

  // ── Modal open/close ──────────────────────────────────────

  function open() {
    $('dd-modal').classList.remove('hidden');
    clearError();
    refreshImportState();

    // Live readout of the video time the import will anchor to. Also refreshes
    // the import button, which depends on whether a video is loaded — that can
    // change while the modal is open.
    const timeEl = $('dd-video-time');
    const tick = () => {
      timeEl.textContent = videoLoaded() ? fmt(VideoPlayer.getCurrentTime()) : 'no video loaded';
      refreshImportState();
    };
    tick();
    timeTicker = setInterval(tick, 100);

    // First open: resolve the current meeting and load its races.
    if (races.length === 0) loadRaces();
  }

  function close() {
    $('dd-modal').classList.add('hidden');
    clearInterval(timeTicker);
    timeTicker = null;
  }

  // ── Data loading ──────────────────────────────────────────

  async function loadRaces() {
    const meetingInput = $('dd-meeting').value.trim();
    const q = meetingInput ? `?meeting=${encodeURIComponent(meetingInput)}` : '';
    const nameEl = $('dd-meeting-name');

    clearError();
    nameEl.textContent = 'Loading…';
    setRaceOptions([]);   // reset downstream selects while loading

    try {
      const [meeting, raceList] = await Promise.all([
        getJSON(`/meeting.json${q}`),
        getJSON(`/races.json${q}`),
      ]);

      if (!Array.isArray(raceList) || meeting.loaded === false || raceList.waiting) {
        nameEl.textContent = '';
        showError(meetingInput
          ? `Meeting ${meetingInput} is not loaded on the server.`
          : 'No meeting is currently active — enter a meeting ID.');
        return;
      }

      nameEl.textContent = meeting.Name
        ? `${meeting.Name}${meetingInput ? '' : ' (current meeting)'}`
        : '';
      races = raceList;
      setRaceOptions(races);
    } catch (e) {
      nameEl.textContent = '';
      showError(`Could not reach the DroneDash API (${e.message}).`);
    }
  }

  // ── Select population ─────────────────────────────────────

  function setRaceOptions(list) {
    const sel = $('dd-race');
    sel.innerHTML = '';
    race = null;
    setPilotOptions(null);

    if (!list.length) {
      sel.disabled = true;
      sel.innerHTML = '<option>— load a meeting first —</option>';
      return;
    }

    sel.disabled = false;
    sel.appendChild(new Option('— choose a race —', ''));
    list.forEach((r, i) => {
      const suffix = r.State === 'ended' ? '' : ` [${r.State}]`;
      sel.appendChild(new Option(`${r.Label}${suffix}`, String(i)));
    });
  }

  function setPilotOptions(selectedRace) {
    const sel = $('dd-pilot');
    sel.innerHTML = '';
    pilot = null;
    renderPreview();

    if (!selectedRace || !Array.isArray(selectedRace.Pilots)) {
      sel.disabled = true;
      sel.innerHTML = '<option>— choose a race first —</option>';
      return;
    }

    sel.disabled = false;
    sel.appendChild(new Option('— choose a pilot —', ''));
    selectedRace.Pilots.forEach((p, i) => {
      const laps = p.Laps ? p.Laps.length : 0;
      const opt = new Option(
        `${p.Name} (${p.ChannelLabel}) — ${laps ? `${laps} lap${laps > 1 ? 's' : ''}` : 'no laps'}`,
        String(i)
      );
      opt.disabled = laps === 0;
      sel.appendChild(opt);
    });
  }

  // ── Preview + import ──────────────────────────────────────

  // Crossing offsets from race start, in integer ms: [holeshot end,
  // lap1 end, lap2 end, …]. Lap N runs offsets[N-1] → offsets[N].
  function crossingOffsetsMs(p) {
    const out = [Math.round((p.Holeshot || 0) * 1000)];
    (p.Laps || []).forEach(d => out.push(out[out.length - 1] + Math.round(d * 1000)));
    return out;
  }

  function renderPreview() {
    const box = $('dd-preview');
    if (!pilot || !pilot.Laps || !pilot.Laps.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      refreshImportState();
      return;
    }

    const rows = [`<div class="dd-preview-row"><span>Holeshot</span><span>${fmt(pilot.Holeshot)}</span></div>`];
    pilot.Laps.forEach((d, i) => {
      rows.push(`<div class="dd-preview-row"><span>Lap ${i + 1}</span><span>${fmt(d)}</span></div>`);
    });
    const totalMs = crossingOffsetsMs(pilot)[pilot.Laps.length];
    rows.push(`<div class="dd-preview-row dd-preview-total"><span>Total (incl. holeshot)</span><span>${fmt(totalMs / 1000)}</span></div>`);
    box.innerHTML = rows.join('');
    box.classList.remove('hidden');
    refreshImportState();
  }

  function refreshImportState() {
    const btn = $('dd-import');
    const ready = pilot && pilot.Laps && pilot.Laps.length > 0 && videoLoaded();
    btn.disabled = !ready;
    btn.title = videoLoaded() ? '' : 'Load a video first — the import anchors to the current video time';
  }

  function importLaps() {
    if (!pilot || !race) return;

    const anchor = VideoPlayer.getCurrentTime();
    const mode = document.querySelector('input[name="dd-anchor"]:checked').value;
    const offsets = crossingOffsetsMs(pilot);
    const holeSec = offsets[0] / 1000;

    // Video time of the race start. In "crossing" mode the video sits at the
    // end of the holeshot, so the race started Holeshot seconds earlier.
    const raceStart = mode === 'start' ? anchor : anchor - holeSec;

    const laps = [];
    if ($('dd-include-holeshot').checked) {
      laps.push({ id: laps.length + 1, startTime: raceStart, endTime: raceStart + holeSec });
    }
    for (let i = 0; i < pilot.Laps.length; i++) {
      laps.push({
        id: laps.length + 1,
        startTime: raceStart + offsets[i] / 1000,
        endTime:   raceStart + offsets[i + 1] / 1000,
      });
    }

    if (laps[0].startTime < 0) {
      showError('These laps would start before 0:00 — seek the video to the right spot first.');
      return;
    }
    if (Laps.getLaps().length > 0 &&
        !confirm('Replace the existing laps for this video with the imported ones?')) {
      return;
    }

    // The event's consecutive-laps window (e.g. best 3 consec) drives the
    // "fastest N" group so the app agrees with the official leaderboard.
    if (race.ConsecWindow >= 1) {
      $('group-size').value = race.ConsecWindow;
      Laps.setGroupSize(race.ConsecWindow);
    }

    Laps.setLaps(laps);
    close();
  }

  // ── Init ──────────────────────────────────────────────────

  function init() {
    const modal = $('dd-modal');
    if (!modal) return;

    // Club picker — populated from CLUBS, last choice remembered globally.
    const clubSel = $('dd-club');
    CLUBS.forEach((c, i) => clubSel.appendChild(new Option(c.name, String(i))));
    const savedClub = Storage.loadDroneDashClub();
    const savedIdx = CLUBS.findIndex(c => c.base === savedClub);
    if (savedIdx > 0) clubSel.value = String(savedIdx);
    clubSel.addEventListener('change', () => {
      Storage.saveDroneDashClub(currentClub().base);
      // A different club means a different server — drop the cached meeting.
      races = [];
      $('dd-meeting').value = '';
      $('dd-meeting-name').textContent = '';
      loadRaces();
    });

    $('btn-dronedash').addEventListener('click', open);
    $('dd-cancel').addEventListener('click', close);
    $('dd-load').addEventListener('click', loadRaces);
    $('dd-import').addEventListener('click', importLaps);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (!modal.classList.contains('hidden') && e.key === 'Escape') { e.preventDefault(); close(); }
    });

    $('dd-meeting').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); loadRaces(); }
    });

    $('dd-race').addEventListener('change', (e) => {
      race = e.target.value === '' ? null : races[Number(e.target.value)];
      setPilotOptions(race);
    });

    $('dd-pilot').addEventListener('change', (e) => {
      pilot = (race && e.target.value !== '') ? race.Pilots[Number(e.target.value)] : null;
      renderPreview();
    });
  }

  return { init };
})();
