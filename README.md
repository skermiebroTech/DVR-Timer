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
| `[` | Set clip in-point (trim start) at current time |
| `]` | Set clip out-point (trim end) at current time |
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

## Race timer overlay

A LiveSplit-style race timer is shown over the video **by default** (toggle it with the **Race Timer Overlay** checkbox). It counts up from the first lap, lists recent splits, and highlights the fastest consecutive group. Drag it anywhere on the frame to reposition, and drag the bottom-right grip to resize.

The video frame is locked to the uploaded clip's exact aspect ratio (no letterbox bars), so wherever you park the overlay on screen is exactly where it lands in an export — it can't drift off-frame.

**Colours** — the two pickers next to the toggle set the timer's **Accent** (left bar, glow, and best-lap highlights) and **Text** (the main digits) colours. Your choices persist across reloads and are applied identically to the burned-in overlay in both exports below.

---

## Export / Import

- **Export JSON** — saves all laps with raw timestamps (seconds). Use this to resume a session.
- **Export CSV** — saves laps in a spreadsheet-friendly format with both raw seconds and formatted times.
- **Import JSON** — loads a previously exported JSON file, replacing the current session.
- **Export MP4 (background)** — encodes an H.264 **MP4** with the timer overlay burned in, entirely off the player using a self-hosted [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (in `vendor/`). The source file is mounted lazily (WORKERFS) so even multi-GB `.ts` files are read in slices rather than copied into memory; ffmpeg decodes/composites/encodes while a real progress bar tracks it — leaving the player free to keep scrubbing and marking laps. Encoded at **CRF 18 (visually lossless)** so the footage isn't re-crushed. The **resolution** dropdown keeps source resolution or upscales to **1080p / 4K** (re-rendering the overlay crisply at that resolution, not stretching the composited frame), and the **fps** dropdown picks 30 / 60 / 90 fps. The burned-in timer stays millisecond-exact at every frame. It's single-threaded wasm (~0.5–0.6× realtime at source res; 1080p/4K are slower) but produces a widely-compatible MP4 and decodes the TS correctly in every browser.
- **Export Timer Only** — renders just the timer overlay (no footage) to a transparent QuickTime `.mov` (qtrle/argb) sized to the full source frame, so you can drop it straight over your clip at 0,0 in an editor. No source decode or H.264 re-encode, so it's far faster than the full MP4.

Both burn-in paths share the same renderer (`js/overlay-render.js`) as the on-screen overlay, so the times — and your chosen colours — are identical on screen and in the export.

---

## Session persistence

Lap data is automatically saved to `localStorage` after every change. If you close or refresh the page, your laps are restored. Click **Clear Session** to wipe them.

---

## Known limitations

1. **Frame stepping accuracy** — Browsers do not expose a frame-accurate seek API. The app steps by `1/30` second. On video with large keyframe intervals (GOP), the browser may snap to the nearest decoded frame, causing apparent jumps of several frames. Use slow playback speed + scrubbing for sub-frame precision.

2. **Large files** — Very large video files (several GB) are loaded into a blob URL in the browser's memory. Performance depends on available RAM and the browser's media pipeline.

3. **Overlay export speed** — Burning the overlay into an MP4 re-encodes the footage with ffmpeg.wasm (single-threaded), so it runs slower than realtime. "Export Timer Only" is much faster since it skips the footage entirely and just renders the transparent overlay. The source video is never modified by either path.

4. **Bundled ffmpeg.wasm** — the background MP4 export needs the files under `vendor/` (a ~32 MB wasm core). They are committed so the app stays self-contained and offline-capable; the core is fetched lazily only on the first MP4 export.
