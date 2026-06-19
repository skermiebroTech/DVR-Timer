/* ============================================================
   transcode.js — Browser compatibility layer for video formats
   ============================================================

   .ts / .m2ts (MPEG Transport Stream):
     Uses mpegts.js, a lightweight MSE-based demuxer. It feeds the
     TS data directly to the browser's video decoder via MediaSource
     Extensions — no WASM, no re-encode, no large binary download.
     The video element behaves normally (timeupdate, canplay, seek, etc.)

     Duration: mpegts.js reports Infinity for .ts files because MPEG-TS
     containers have no duration header. We parse PTS timestamps directly
     from the file's binary data: read first PTS near the start and last
     PTS near the end, then compute (lastPTS - firstPTS) / 90000 seconds.
     This is fast (two small reads, ~375 KB total) and works for any size.

   .mov (QuickTime):
     Chrome supports H.264 MOV natively, which covers HDZero and most
     DVR recordings. We load it directly and only show an error if the
     browser fires a hard media error event (e.g. ProRes or HEVC).
   ============================================================ */

const Transcoder = (() => {
  const TS_PACKET = 188; // MPEG-TS packet size is always 188 bytes

  // ── mpegts.js player lifecycle ────────────────────────────

  let activePlayer  = null;
  let tsFile        = null;   // retained so seekTsTo can rebuild the player
  let tsBlobUrl     = null;
  let tsVideoEl     = null;
  let tsSeekBusy    = false;  // guard against re-entrant seeks
  let tsFirstPTS    = null;   // first PTS of the whole file (90 kHz), cached

  // HDZero records at ~50 Mbps. At that bitrate Chrome's MSE SourceBuffer
  // fills up in ~3 s. Keep the forward buffer very small and clean up
  // backward data aggressively so we never hit the hard cap.
  const MPEGTS_CONFIG = {
    enableWorker: false,
    seekType: 'range',
    accurateSeek: false,       // true causes extra buffering; not needed here
    lazyLoadMaxDuration: 8,    // buffer 8 s ahead (~50 MB at 50 Mbps)
    lazyLoadRecoverDuration: 4,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 8,
    autoCleanupMinBackwardDuration: 3,
    enableStashBuffer: false,  // disable stash to reduce peak memory
  };

  let tsErrorCb = null;
  // Register a handler for fatal playback errors (e.g. a browser whose decoder
  // rejects the stream). Called as (type, detail, info).
  function onTsError(cb) { tsErrorCb = cb; }

  function _createPlayer(url, videoEl) {
    const player = mpegts.createPlayer({ type: 'mpegts', url, isLive: false }, MPEGTS_CONFIG);
    // Surface errors instead of failing to a silent black screen. The common one
    // is Firefox/macOS handing H.264 to Apple VideoToolbox, which rejects some
    // HDZero bitstreams (MEDIA_ERROR / decode error) even though Chrome plays them.
    player.on(mpegts.Events.ERROR, (type, detail, info) => {
      console.error('[DVR] mpegts error:', type, detail, info);
      if (tsErrorCb) tsErrorCb(type, detail, info);
    });
    player.attachMediaElement(videoEl);
    player.load();
    activePlayer = player;
    return player;
  }

  function loadTsFile(file, videoEl) {
    destroyActive();
    if (tsBlobUrl) URL.revokeObjectURL(tsBlobUrl);
    tsFile     = file;
    tsVideoEl  = videoEl;
    tsFirstPTS = null;
    tsBlobUrl  = URL.createObjectURL(file);
    return _createPlayer(tsBlobUrl, videoEl);
  }

  /**
   * Seek a .ts file to approximately `targetTime` (seconds) given `totalDuration`.
   *
   * mpegts.js resets PTS to ~0 for every new player instance, so we cannot
   * simply recreate the player and then set video.currentTime — it would show
   * the wrong time. Instead we:
   *   1. Estimate the byte offset: (targetTime / totalDuration) × fileSize
   *   2. Slice the File from that offset (sub-blob)
   *   3. Create a new mpegts.js player pointing at the sub-blob
   *   4. Return `startTime` — the caller adds this as a timeOffset so that
   *      actualTime() = video.currentTime + timeOffset reflects the real
   *      position in the original file.
   *
   * We start 3 s before the target so the stream includes a keyframe and
   * playback begins cleanly.
   *
   * The byte estimate assumes constant bitrate, but DVR footage is variable
   * bitrate, so the real time at `aligned` differs from `startTime` — and the
   * error changes with seek position. For a competitive timer that drift is
   * unacceptable, so we don't trust the estimate for timing: once the slice is
   * known we parse its *actual* first PTS and report the exact offset via
   * `onOffset`. The returned `startTime` is only a provisional value to keep the
   * display sane during the brief load.
   *
   * @param {number}   targetTime    — desired real time in the file (seconds)
   * @param {number}   totalDuration — from PTS parser (seconds)
   * @param {Function} [onReady]     — called after canplay fires on the new player
   * @param {Function} [onOffset]    — called with the exact PTS-derived offset (seconds)
   * @returns {number} startTime — provisional offset; refined async via onOffset
   */
  function seekTsTo(targetTime, totalDuration, onReady, onOffset) {
    if (!tsFile || !tsVideoEl) return targetTime;
    if (tsSeekBusy) return targetTime;
    tsSeekBusy = true;

    if (activePlayer) {
      try { activePlayer.destroy(); } catch (_) {}
      activePlayer = null;
    }

    // Go back 3 s from target to include a keyframe before the cut point
    const startTime = Math.max(0, targetTime - 3);
    const fraction  = totalDuration > 0 ? startTime / totalDuration : 0;
    const byteStart = Math.floor(fraction * tsFile.size);
    const aligned   = Math.floor(byteStart / TS_PACKET) * TS_PACKET;

    // Release previous sub-blob if any
    if (tsBlobUrl) { URL.revokeObjectURL(tsBlobUrl); tsBlobUrl = null; }
    tsBlobUrl = URL.createObjectURL(tsFile.slice(aligned));

    _createPlayer(tsBlobUrl, tsVideoEl);

    // Exact elapsed time at the slice start, parsed from PTS (replaces the
    // constant-bitrate estimate). Used both to report the real time offset and
    // to land precisely on the requested frame. Falls back to the estimate.
    const offsetPromise = getSliceStartTime(aligned)
      .then(real => (real != null ? real : startTime))
      .catch(() => startTime);
    // Report the corrected offset for the time display as soon as it's known.
    if (onOffset) offsetPromise.then(off => onOffset(off));

    // Clear the busy guard on canplay, with a timeout fallback so a seek that
    // never reaches canplay (e.g. targeting EOF) can't deadlock all future seeks.
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      tsSeekBusy = false;
      // The slice begins ~3 s before the target (for a keyframe). Now seek
      // forward *within* the slice to the exact target so the frame on screen
      // matches the requested time — otherwise every seek lands at a different
      // keyframe before the mark, making lap positions drift.
      offsetPromise.then(off => {
        const within = Math.max(0, targetTime - off);
        if (within > 0.02) {
          // Hide the hold-over frame only once the precise frame is painted.
          tsVideoEl.addEventListener('seeked', () => { if (onReady) onReady(); }, { once: true });
          try { tsVideoEl.currentTime = within; }
          catch (_) { if (onReady) onReady(); }
        } else if (onReady) {
          onReady();
        }
      });
    };
    tsVideoEl.addEventListener('canplay', finish, { once: true });
    setTimeout(finish, 5000);

    return startTime; // provisional; refined async via onOffset
  }

  function destroyActive() {
    if (activePlayer) {
      try { activePlayer.destroy(); } catch (_) {}
      activePlayer = null;
    }
    if (tsBlobUrl) { URL.revokeObjectURL(tsBlobUrl); tsBlobUrl = null; }
    tsFile     = null;
    tsVideoEl  = null;
    tsSeekBusy = false;
    tsFirstPTS = null;
  }

  function isTsActive() { return activePlayer !== null; }

  // ── TS duration parser ────────────────────────────────────

  const PTS_HZ        = 90000;          // PTS clock rate
  const PTS_ROLLOVER  = (2 ** 33) / PTS_HZ; // seconds in one 33-bit PTS wrap (~26.5 h)
  const SCAN_PACKETS  = 2000;           // packets read per probe (~375 KB)

  /**
   * First PTS of the whole file (90 kHz units), cached for the loaded .ts.
   * This is the timeline zero that all real times are measured from.
   */
  async function getFileFirstPTS() {
    if (tsFirstPTS != null) return tsFirstPTS;
    if (!tsFile) return null;
    const buf = new Uint8Array(await tsFile.slice(0, TS_PACKET * SCAN_PACKETS).arrayBuffer());
    const syncOffset = findSyncOffset(buf);
    if (syncOffset === -1) return null;
    const pts = findFirstPTS(buf, syncOffset);
    if (pts !== null) tsFirstPTS = pts;
    return tsFirstPTS;
  }

  // Packets to scan for the slice's first keyframe. Must span more than one GOP
  // (~1 s ≈ 4.5 MB at 36 Mbps) since the keyframe can be up to a GOP past the
  // slice start. ~7.5 MB gives comfortable margin.
  const KEYFRAME_SCAN_PACKETS = 40000;

  /**
   * Exact elapsed time (seconds) that mpegts.js will map to currentTime=0 for a
   * sub-blob sliced at `byteOffset`: the real time of the slice's first VIDEO
   * KEYFRAME minus the file's first PTS.
   *
   * It must be the keyframe, not merely the first PTS — mpegts.js discards the
   * pre-keyframe audio/partial frames and normalises the timeline to the first
   * decodable keyframe. Using the first PTS makes the on-screen picture lead the
   * reported time by up to one GOP (~1 s). Frame-accurate and stable across
   * seeks. Returns null if parsing fails (caller keeps the estimate).
   */
  async function getSliceStartTime(byteOffset) {
    if (!tsFile) return null;
    const firstPTS = await getFileFirstPTS();
    if (firstPTS == null) return null;
    const buf = new Uint8Array(
      await tsFile.slice(byteOffset, byteOffset + TS_PACKET * KEYFRAME_SCAN_PACKETS).arrayBuffer()
    );
    const syncOffset = findSyncOffset(buf);
    if (syncOffset === -1) return null;
    let slicePTS = findFirstKeyframePTS(buf, syncOffset);
    if (slicePTS === null) slicePTS = findFirstPTS(buf, syncOffset); // fallback
    if (slicePTS === null) return null;
    let delta = (slicePTS - firstPTS) / PTS_HZ;
    if (delta < 0) delta += PTS_ROLLOVER; // 33-bit PTS rollover
    return delta;
  }

  /**
   * Extract duration from a .ts file by parsing PTS values directly.
   * Reads ~375 KB total (first 2000 packets + last 2000 packets).
   * Returns duration in seconds, or null if parsing fails.
   */
  async function getTsDuration(file) {
    try {
      // Read first chunk to find sync byte and first PTS
      const startBytes = TS_PACKET * SCAN_PACKETS;
      const startBuf = new Uint8Array(await file.slice(0, startBytes).arrayBuffer());

      // Find TS sync offset (first 0x47 that repeats every 188 bytes)
      const syncOffset = findSyncOffset(startBuf);
      if (syncOffset === -1) return null;

      const firstPTS = findFirstPTS(startBuf, syncOffset);
      if (firstPTS === null) return null;
      // Cache for seek-offset math (same value getFileFirstPTS would compute).
      if (file === tsFile && tsFirstPTS == null) tsFirstPTS = firstPTS;

      // Read last chunk to find last PTS
      const endBytes  = TS_PACKET * SCAN_PACKETS;
      const endStart  = Math.max(syncOffset, file.size - endBytes);
      const endBuf    = new Uint8Array(await file.slice(endStart).arrayBuffer());
      const lastPTS   = findLastPTS(endBuf, 0);
      if (lastPTS === null) return null;

      // PTS clock runs at 90 kHz; handle 33-bit rollover (~26.5 h)
      let duration = (lastPTS - firstPTS) / PTS_HZ;
      if (duration < 0) duration += PTS_ROLLOVER;
      return duration > 0 ? duration : null;
    } catch (err) {
      console.error('[DVR] getTsDuration error:', err);
      return null;
    }
  }

  /** Locate the first sync byte offset where 0x47 repeats every 188 bytes. */
  function findSyncOffset(buf) {
    for (let i = 0; i < TS_PACKET; i++) {
      if (buf[i] === 0x47 && buf[i + TS_PACKET] === 0x47 && buf[i + TS_PACKET * 2] === 0x47) {
        return i;
      }
    }
    return -1;
  }

  /** Return first PTS found scanning forward through TS packets. */
  function findFirstPTS(buf, syncOffset) {
    for (let offset = syncOffset; offset + TS_PACKET <= buf.length; offset += TS_PACKET) {
      const r = extractPTS(buf, offset);
      if (r !== null) return r.pts;
    }
    return null;
  }

  /**
   * Return the PTS of the first VIDEO keyframe — the packet whose adaptation
   * field has random_access_indicator set. mpegts.js can only start decoding at
   * a keyframe, so this is the frame it normalises to currentTime=0. Returns
   * null if none is found in the buffer (caller falls back to first PTS).
   */
  function findFirstKeyframePTS(buf, syncOffset) {
    for (let offset = syncOffset; offset + TS_PACKET <= buf.length; offset += TS_PACKET) {
      const r = extractPTS(buf, offset);
      if (r !== null && r.rai === 1 && r.streamId >= 0xE0 && r.streamId <= 0xEF) return r.pts;
    }
    return null;
  }

  /** Return last PTS found scanning backward through TS packets. */
  function findLastPTS(buf, syncOffset) {
    // Align to packet boundary from the start of this chunk
    const aligned = syncOffset !== -1 ? findSyncOffset(buf) : 0;
    const start = aligned === -1 ? 0 : aligned;
    let last = null;
    for (let offset = start; offset + TS_PACKET <= buf.length; offset += TS_PACKET) {
      const r = extractPTS(buf, offset);
      if (r !== null) last = r.pts;
    }
    return last;
  }

  /**
   * Detect the video frame duration (seconds) by parsing presentation
   * timestamps from the start of the file (~1.5 MB read). Frame-accurate and
   * independent of playback or tab visibility — unlike requestVideoFrameCallback,
   * which doesn't fire for backgrounded tabs. Returns null if undetermined.
   */
  async function getFrameDuration() {
    if (!tsFile) return null;
    try {
      const buf = new Uint8Array(await tsFile.slice(0, TS_PACKET * 8000).arrayBuffer());
      const sync = findSyncOffset(buf);
      if (sync === -1) return null;
      const ptsList = [];
      for (let o = sync; o + TS_PACKET <= buf.length; o += TS_PACKET) {
        const r = extractPTS(buf, o);
        if (r && r.streamId >= 0xE0 && r.streamId <= 0xEF) ptsList.push(r.pts); // video only
      }
      if (ptsList.length < 4) return null;
      // Video PTS arrive in decode order (B-frames reorder them); sort, then the
      // gaps between consecutive values are the frame period. PTS carry ±1–2
      // units of rounding jitter, so take the MEDIAN gap, not the minimum — a
      // too-short period would make a forward step land inside the same frame.
      ptsList.sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < ptsList.length; i++) {
        const g = ptsList[i] - ptsList[i - 1];
        if (g > 0) gaps.push(g);
      }
      if (gaps.length < 3) return null;
      gaps.sort((a, b) => a - b);
      const medianGap = gaps[Math.floor(gaps.length / 2)];
      const dur = medianGap / PTS_HZ;
      return (dur > 0.002 && dur < 0.2) ? dur : null; // sane bounds: 5–500 fps
    } catch (err) {
      console.error('[DVR] getFrameDuration error:', err);
      return null;
    }
  }

  /**
   * Try to extract a PTS value from a single TS packet at `offset`.
   * Returns the PTS (integer, 90 kHz units) or null.
   *
   * TS packet layout:
   *   [0]      sync byte (0x47)
   *   [1-3]    header flags including payload_unit_start_indicator (bit 6 of byte 1)
   *            and adaptation_field_control (bits 5-4 of byte 3)
   *   [4+]     optional adaptation field, then PES payload
   *
   * PES header layout (when payload_unit_start_indicator = 1):
   *   [0-2]    start code 0x00 0x00 0x01
   *   [3]      stream_id (0xE0-0xEF = video, 0xC0-0xDF = audio)
   *   [4-5]    PES packet length
   *   [6]      flags (first 2 bits always '10')
   *   [7]      PTS_DTS_flags in bits 7-6 ('10' = PTS only, '11' = PTS+DTS)
   *   [8]      PES header data length
   *   [9-13]   PTS (5 bytes, 3 marker bits interleaved)
   */
  function extractPTS(buf, offset) {
    if (buf[offset] !== 0x47) return null;

    const byte1 = buf[offset + 1];
    const byte3 = buf[offset + 3];

    // payload_unit_start_indicator must be set
    if ((byte1 & 0x40) === 0) return null;

    // adaptation_field_control: bits 5-4 of byte 3
    const afc = (byte3 >> 4) & 0x03;
    // 0b00 = reserved, 0b10 = adaptation only (no payload), skip both
    if (afc === 0x00 || afc === 0x02) return null;

    // Calculate where the payload starts, and read the random_access_indicator
    // (adaptation flags bit 6) — set on packets that begin a keyframe/RAP.
    let payloadStart = offset + 4;
    let rai = 0;
    if (afc === 0x03) {
      // adaptation field present + payload
      const afLen = buf[offset + 4];
      if (afLen > 0) rai = (buf[offset + 5] & 0x40) ? 1 : 0;
      payloadStart = offset + 5 + afLen;
    }
    // afc === 0x01: no adaptation field, payload starts at offset+4

    // PES start code check
    if (payloadStart + 14 > buf.length) return null;
    if (buf[payloadStart] !== 0x00 || buf[payloadStart + 1] !== 0x00 || buf[payloadStart + 2] !== 0x01) return null;

    const streamId = buf[payloadStart + 3];
    // Only audio (0xC0-0xDF) and video (0xE0-0xEF) carry PTS
    if (streamId < 0xC0 || streamId > 0xEF) return null;

    const ptsDtsFlags = (buf[payloadStart + 7] >> 6) & 0x03;
    if (ptsDtsFlags < 2) return null; // no PTS present

    const p = payloadStart + 9; // first byte of PTS field
    if (p + 5 > buf.length) return null;

    // Extract 33-bit PTS from 5-byte marker-interleaved field.
    // PTS[32:30] lives in bits 3:1 of buf[p], so we shift right 1 then left 30.
    // Use multiplication for the top bits to stay in safe float range (avoids
    // signed 32-bit overflow from JS bitwise ops).
    const pts =
      (((buf[p]     & 0x0E) * 0x20000000) +  // PTS[32:30]: (val>>1)<<30 = val * 2^29
       ( (buf[p + 1] & 0xFF) << 22) +          // PTS[29:22]
       (((buf[p + 2] & 0xFE) >> 1) << 15) +    // PTS[21:15]
       ( (buf[p + 3] & 0xFF) << 7) +            // PTS[14:7]
       (  (buf[p + 4] & 0xFE) >> 1));            // PTS[6:0]

    return { pts, streamId, rai };
  }

  // ── Format detection ──────────────────────────────────────

  function isTsFile(file)  { return /\.(ts|m2ts|mts)$/i.test(file.name); }
  function isMovFile(file) { return /\.mov$/i.test(file.name); }

  return { loadTsFile, seekTsTo, isTsActive, destroyActive, isTsFile, isMovFile, getTsDuration, getFrameDuration, onTsError };
})();
