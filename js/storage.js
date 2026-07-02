/* ============================================================
   storage.js — localStorage persistence
   ============================================================

   Lap sessions are stored *per video*: the key is derived from the uploaded
   file's name + duration, so each clip keeps its own set of race times. Reload
   the page and re-open the same file and its laps come back; open a different
   clip and you get that clip's laps (or a clean slate).

   The active key is set by app.js (Storage.setSessionKey) once the duration is
   known — native files on loadedmetadata, .ts files after the PTS duration parse.
   Until then no key is active and save()/load() are no-ops / empty.

   Overlay colours are a single global preference (not per video).
   ============================================================ */

const SESSION_PREFIX = 'dvr-race-timer-laps::';
const COLORS_KEY     = 'dvr-race-timer-overlay-colors';
const DD_CLUB_KEY    = 'dvr-race-timer-dronedash-club';

const Storage = (() => {
  let currentKey = null;   // active per-video session key; null until a video loads

  // Build a stable key from the file name + duration. Duration is rounded to
  // 0.1 s so trivial jitter can't fork the key — the same clip always resolves
  // to the same key, restoring its laps.
  function sessionKey(name, durationSec) {
    const safeName = String(name || 'video').trim();
    const d = Math.round((Number(durationSec) || 0) * 10) / 10;
    return `${SESSION_PREFIX}${safeName}::${d}`;
  }

  function setSessionKey(key) { currentKey = key || null; }
  function getSessionKey() { return currentKey; }

  function save(laps) {
    if (!currentKey) return;   // no active video session → nothing to key it under
    try {
      localStorage.setItem(currentKey, JSON.stringify(laps));
    } catch (e) {
      console.warn('Failed to save session to localStorage:', e);
    }
  }

  function load() {
    if (!currentKey) return [];
    try {
      const raw = localStorage.getItem(currentKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('Failed to load session from localStorage:', e);
      return [];
    }
  }

  // Clear the laps for the currently-loaded video only.
  function clear() {
    if (currentKey) localStorage.removeItem(currentKey);
  }

  // Persist the timer overlay colour choices so they survive a reload (global).
  function saveOverlayColors(colors) {
    try {
      localStorage.setItem(COLORS_KEY, JSON.stringify(colors));
    } catch (e) {
      console.warn('Failed to save overlay colours to localStorage:', e);
    }
  }

  function loadOverlayColors() {
    try {
      const raw = localStorage.getItem(COLORS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Remember which club's DroneDash server was last used (global, like colours).
  function saveDroneDashClub(base) {
    try { localStorage.setItem(DD_CLUB_KEY, base); } catch (e) {}
  }

  function loadDroneDashClub() {
    try { return localStorage.getItem(DD_CLUB_KEY); } catch (e) { return null; }
  }

  return { sessionKey, setSessionKey, getSessionKey, save, load, clear,
           saveOverlayColors, loadOverlayColors,
           saveDroneDashClub, loadDroneDashClub };
})();
