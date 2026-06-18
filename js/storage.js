/* ============================================================
   storage.js — localStorage persistence for lap session data
   ============================================================ */

const STORAGE_KEY = 'dvr-race-timer-session';

const Storage = {
  save(laps) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(laps));
    } catch (e) {
      console.warn('Failed to save session to localStorage:', e);
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
