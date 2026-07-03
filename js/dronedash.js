/* ============================================================
   dronedash.js — Import official lap times from the DroneDash API
   ============================================================

   AUFPV-affiliated club sites serve live/finished race results (per-pilot
   holeshot + lap durations, millisecond precision) with open CORS, so we
   fetch directly from the browser. See https://fpvrebels.com/dronedash/api/docs

   The API's times are relative to the race start (StartMs); the app's laps
   are relative to the video. The user supplies the single missing piece —
   where the race sits in the footage — by seeking the video to the race
   start (or their first gate crossing) before importing. All lap boundaries
   are then laid out from official cumulative offsets, so lap durations match
   the transponder times exactly; the anchor only shifts everything uniformly.

   Cumulative offsets are accumulated in integer milliseconds so float drift
   can never move a lap boundary across a millisecond.

   Nobody knows meeting or race IDs, so both fields are searchable dropdowns:
   meetings come from scraping the club's /events page (also CORS-open) for
   its DroneDash chips, and races match on the label or any pilot name.
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

  // Selected meeting; id '' = the club's current/active meeting.
  let meetingSel = { id: '', label: 'Current meeting' };
  // Club base → [{id,label,sub,search}] scraped from /events, or 'loading'.
  const eventsCache = {};

  let meetingCombo = null;  // combobox instances, created in init()
  let raceCombo = null;

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

  // ── Generic searchable dropdown ───────────────────────────
  // Shared behaviour for the meeting + race fields: type to filter, click or
  // arrows + Enter to choose, Escape closes just the list (not the modal).
  //   rows(q)        matching entries for query q: [{ label, sub?, value }]
  //   choose(row, q) commit a selection (q = query text at choose time)
  //   display()      canonical input text for the current selection
  //   empty()        message when rows(q) is empty
  //   onOpen/onType  optional hooks (prefetch data / invalidate selection)
  function combobox(cfg) {
    const input = $(cfg.input);
    const listEl = $(cfg.list);
    let active = -1;   // keyboard-highlighted row
    let rows = [];     // last rendered row set

    function hide() { listEl.classList.add('hidden'); active = -1; }

    function choose(row) {
      const q = input.value.trim().toLowerCase();
      hide();
      cfg.choose(row, q);
      input.value = cfg.display();
    }

    function render() {
      const q = input.value.trim().toLowerCase();
      rows = cfg.rows(q);
      listEl.innerHTML = '';
      if (!rows.length) {
        const el = document.createElement('div');
        el.className = 'dd-combo-empty';
        el.textContent = cfg.empty();
        listEl.appendChild(el);
      }
      rows.forEach((row, i) => {
        const el = document.createElement('div');
        el.className = 'dd-combo-row' + (i === active ? ' active' : '');
        const label = document.createElement('span');
        label.className = 'dd-combo-label';
        label.textContent = row.label;
        el.appendChild(label);
        if (row.sub) {
          const sub = document.createElement('span');
          sub.className = 'dd-combo-sub';
          sub.textContent = row.sub;
          el.appendChild(sub);
        }
        // mousedown, not click — it must win against the input's blur handler
        el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(row); });
        listEl.appendChild(el);
      });
      listEl.classList.remove('hidden');
    }

    input.addEventListener('focus', () => {
      input.select();
      if (cfg.onOpen) cfg.onOpen();
      render();
    });

    input.addEventListener('input', () => {
      active = -1;
      if (cfg.onType) cfg.onType();
      render();
    });

    // Tidy up on blur: close the list and restore the selection's real name
    // over any half-typed text.
    input.addEventListener('blur', () => {
      hide();
      input.value = cfg.display();
    });

    input.addEventListener('keydown', (e) => {
      const open = !listEl.classList.contains('hidden');
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation();   // just close the list, keep the modal open
        hide();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) render();
        if (!rows.length) return;
        active = e.key === 'ArrowDown'
          ? (active + 1) % rows.length
          : (active - 1 + rows.length) % rows.length;
        render();
        const rowEl = listEl.children[active];
        if (rowEl) rowEl.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!open) render();
        // Enter picks the highlighted row, or the only/first match.
        if (rows.length) choose(rows[active === -1 ? 0 : active]);
      }
    });

    return { render, hide, sync: () => { input.value = cfg.display(); } };
  }

  // ── Modal open/close ──────────────────────────────────────

  function open() {
    $('dd-modal').classList.remove('hidden');
    clearError();
    // The search boxes may hold half-typed queries from last time — show the
    // actual selections rather than stale text.
    meetingCombo.sync();
    raceCombo.sync();
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

  // ── Meeting search (scraped from the club's events page) ──
  // There's no meetings-list endpoint in the read API, but every club site
  // (same platform, CORS open on all pages) lists its events on /events with
  // "⏱ …" DroneDash chips linking ?event=<meeting id> — one fetch per club
  // yields every published meeting with a human-readable name and date.
  async function loadEventsIndex() {
    const base = currentClub().base;
    if (eventsCache[base]) return;
    eventsCache[base] = 'loading';
    try {
      const res = await fetch(`${base}/events`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const out = [];
      doc.querySelectorAll('.event-card').forEach(card => {
        const title = (card.querySelector('h3')?.textContent || 'Event').trim();
        let date = '';
        card.querySelectorAll('.event-meta p').forEach(p => {
          if (p.querySelector('strong')?.textContent === 'Date') {
            date = p.textContent.replace('Date', '').trim();
          }
        });
        card.querySelectorAll('a[href*="dronedash"]').forEach(a => {
          const m = (a.getAttribute('href') || '').match(/[?&]event=(\d+)/);
          if (!m) return;
          // Chip text is the meeting's name, e.g. "⏱ May GQ — Qualifying";
          // strip the leading emoji/spaces. Single-meeting events use a
          // generic "Live timing" chip — show the event's title instead.
          const chip = a.textContent.replace(/^[^\p{L}\p{N}]+/u, '').trim();
          const generic = !chip || /^live timing$/i.test(chip);
          out.push({
            id: m[1],
            label: generic ? title : chip,
            sub: generic ? date : `${title} · ${date}`,
            search: `${title} ${chip}`.toLowerCase(),
          });
        });
      });
      out.sort((a, b) => Number(b.id) - Number(a.id));   // newest first
      eventsCache[base] = out;
    } catch (e) {
      delete eventsCache[base];   // retry on next open
    }
    // If the list is open and was showing "Loading events…", refresh it.
    if (!$('dd-meeting-list').classList.contains('hidden')) meetingCombo.render();
  }

  function meetingRows(q) {
    const rows = [];
    if (!q || 'current meeting'.includes(q)) {
      rows.push({ label: 'Current meeting', sub: 'whatever is live right now', value: '' });
    }
    const evs = eventsCache[currentClub().base];
    if (Array.isArray(evs)) {
      evs.forEach(ev => {
        if (!q || ev.search.includes(q) || ev.id === q) {
          rows.push({ label: ev.label, sub: ev.sub, value: ev.id });
        }
      });
    }
    // Raw-ID escape hatch for meetings not published on the events page.
    if (/^\d+$/.test(q) && !rows.some(r => r.value === q)) {
      rows.push({ label: `Meeting ID ${q}`, sub: 'load by raw id', value: q });
    }
    return rows;
  }

  function meetingEmpty() {
    return eventsCache[currentClub().base] === 'loading'
      ? 'Loading events…'
      : 'No events match — try a meeting ID';
  }

  function chooseMeeting(row) {
    meetingSel = { id: row.value, label: row.label };
    loadRaces();
  }

  // ── Data loading ──────────────────────────────────────────

  async function loadRaces() {
    const q = meetingSel.id ? `?meeting=${encodeURIComponent(meetingSel.id)}` : '';
    const nameEl = $('dd-meeting-name');

    clearError();
    nameEl.textContent = 'Loading…';
    setRaceOptions([]);   // reset downstream fields while loading

    try {
      const [meeting, raceList] = await Promise.all([
        getJSON(`/meeting.json${q}`),
        getJSON(`/races.json${q}`),
      ]);

      if (!Array.isArray(raceList) || meeting.loaded === false || raceList.waiting) {
        nameEl.textContent = '';
        showError(meetingSel.id
          ? `Meeting ${meetingSel.id} is not loaded on the server.`
          : 'No meeting is currently active — search for an event above.');
        return;
      }

      // Show the meeting's official name once known.
      if (meeting.Name) {
        meetingSel.label = meeting.Name;
        meetingCombo.sync();
      }
      nameEl.textContent = meeting.Name
        ? `${meeting.Name}${meetingSel.id ? '' : ' (current meeting)'}`
        : '';
      races = raceList;
      setRaceOptions(races);
    } catch (e) {
      nameEl.textContent = '';
      showError(`Could not reach the DroneDash API (${e.message}).`);
    }
  }

  // ── Race search ───────────────────────────────────────────
  // A plain <select> of "Round 3 — Race 7" labels is useless when a meeting
  // has 60+ heats and nobody knows their race number — so the race field
  // matches the race label OR any pilot name in it.

  function raceDisplayName(r) {
    return r.Label + (r.State === 'ended' ? '' : ` [${r.State}]`);
  }

  function setRaceOptions(list) {
    const input = $('dd-race-search');
    input.value = '';
    race = null;
    setPilotOptions(null);
    raceCombo.hide();

    input.disabled = !list.length;
    input.placeholder = list.length
      ? 'Type a pilot or race name…'
      : '— load a meeting first —';
  }

  function raceRows(q) {
    const rows = [];
    races.forEach((r, i) => {
      const pilots = (r.Pilots || []).map(p => p.Name).join(', ');
      if (!q || raceDisplayName(r).toLowerCase().includes(q) || pilots.toLowerCase().includes(q)) {
        rows.push({ label: raceDisplayName(r), sub: pilots, value: i });
      }
    });
    return rows;
  }

  function chooseRace(row, q) {
    race = races[row.value];
    setPilotOptions(race);

    // If the search was a pilot's name, that's who they're after — preselect
    // them (first match with laps, since lap-less entries can't be imported).
    if (q && Array.isArray(race.Pilots)) {
      const pi = race.Pilots.findIndex(p =>
        p.Name.toLowerCase().includes(q) && p.Laps && p.Laps.length);
      if (pi !== -1) {
        $('dd-pilot').value = String(pi);
        pilot = race.Pilots[pi];
        renderPreview();
      }
    }
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
      meetingSel = { id: '', label: 'Current meeting' };
      meetingCombo.sync();
      $('dd-meeting-name').textContent = '';
      loadRaces();
    });

    meetingCombo = combobox({
      input: 'dd-meeting-search',
      list: 'dd-meeting-list',
      rows: meetingRows,
      choose: chooseMeeting,
      display: () => meetingSel.label,
      empty: meetingEmpty,
      onOpen: loadEventsIndex,
    });

    raceCombo = combobox({
      input: 'dd-race-search',
      list: 'dd-race-list',
      rows: raceRows,
      choose: chooseRace,
      display: () => race ? raceDisplayName(race) : '',
      empty: () => 'No race or pilot matches',
      // Typing invalidates the previous selection.
      onType: () => { race = null; setPilotOptions(null); },
    });

    $('btn-dronedash').addEventListener('click', open);
    $('dd-cancel').addEventListener('click', close);
    $('dd-import').addEventListener('click', importLaps);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (!modal.classList.contains('hidden') && e.key === 'Escape') { e.preventDefault(); close(); }
    });

    $('dd-pilot').addEventListener('change', (e) => {
      pilot = (race && e.target.value !== '') ? race.Pilots[Number(e.target.value)] : null;
      renderPreview();
    });
  }

  return { init };
})();
