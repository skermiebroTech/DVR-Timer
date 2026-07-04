/* ============================================================
   audio-denoise.js — optional playback noise reduction
   ============================================================

   HDZero goggle/VRX recordings carry a constant audio noise floor: low
   rumble/hum at the bottom and a broadband high-frequency hiss on top. This
   routes the player's audio through a Web Audio filter chain that trims both
   bands, leaving the mid-range (props, callouts, crash thuds) largely intact.

   Chain:  source → highpass(120 Hz) → lowpass(6 kHz) → destination
     • highpass removes sub-bass rumble and mains hum
     • lowpass rolls off the hiss above the useful audio band

   createMediaElementSource() can be called only once per element and, once
   called, *all* the element's audio flows through the graph — so we build it
   lazily on first enable and, when bypassed, still connect source→destination
   so audio never drops. Playback only; exports are a separate pipeline.
   ============================================================ */

const AudioDenoise = (() => {
  const HIGHPASS_HZ = 120;    // cut rumble / mains hum below this
  const LOWPASS_HZ  = 6000;   // roll off hiss above this

  let ctx = null, source = null, highpass = null, lowpass = null;
  let built = false;          // graph constructed (source captured)
  let failed = false;         // construction failed — leave native audio alone
  let enabled = false;

  function build() {
    if (built || failed) return;
    const video = document.getElementById('main-video');
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!video || !AC) { failed = true; return; }
    try {
      ctx = new AC();
      source = ctx.createMediaElementSource(video);
      highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = HIGHPASS_HZ;
      highpass.Q.value = 0.7;
      lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = LOWPASS_HZ;
      lowpass.Q.value = 0.7;
      highpass.connect(lowpass);
      built = true;
      route();
    } catch (_) {
      failed = true;   // e.g. source already created, or audio unavailable
    }
  }

  // Wire source either through the filters (enabled) or straight to the
  // speakers (bypass). Either way audio reaches the destination.
  function route() {
    if (!built) return;
    try { source.disconnect(); } catch (_) {}
    try { lowpass.disconnect(); } catch (_) {}
    if (enabled) {
      source.connect(highpass);
      lowpass.connect(ctx.destination);
    } else {
      source.connect(ctx.destination);
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    // Build on first use so users who never touch it keep untouched native audio.
    if (enabled && !built) build();
    if (failed) return;
    // A context created before any user gesture starts suspended; the toggle
    // click is a gesture, so resume here.
    if (ctx && ctx.state === 'suspended') ctx.resume();
    route();
  }

  function isEnabled() { return enabled; }

  return { setEnabled, isEnabled };
})();
