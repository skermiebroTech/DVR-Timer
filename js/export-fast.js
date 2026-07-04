/* ============================================================
   export-fast.js — Hardware-accelerated MP4 export via WebCodecs
   ============================================================

   The ffmpeg.wasm path (export-ffmpeg.js run()) software-encodes H.264 on a
   single WASM thread — measured ~9× slower than realtime. This path replaces
   the decode → composite → encode stages with WebCodecs (hardware-accelerated
   in Chrome/Edge), keeping ffmpeg.wasm only for what it's uniquely good at:
   container work (muxing the encoded H.264 with the source's audio).

     1. Demux the source ourselves:
          .ts       — a small streaming MPEG-TS parser below (same PES/PTS
                      structures transcode.js already parses) yields H.264
                      access units + exact PTS from 8 MB file slices, so a
                      multi-GB file is never held in memory.
          .mp4/.mov — mp4box.js (vendored, lazy-loaded) yields the same.
     2. VideoDecoder decodes; each output frame carries its exact source PTS.
     3. For every output frame k the canvas composites the source frame that
        is on screen at t = trimStart + k/fps, then OverlayRender draws the
        timer at exactly t — the same time mapping, the same renderer, and
        therefore the same millisecond-exact burned-in digits as the slow path.
     4. VideoEncoder (H.264, Annex B) encodes the composite.
     5. ffmpeg.wasm muxes the H.264 stream + source audio (AAC) into the MP4.

   Timeline convention (must match the player): for .ts, time 0 is the file's
   first PTS — the same zero Transcoder's duration/seek math uses, and the same
   zero ffmpeg assumes for the audio's -ss in the mux step. For MP4/MOV, sample
   CTS is already player time.

   Anything unexpected (no WebCodecs, non-H.264 track, undecodable stream,
   B-frame reordering, parse failure) throws — the caller falls back to the
   proven ffmpeg-only path, so this is strictly an accelerator, never a new
   failure mode.
   ============================================================ */

const ExportFast = (() => {
  const TS_PACKET = 188;
  const PTS_HZ = 90000;
  const PTS_ROLLOVER = 2 ** 33;           // 33-bit PTS wrap, in 90 kHz ticks
  const SLICE_BYTES = 8 * 1024 * 1024;    // file read granularity

  let cancelled = false;
  function cancel() { cancelled = true; }

  function supported() {
    return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined'
        && typeof OffscreenCanvas !== 'undefined';
  }

  class Unsupported extends Error {}

  // ── Small shared helpers ──────────────────────────────────

  // WebCodecs codec string (avc1.PPCCLL) from the SPS in an Annex B stream.
  // (Same derivation as Transcoder.h264CodecString, which isn't exported.)
  function codecFromSPS(es) {
    for (let i = 0; i + 5 < es.length; i++) {
      if (es[i] !== 0 || es[i + 1] !== 0) continue;
      let nal = -1;
      if (es[i + 2] === 1) nal = i + 3;
      else if (es[i + 2] === 0 && es[i + 3] === 1) nal = i + 4;
      if (nal === -1) continue;
      if ((es[nal] & 0x1F) === 7) {
        const hex = (b) => b.toString(16).padStart(2, '0');
        return `avc1.${hex(es[nal + 1])}${hex(es[nal + 2])}${hex(es[nal + 3])}`;
      }
      i = nal;
    }
    return null;
  }

  // Key/delta from the first VCL NAL (IDR=5 vs non-IDR=1). The scan stops at
  // the first VCL NAL, which sits just past the AUD/SPS/PPS/SEI headers.
  function isKeyAU(es) {
    for (let i = 0; i + 5 < es.length; i++) {
      if (es[i] !== 0 || es[i + 1] !== 0) continue;
      let nal = -1;
      if (es[i + 2] === 1) nal = i + 3;
      else if (es[i + 2] === 0 && es[i + 3] === 1) nal = i + 4;
      if (nal === -1) continue;
      const type = es[nal] & 0x1F;
      if (type === 5) return true;
      if (type === 1) return false;
      i = nal;
    }
    return false;
  }

  function concatParts(parts, total) {
    const out = new Uint8Array(total);
    let w = 0;
    for (const p of parts) { out.set(p, w); w += p.length; }
    return out;
  }

  // ── MPEG-TS access-unit reader ────────────────────────────
  // Pull-based: next() resolves to { data, ptsSec, key } or null at EOF.
  // Reads the file in slices; one PES packet (PUSI → PUSI) = one access unit,
  // which holds for HDZero and every TS camera DVR we've seen. PTS is exact
  // 90 kHz math, zeroed on the file's first PTS of any stream — the same
  // timeline zero the player and the duration parser use.
  function createTsReader(file) {
    let filePos = 0;
    let carry = new Uint8Array(0);
    let synced = false;
    let videoPid = -1;
    let firstPTS = null;
    let cur = null;              // { parts, total, ptsSec } AU being assembled
    const ready = [];            // completed AUs

    function ptsToSec(pts) {
      if (firstPTS == null) firstPTS = pts;
      let d = pts - firstPTS;
      if (d < -PTS_ROLLOVER / 2) d += PTS_ROLLOVER;   // wrapped mid-file
      return d / PTS_HZ;
    }

    function flushCur() {
      if (!cur) return;
      const data = concatParts(cur.parts, cur.total);
      if (data.length && cur.ptsSec != null) {
        ready.push({ data, ptsSec: cur.ptsSec, key: isKeyAU(data) });
      }
      cur = null;
    }

    // Parse every complete packet in buf; return the leftover tail.
    function parse(buf) {
      let o = 0;
      if (!synced) {
        // Find the first offset where 0x47 repeats every 188 bytes.
        let s = -1;
        for (let i = 0; i < TS_PACKET && i + 2 * TS_PACKET < buf.length; i++) {
          if (buf[i] === 0x47 && buf[i + TS_PACKET] === 0x47 && buf[i + 2 * TS_PACKET] === 0x47) { s = i; break; }
        }
        if (s === -1) throw new Unsupported('not an MPEG-TS stream');
        o = s;
        synced = true;
      }
      for (; o + TS_PACKET <= buf.length; o += TS_PACKET) {
        if (buf[o] !== 0x47) throw new Unsupported('lost TS sync');
        const pusi = (buf[o + 1] & 0x40) !== 0;
        const pid  = ((buf[o + 1] & 0x1F) << 8) | buf[o + 2];
        const afc  = (buf[o + 3] >> 4) & 0x03;
        if (afc === 0x00 || afc === 0x02) continue;           // no payload
        let p = o + 4;
        if (afc === 0x03) p = o + 5 + buf[o + 4];             // skip adaptation field
        if (p >= o + TS_PACKET) continue;

        if (pusi && p + 9 <= buf.length &&
            buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1) {
          const streamId = buf[p + 3];
          // Record the file's timeline zero from the first PTS of ANY stream.
          if (firstPTS == null && streamId >= 0xC0 && streamId <= 0xEF) {
            const early = readPTS(buf, p);
            if (early != null) firstPTS = early;
          }
          if (videoPid === -1 && streamId >= 0xE0 && streamId <= 0xEF) videoPid = pid;
        }
        if (pid !== videoPid || videoPid === -1) continue;

        if (pusi) {
          flushCur();
          // PES header: start code + stream id + length + flags + PTS.
          if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
          const pts = readPTS(buf, p);
          if (pts == null) throw new Unsupported('video PES without PTS');
          const esStart = p + 9 + buf[p + 8];
          cur = { parts: [], total: 0, ptsSec: ptsToSec(pts) };
          if (esStart < o + TS_PACKET) {
            const part = buf.subarray(esStart, o + TS_PACKET);
            cur.parts.push(part); cur.total += part.length;
          }
        } else if (cur) {
          const part = buf.subarray(p, o + TS_PACKET);
          cur.parts.push(part); cur.total += part.length;
        }
      }
      return buf.subarray(o);
    }

    function readPTS(buf, pesStart) {
      const flags = (buf[pesStart + 7] >> 6) & 0x03;
      if (flags < 2) return null;
      const q = pesStart + 9;
      if (q + 5 > buf.length) return null;
      return ((buf[q] & 0x0E) * 0x20000000) +
             ((buf[q + 1] & 0xFF) << 22) +
             (((buf[q + 2] & 0xFE) >> 1) << 15) +
             ((buf[q + 3] & 0xFF) << 7) +
             ((buf[q + 4] & 0xFE) >> 1);
    }

    async function next() {
      while (ready.length === 0) {
        if (filePos >= file.size) { flushCur(); return ready.shift() || null; }
        const slice = new Uint8Array(
          await file.slice(filePos, filePos + SLICE_BYTES).arrayBuffer());
        filePos += slice.length;
        let buf = slice;
        if (carry.length) {
          buf = new Uint8Array(carry.length + slice.length);
          buf.set(carry); buf.set(slice, carry.length);
        }
        carry = parse(buf);
      }
      return ready.shift();
    }

    return { next, description: null };  // Annex B → no decoder description
  }

  // ── MP4/MOV access-unit reader (mp4box.js, lazy-loaded) ───

  let mp4boxLoading = null;
  function loadMp4box() {
    if (window.MP4Box) return Promise.resolve();
    if (!mp4boxLoading) {
      mp4boxLoading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'vendor/mp4box/mp4box.all.min.js';
        s.onload = res;
        s.onerror = () => rej(new Unsupported('mp4box.js failed to load'));
        document.head.appendChild(s);
      });
    }
    return mp4boxLoading;
  }

  async function createMp4Reader(file) {
    await loadMp4box();
    const box = MP4Box.createFile();
    const ready = [];
    let track = null, description = null, codec = null;
    let filePos = 0, eofAppended = false, fatal = null;

    box.onError = (e) => { fatal = new Unsupported(`mp4 parse error: ${e}`); };
    box.onReady = (info) => {
      track = (info.videoTracks || [])[0];
      if (!track) { fatal = new Unsupported('no video track'); return; }
      if (!/^avc[13]/.test(track.codec)) {
        fatal = new Unsupported(`codec ${track.codec} — only H.264 handled`);
        return;
      }
      codec = track.codec;
      // avcC box → decoder description (skip the 8-byte box header).
      try {
        const entry = box.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
        const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        entry.avcC.write(ds);
        description = new Uint8Array(ds.buffer, 8);
      } catch (e) {
        fatal = new Unsupported('could not extract avcC');
        return;
      }
      box.setExtractionOptions(track.id, null, { nbSamples: 100 });
      box.start();
    };
    box.onSamples = (id, user, samples) => {
      for (const s of samples) {
        ready.push({
          data: new Uint8Array(s.data),
          ptsSec: s.cts / s.timescale,
          key: !!s.is_sync,
          num: s.number,
        });
      }
      if (samples.length) box.releaseUsedSamples(id, samples[samples.length - 1].number);
    };

    async function next() {
      while (ready.length === 0) {
        if (fatal) throw fatal;
        if (filePos >= file.size) {
          if (!eofAppended) { eofAppended = true; box.flush(); continue; }
          return null;
        }
        const buf = await file.slice(filePos, filePos + SLICE_BYTES).arrayBuffer();
        buf.fileStart = filePos;
        filePos += buf.byteLength;
        box.appendBuffer(buf);
      }
      if (fatal) throw fatal;
      return ready.shift();
    }

    // Parse headers up front so codec/description are known before decoding.
    while (!track && !fatal && filePos < file.size) {
      const buf = await file.slice(filePos, filePos + SLICE_BYTES).arrayBuffer();
      buf.fileStart = filePos;
      filePos += buf.byteLength;
      box.appendBuffer(buf);
    }
    if (fatal) throw fatal;
    if (!track) throw new Unsupported('mp4: no track info found');
    return { next, description, codec };
  }

  // ── Encoder configuration ─────────────────────────────────

  function avcLevelFor(w, h, fps) {
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16) * fps;   // macroblocks/sec
    if (mbs <= 245760) return 'avc1.640028';   // High 4.0  (1080p30)
    if (mbs <= 983040) return 'avc1.640033';   // High 5.1  (4K30)
    return 'avc1.640034';                      // High 5.2  (4K60+)
  }

  async function makeEncoderConfig(w, h, fps) {
    // ~0.42 bits/pixel ≈ the slow path's crf-18 "visually lossless" ballpark
    // (720p30 ≈ 12 Mbps, 1080p30 ≈ 26 Mbps), capped for 4K sanity.
    const bitrate = Math.round(Math.min(60e6, Math.max(8e6, w * h * fps * 0.42 / 30)));
    const base = {
      codec: avcLevelFor(w, h, fps),
      width: w, height: h,
      bitrate, framerate: fps,
      bitrateMode: 'variable',
      latencyMode: 'quality',
      avc: { format: 'annexb' },
    };
    for (const hw of ['prefer-hardware', 'no-preference']) {
      const cfg = { ...base, hardwareAcceleration: hw };
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) return cfg;
      } catch (_) { /* try next */ }
    }
    throw new Unsupported('no supported H.264 encoder config');
  }

  // ── The pipeline ──────────────────────────────────────────
  /**
   * Same contract as ExportFfmpeg.run(): resolves to an MP4 Blob, or null if
   * cancelled. Throws (often Unsupported) when this path can't handle the
   * source — the caller falls back to the ffmpeg-only encoder.
   */
  async function run(opts) {
    if (!supported()) throw new Unsupported('WebCodecs unavailable');
    const { onStatus, onProgress, durationSec, sourceFile } = opts;
    const fps = opts.overlayFps;
    const trimStart = Math.max(0, opts.trimStart || 0);
    const trimEnd = (opts.trimEnd && opts.trimEnd <= durationSec + 0.001) ? opts.trimEnd : durationSec;
    const spanSec = Math.max(0.001, trimEnd - trimStart);
    cancelled = false;

    // Output geometry — identical resolution/geometry scaling to the slow path.
    const { f, outW, outH, geom } = ExportFfmpeg.resolveResolution(opts);

    const name = sourceFile.name || '';
    let reader;
    if (/\.(ts|m2ts|mts)$/i.test(name)) reader = createTsReader(sourceFile);
    else if (/\.(mp4|m4v|mov)$/i.test(name)) reader = await createMp4Reader(sourceFile);
    else throw new Unsupported(`no fast demuxer for "${name}"`);

    onStatus?.('Encoding (hardware)… 0%');

    // Decoder → sorted presentation-order frame queue.
    const frames = [];           // { frame, tSec }
    let pipeError = null;
    const decoder = new VideoDecoder({
      output: (frame) => frames.push({ frame, tSec: frame.timestamp / 1e6 }),
      // prefer-software: matches the app's known-good scrub path — VideoToolbox
      // rejects some HDZero bitstreams that software decodes fine, and software
      // H.264 decode is far faster than the encode it feeds anyway.
      error: (e) => { pipeError = e; },
    });

    // Encoder → Annex B chunks collected for the mux step.
    const encParts = [];
    let encBytes = 0;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        encParts.push(buf);
        encBytes += buf.length;
      },
      error: (e) => { pipeError = e; },
    });

    const totalFrames = Math.max(1, Math.ceil(spanSec * fps));
    let decoderConfigured = false;
    let sourceEof = false, decoderFlushed = false;
    let started = false;         // past the GOP-skip window before trimStart
    let gop = [];                // AUs buffered since the last keyframe (pre-start)

    const tick = () => new Promise(r => setTimeout(r, 1));

    function configureDecoder(firstKeyAU) {
      const codec = reader.codec || codecFromSPS(firstKeyAU.data);
      if (!codec) throw new Unsupported('could not read SPS/codec');
      const cfg = { codec, optimizeForLatency: false, hardwareAcceleration: 'prefer-software' };
      if (reader.description) cfg.description = reader.description;
      decoder.configure(cfg);
      decoderConfigured = true;
    }

    function feedAU(au) {
      decoder.decode(new EncodedVideoChunk({
        type: au.key ? 'key' : 'delta',
        timestamp: Math.round(au.ptsSec * 1e6),
        data: au.data,
      }));
    }

    // Pull AUs; skip whole GOPs that end before the clip window so a trimmed
    // export of a long recording doesn't decode everything before the trim.
    async function feedMore() {
      if (sourceEof) {
        if (!decoderFlushed) {
          decoderFlushed = true;
          if (decoderConfigured) await decoder.flush().catch(e => { if (!pipeError) pipeError = e; });
        }
        return;
      }
      if (decoder.decodeQueueSize > 24) { await tick(); return; }
      const au = await reader.next();
      if (!au) {
        sourceEof = true;
        // Source ended before the window even started (bad trim) — still flush
        // whatever GOP we were holding so at least those frames exist.
        if (!started) { for (const b of gop) { if (!decoderConfigured && b.key) configureDecoder(b); if (decoderConfigured) feedAU(b); } started = true; }
        return;
      }
      if (!started) {
        if (au.key) gop = [au];
        else gop.push(au);
        // First AU past the window start: its GOP (buffered from the previous
        // keyframe) contains the frame shown at trimStart — decode from there.
        if (au.ptsSec >= trimStart) {
          if (!gop.length || !gop[0].key) throw new Unsupported('no keyframe before clip start');
          configureDecoder(gop[0]);
          for (const b of gop) feedAU(b);
          gop = [];
          started = true;
        }
        return;
      }
      if (!decoderConfigured) { if (au.key) configureDecoder(au); else return; }
      feedAU(au);
    }

    // Latest decoded frame at or before t (presentation order).
    async function frameAt(t) {
      for (;;) {
        if (pipeError) throw pipeError;
        if (cancelled) return null;
        // Drop frames that can no longer be the answer for t (or any later t).
        while (frames.length >= 2 && frames[1].tSec <= t + 1e-6) frames.shift().frame.close();
        const haveNext = frames.length >= 2 && frames[1].tSec > t + 1e-6;
        if (frames.length && (haveNext || decoderFlushed)) return frames[0];
        if (decoderFlushed && !frames.length) return null;   // stream exhausted
        await feedMore();
      }
    }

    const encoderConfig = await makeEncoderConfig(outW, outH, fps);
    encoder.configure(encoderConfig);

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (f !== 1) ctx.imageSmoothingQuality = 'high';

    const encodeDrained = () => new Promise(r => {
      encoder.addEventListener('dequeue', function fn() {
        if (encoder.encodeQueueSize <= 4) { encoder.removeEventListener('dequeue', fn); r(); }
      });
      setTimeout(r, 250);   // belt & braces — never stall on a missed event
    });

    try {
      for (let k = 0; k < totalFrames; k++) {
        if (cancelled) return null;
        // Output frame k shows file time t — identical mapping to the slow
        // path's overlay sequence, so burned-in times are ms-exact.
        const t = trimStart + k / fps;
        const src = await frameAt(t);
        if (cancelled) return null;
        if (src) ctx.drawImage(src.frame, 0, 0, outW, outH);
        else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, outW, outH); }
        OverlayRender.drawOverlay(ctx, geom, t, opts.laps, opts.fastestIds,
                                  opts.groupSize, opts.fastTotal, opts.colors);
        const vf = new VideoFrame(canvas, {
          timestamp: Math.round(k * 1e6 / fps),
          duration: Math.round(1e6 / fps),
        });
        encoder.encode(vf, { keyFrame: k % (fps * 2) === 0 });
        vf.close();
        if (encoder.encodeQueueSize > 8) await encodeDrained();
        if (pipeError) throw pipeError;
        if (k % 15 === 0) {
          onStatus?.(`Encoding (hardware)… ${Math.round((k / totalFrames) * 100)}%`);
          onProgress?.((k / totalFrames) * 0.93);
        }
      }
      await encoder.flush();
      if (pipeError) throw pipeError;
      if (cancelled) return null;

      onStatus?.('Muxing audio…');
      onProgress?.(0.94);
      return await muxWithAudio(concatParts(encParts, encBytes), opts, { fps, trimStart, spanSec });
    } finally {
      for (const f2 of frames) { try { f2.frame.close(); } catch (_) {} }
      try { decoder.close(); } catch (_) {}
      try { encoder.close(); } catch (_) {}
    }
  }

  // Mux the encoded H.264 with the source's audio via ffmpeg.wasm — container
  // work only (video stream-copied, audio → AAC), so it runs in seconds.
  async function muxWithAudio(h264, opts, { fps, trimStart, spanSec }) {
    const ff = await ExportFfmpeg.load(opts.onStatus);
    const srcName = (opts.sourceFile.name && /\.[a-z0-9]+$/i.test(opts.sourceFile.name))
      ? opts.sourceFile.name : 'source.ts';
    const onLogProgress = ({ time }) => {
      if (time && spanSec) opts.onProgress?.(0.94 + 0.06 * Math.min(1, (time / 1e6) / spanSec));
    };
    ff.on('progress', onLogProgress);
    try {
      await ff.writeFile('fast.h264', h264);
      await ff.createDir('/fastin');
      await ff.mount('WORKERFS', { files: [opts.sourceFile] }, '/fastin');

      const args = ['-framerate', String(fps), '-i', 'fast.h264'];
      if (trimStart > 0.001) args.push('-ss', trimStart.toFixed(3));
      args.push('-t', spanSec.toFixed(3), '-i', `/fastin/${srcName}`,
        '-map', '0:v', '-map', '1:a?',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        // The raw-H.264 demuxer quantizes frame times to whole microseconds,
        // which drifts ~10 µs/s (≈6 ms over a 10-minute race) — enough to
        // matter here. Re-stamp every packet onto the exact k/fps grid.
        '-bsf:v', `setts=ts=round(N/${fps}/TB):duration=round(1/${fps}/TB)`,
        '-movflags', '+faststart',
        'fast.mp4');
      await ff.exec(args);
      if (cancelled) return null;
      const data = await ff.readFile('fast.mp4');
      return new Blob([data.buffer], { type: 'video/mp4' });
    } finally {
      ff.off('progress', onLogProgress);
      try { await ff.unmount('/fastin'); } catch (_) {}
      try { await ff.deleteDir('/fastin'); } catch (_) {}
      try { await ff.deleteFile('fast.h264'); } catch (_) {}
      try { await ff.deleteFile('fast.mp4'); } catch (_) {}
    }
  }

  return { run, cancel, supported, Unsupported };
})();
