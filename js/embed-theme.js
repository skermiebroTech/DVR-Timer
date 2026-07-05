/* ============================================================
   embed-theme.js — Match the host site's UI theme when embedded
   ============================================================

   When this app is embedded in an <iframe> on another site, the host's CSS
   can't reach across the (cross-origin) frame boundary, so the app can't just
   inherit the host's colours. Instead the host tells the app which palette and
   light/dark mode to use, and this module maps that onto the app's own
   :root CSS variables — so only the values change, every component restyles
   for free.

   How the mode is chosen (first match wins):
     1. postMessage from the host: { type: 'dvr-theme', mode: 'light'|'dark' }
        — this is what makes the embed follow the host's dark/light toggle live.
     2. ?embed=<palette>&mode=<mode> in the URL (or the same keys in the #hash),
        for the initial paint before the first message arrives.
     3. The user's OS prefers-color-scheme, if no explicit mode is given.

   Only the app-chrome variables are touched. The race-timer overlay keeps its
   own independent, user-customisable colours (--timer-accent / --timer-text /
   --timer-font, set on the overlay element by app.js) — the burned-in lap
   timer never changes with the site theme, by design.

   Adding another host site = add another entry to PALETTES. Values are the
   host's real tokens (see fpvrebels: scraped from its stylesheet + inline club
   palette) mapped to this app's semantic roles.
   ============================================================ */

const EmbedTheme = (() => {
  // Map a host palette → this app's :root variables, per mode. Keys are the
  // app's variable names (without the leading --).
  const PALETTES = {
    // FPV Rebels (fpvrebels.com / AUFPV platform). data-theme="light|dark".
    fpvrebels: {
      light: {
        'bg':             '#f8f8fa',   // neutral-50 page
        'bg-card':        '#ffffff',   // white cards
        'bg-input':       '#f0f0f3',   // neutral-100 fills
        'border':         '#dfdfe5',   // neutral-200
        'accent':         '#c33739',   // Rebels red (primary)
        'accent-dark':    '#a82d2f',   // primary hover
        'green':          '#0d9f2f',   // success
        'red':            '#dc2626',   // danger
        'yellow':         '#d97706',   // warning
        'text':           '#111113',   // neutral-900
        'text-dim':       '#6b6b76',   // neutral-500
        'fastest-bg':     'rgba(13,159,47,.12)',
        'fastest-border': '#0d9f2f',
        'selected-bg':    'rgba(195,55,57,.12)',
        'shadow':         '0 4px 6px -1px rgba(0,0,0,.06), 0 2px 4px -2px rgba(0,0,0,.04)',
      },
      dark: {
        'bg':             '#0f1115',   // club dark bg
        'bg-card':        '#1f1f23',   // surface
        'bg-input':       '#161922',   // bg-subtle (darker than card)
        'border':         '#3a3a42',   // dark border
        'accent':         '#c33739',   // Rebels red (primary)
        'accent-dark':    '#a82d2f',
        'green':          '#34d399',   // dark success
        'red':            '#f0625d',   // danger, lifted for dark contrast
        'yellow':         '#f59e0b',   // warning, lifted for dark contrast
        'text':           '#e6e6e6',
        'text-dim':       '#8a8d99',   // text-muted
        'fastest-bg':     'rgba(52,211,153,.15)',
        'fastest-border': '#34d399',
        'selected-bg':    'rgba(195,55,57,.18)',
        'shadow':         '0 2px 12px rgba(0,0,0,.5)',
      },
    },
  };

  let palette = null;   // active palette name, once embed theming is enabled
  let mql = null;       // prefers-color-scheme listener (only while mode unforced)

  function normMode(m) {
    m = String(m || '').toLowerCase();
    return (m === 'dark' || m === 'light') ? m : null;
  }

  function apply(mode) {
    if (!palette || !PALETTES[palette]) return;
    const vars = PALETTES[palette][mode] || PALETTES[palette].light;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--${k}`, v);
    // Tell the browser which scheme is active so native widgets (scrollbars,
    // form controls, the colour pickers) render for the right mode.
    root.style.colorScheme = mode;
    root.setAttribute('data-embed-mode', mode);
  }

  // Read initial palette + mode from ?query or #hash.
  function readParams() {
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const get = (k) => h.get(k) || q.get(k);
    return { embed: get('embed'), mode: normMode(get('mode')) };
  }

  function init() {
    const { embed, mode } = readParams();
    if (!embed || !PALETTES[embed]) return;   // not an embed we theme → app's default palette stands
    palette = embed;

    // Follow the host's live light/dark toggle. The host posts on load and on
    // every toggle (see README embed snippet). We only read a validated mode
    // string — never anything executable — so no origin allowlist is required
    // for safety; a host may still pass ?embedOrigin= to restrict senders.
    const allowOrigin = new URLSearchParams(location.search).get('embedOrigin');
    window.addEventListener('message', (e) => {
      if (allowOrigin && e.origin !== allowOrigin) return;
      const d = e.data;
      if (!d || d.type !== 'dvr-theme') return;
      const m = normMode(d.mode);
      if (m) { stopSystemFollow(); apply(m); }
    });

    if (mode) {
      apply(mode);                 // explicit initial mode from the URL
    } else {
      startSystemFollow();         // no explicit mode → track the OS until told otherwise
    }
  }

  function startSystemFollow() {
    if (!window.matchMedia) { apply('light'); return; }
    mql = window.matchMedia('(prefers-color-scheme: dark)');
    apply(mql.matches ? 'dark' : 'light');
    mql.addEventListener('change', onSystemChange);
  }
  function onSystemChange(e) { apply(e.matches ? 'dark' : 'light'); }
  function stopSystemFollow() {
    if (mql) { mql.removeEventListener('change', onSystemChange); mql = null; }
  }

  return { init };
})();

// Run immediately (script is loaded before app.js) so the first paint is themed.
EmbedTheme.init();
