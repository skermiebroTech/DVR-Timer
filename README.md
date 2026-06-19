# DVR Race Timer

A browser-based race timing tool for reviewing race footage and logging lap times. Runs fully static — no server, backend, or login required. Deploy to GitHub Pages and use it anywhere.

---

## Running locally

Open `index.html` directly in your browser, **or** serve it with any static server to avoid file-permission quirks with some browsers:

```bash
# Python (built-in)
python3 -m http.server 8080
# then open http://localhost:8080

# Node (npx)
npx serve .
```

No build step or dependencies needed.

---

## Deploying to GitHub Pages

1. Push this folder (all files) to a GitHub repository.
2. Go to **Settings → Pages**.
3. Under **Source**, choose `Deploy from a branch` → `main` → `/ (root)`.
4. GitHub will give you a URL like `https://<user>.github.io/<repo>/`.

That's it — the app is entirely static.

---

## Supported video formats

Playback depends on your browser's built-in codec support:

| Format | Chrome | Firefox | Safari | Edge |
|--------|--------|---------|--------|------|
| MP4 (H.264) | ✅ | ✅ | ✅ | ✅ |
| WebM (VP8/VP9) | ✅ | ✅ | ✅ | ✅ |
| MOV (H.264) | ✅ | ⚠️ | ✅ | ✅ |
| MKV | ✅ | ✅ | ❌ | ✅ |
| TS / M2TS / MTS | ✅ | ✅ | ✅ | ✅ |
| AVI | ⚠️ | ⚠️ | ❌ | ⚠️ |

**TS files**: MPEG-2 Transport Stream is demuxed in the browser with [mpegts.js](https://github.com/xqq/mpegts.js) (MSE-based, no re-encode and no WASM download), so HDZero and most DVR `.ts` recordings play directly. Duration is parsed from the stream's PTS timestamps since TS containers carry no duration header.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` | Seek back 5 seconds |
| `→` | Seek forward 5 seconds |
| `,` | Step one frame backward |
| `.` | Step one frame forward |
| `L` | Add lap marker at current time |
| `Delete` / `Backspace` | Delete selected lap |

Shortcuts are disabled when an input field is focused.

---

## How lap marking works

- Press **L** (or **+ Add Lap**) to mark the start of the first lap.
- Press **L** again at the finish line — this closes the previous lap's end time and simultaneously starts the next lap.
- The last lap stays "in progress" (no end time) until you press **L** once more or manually edit it.
- You can edit or delete any lap via the table buttons.

---

## Fastest consecutive laps

- Set the **Group size** field to any number (default: 3).
- The app finds the consecutive group of that many laps with the lowest combined duration.
- Those rows are highlighted in green in the lap table, and the combined time is shown above the table.

---

## Export / Import

- **Export JSON** — saves all laps with raw timestamps (seconds). Use this to resume a session.
- **Export CSV** — saves laps in a spreadsheet-friendly format with both raw seconds and formatted times.
- **Import JSON** — loads a previously exported JSON file, replacing the current session.
- **Export w/ Overlay** — renders the video with the LiveSplit-style race timer overlay burned in and downloads it as a WebM (VP9). When the browser supports WebCodecs it encodes hardware-accelerated at ~4× speed; otherwise it falls back to a 1×-speed `MediaRecorder` capture.

---

## Session persistence

Lap data is automatically saved to `localStorage` after every change. If you close or refresh the page, your laps are restored. Click **Clear Session** to wipe them.

---

## Known limitations

1. **Frame stepping accuracy** — Browsers do not expose a frame-accurate seek API. The app steps by `1/30` second. On video with large keyframe intervals (GOP), the browser may snap to the nearest decoded frame, causing apparent jumps of several frames. Use slow playback speed + scrubbing for sub-frame precision.

2. **Large files** — Very large video files (several GB) are loaded into a blob URL in the browser's memory. Performance depends on available RAM and the browser's media pipeline.

3. **Overlay export** — "Export w/ Overlay" re-encodes to VP9 WebM. The fast (WebCodecs) path requires a Chromium-based browser; other browsers fall back to a slower 1×-speed capture. The source video is otherwise never modified.
