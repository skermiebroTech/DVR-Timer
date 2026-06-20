/* ============================================================
   storage.js — localStorage persistence for lap session data
   ============================================================ */

const STORAGE_KEY = 'dvr-race-timer-session';
const COLORS_KEY  = 'dvr-race-timer-overlay-colors';

const Storage = {
  save(laps) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(laps));
    } catch (e) {
      console.warn('Failed to save session to localStorage:', e);
    }
  },

  // Persist the timer overlay colour choices so they survive a reload.
  saveOverlayColors(colors) {
    try {
      localStorage.setItem(COLORS_KEY, JSON.stringify(colors));
    } catch (e) {
      console.warn('Failed to save overlay colours to localStorage:', e);
    }
  },

  loadOverlayColors() {
    try {
      const raw = localStorage.getItem(COLORS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('Failed to load session from localStorage:', e);
      return [];
    }
  },

  clear() {
    localStorage.removeItem(STORAGE_KEY);
  }
};
