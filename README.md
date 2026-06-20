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
- **Export w/ Overlay** — renders the video with the LiveSplit-style race timer overlay burned in and downloads it as a WebM (VP9). When the browser supports WebCodecs it encodes hardware-accelerated at ~4× speed; otherwise it falls back to a 1×-speed `MediaRecorder` capture. This path drives the on-screen player to capture frames, so the player is busy while it runs.
- **Export MP4 (background)** — encodes an H.264 **MP4** entirely off the player using a self-hosted [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (in `vendor/`). The source file is mounted lazily (WORKERFS) so even multi-GB `.ts` files are read in slices rather than copied into memory, ffmpeg decodes/composites/encodes, and a real progress bar tracks it — leaving the player free to keep scrubbing and marking laps. Encoded at **CRF 18 (visually lossless)** so the footage isn't re-crushed, 30 fps (HDZero records 90 fps; the burned-in timer stays millisecond-exact at every frame). The **resolution** dropdown next to the button keeps source resolution or upscales to **1080p / 4K**, re-rendering the overlay crisply at that resolution (not stretching the composited frame). It is slower than the WebCodecs path (single-threaded wasm, ~0.5–0.6× realtime at source res; 1080p/4K are considerably slower) but produces a widely-compatible MP4 and decodes the TS correctly in every browser. The overlay itself is drawn by the same renderer (`js/overlay-render.js`) both paths share, so the burned-in times are identical.

---

## Session persistence

Lap data is automatically saved to `localStorage` after every change. If you close or refresh the page, your laps are restored. Click **Clear Session** to wipe them.

---

## Known limitations

1. **Frame stepping accuracy** — Browsers do not expose a frame-accurate seek API. The app steps by `1/30` second. On video with large keyframe intervals (GOP), the browser may snap to the nearest decoded frame, causing apparent jumps of several frames. Use slow playback speed + scrubbing for sub-frame precision.

2. **Large files** — Very large video files (several GB) are loaded into a blob URL in the browser's memory. Performance depends on available RAM and the browser's media pipeline.

3. **Overlay export** — Two options, both burning in the same overlay: "Export w/ Overlay" re-encodes to VP9 WebM (fast WebCodecs path needs a Chromium-based browser; otherwise a slower 1× capture) and uses the player; "Export MP4 (background)" re-encodes to H.264 MP4 with ffmpeg.wasm off the player but is slower (single-threaded wasm). The source video is never modified.

4. **Bundled ffmpeg.wasm** — the background MP4 export needs the files under `vendor/` (a ~32 MB wasm core). They are committed so the app stays self-contained and offline-capable; the core is fetched lazily only on the first MP4 export.
