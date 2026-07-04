/* ============================================================
   scrub-preview.js — realtime video preview while scrubbing .ts
   ============================================================

   Seeking a .ts means rebuilding the mpegts.js player (~250 ms per position) —
   hopeless for live dragging. Instead, while the user drags we pull the
   nearest H.264 keyframe straight out of the file bytes
   (Transcoder.extractKeyframeAt) and decode it with WebCodecs onto a canvas
   overlaid on the video. Each update is one bounded file read + one keyframe
   decode: tens of milliseconds, so the picture chases the pointer.

   Latest-wins: while one extract+decode is in flight, newer positions simply
   replace the pending one, so a fast drag never queues up stale work.

   On release the normal precise seek path takes over; the canvas stays up
   (showing roughly the right frame) until the real seek lands, then
   VideoPlayer removes it via hide().

   Falls back silently (drag = time preview only, seek on release, exactly the
   old behaviour) when WebCodecs is unavailable or the stream won't decode.
   ============================================================ */

const ScrubPreview = (() => {
  let canvas = null, ctx = null;
  let decoder = null;
  let codec = null;       // codec string the decoder is configured for
  let active = false;     // a scrub drag is in progress
  let busy = false;       // an extract+decode is in flight
  let pending = null;     // latest requested fraction (latest-wins)
  let failures = 0;       // consecutive failures → disable quietly
  let disabled = false;

  function supported() {
    return typeof VideoDecoder !== 'undefined' && !disabled;
  }

  function ensureCanvas(w, h) {
    const video = document.getElementById('main-video');
    const wrapper = video && video.parentElement;
    if (!wrapper) return null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d');
      // Same placement as the seek hold-over canvas in video.js.
      Object.assign(canvas.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%',
        zIndex: '2', objectFit: 'contain', background: '#000',
      });
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (!canvas.parentElement) wrapper.appendChild(canvas);
    return ctx;
  }

  function paint(frame) {
    // Only show frames while (or just after) a drag — a slow decode must not
    // pop a canvas over normal playback.
    if (active || isVisible()) {
      const c = ensureCanvas(frame.displayWidth, frame.displayHeight);
      if (c) c.drawImage(frame, 0, 0);
    }
    frame.close();
  }

  // prefer-software matters: hardware decoders (Apple VideoToolbox especially)
  // reject some HDZero H.264 bitstreams that the software decoder — the same
  // one MSE playback uses — handles fine. A single 720p keyframe decodes in a
  // few ms in software anyway.
  function configureSoftware(dec, codecString) {
    try {
      dec.configure({ codec: codecString, optimizeForLatency: true,
                      hardwareAcceleration: 'prefer-software' });
    } catch (_) {
      dec.configure({ codec: codecString, optimizeForLatency: true });
    }
  }

  function getDecoder(codecString) {
    if (decoder && codec === codecString && decoder.state === 'configured') return decoder;
    if (decoder) { try { decoder.close(); } catch (_) {} }
    decoder = new VideoDecoder({
      output: paint,
      error: () => { decoder = null; },   // next pump() reconfigures
    });
    configureSoftware(decoder, codecString);
    codec = codecString;
    return decoder;
  }

  // Decode the keyframe nearest `fraction` of the file to an ImageBitmap (or
  // null). Stateless: its own short-lived decoder, so a batch of these (the
  // timeline filmstrip) never disturbs an in-progress live scrub. Same
  // WebCodecs path as the live preview, so .ts thumbnails render identically.
  async function decodeKeyframeBitmap(fraction) {
    if (!supported()) return null;
    let kf;
    try { kf = await Transcoder.extractKeyframeAt(fraction); }
    catch (_) { return null; }
    if (!kf || !kf.codec) return null;

    return new Promise((resolve) => {
      let settled = false;
      let dec = null;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        if (dec) { try { dec.close(); } catch (_) {} }
        resolve(val);
      };
      try {
        dec = new VideoDecoder({
          output: (frame) => {
            createImageBitmap(frame).then(finish, () => finish(null))
              .finally(() => frame.close());
          },
          error: () => finish(null),
        });
        configureSoftware(dec, kf.codec);
        dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: kf.data }));
        dec.flush().catch(() => finish(null));
      } catch (_) { finish(null); }
      setTimeout(() => finish(null), 4000);   // never hang the strip on one cell
    });
  }

  async function pump() {
    if (busy || pending == null || !active) return;
    busy = true;
    const frac = pending;
    pending = null;
    try {
      const kf = await Transcoder.extractKeyframeAt(frac);
      if (kf && kf.codec && active) {
        const dec = getDecoder(kf.codec);
        dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: kf.data }));
        await dec.flush();   // forces the frame out through paint()
        failures = 0;
      }
    } catch (_) {
      if (decoder) { try { decoder.close(); } catch (_) {} decoder = null; }
      codec = null;
      if (++failures >= 3) disabled = true;   // undecodable stream — stop trying
    }
    busy = false;
    if (pending != null) pump();
  }

  // ── Public API ────────────────────────────────────────────

  function begin() {
    if (supported()) active = true;
  }

  function preview(frac) {
    if (!active) return;
    pending = frac;
    pump();
  }

  // Drag released: stop decoding but keep the last frame up — the precise
  // seek that follows removes it (VideoPlayer.hideSeekCanvas → hide()).
  function end() {
    active = false;
    pending = null;
  }

  function hide() {
    if (canvas && canvas.parentElement) canvas.remove();
  }

  function isVisible() {
    return !!(canvas && canvas.parentElement);
  }

  // New file loaded: previews/codec from the old one are invalid.
  function reset() {
    end();
    hide();
    if (decoder) { try { decoder.close(); } catch (_) {} }
    decoder = null;
    codec = null;
    failures = 0;
    disabled = false;
  }

  return { begin, preview, end, hide, isVisible, reset, supported, decodeKeyframeBitmap };
})();
