# DocScan

A working build of the **Mobile Document Scanner** MVP from the PRD. Capture pages with the device camera, auto-detect document borders, correct perspective, then export a clean PDF — fully on-device, works offline.

## What's implemented (PRD → Build)

| PRD section | What ships |
| --- | --- |
| §5 Automatic border detection | Real-time Canny-style edge detector runs on every video frame at ~30 fps; locks on the four corners and overlays a live outline you can drag to adjust. |
| §5 Perspective correction | Full homography transform that warps the detected quad into a flat rectangle at the document's natural aspect. |
| §5 Multi-page capture | Capture → review → capture again. Page counter and thumbnail strip update live. |
| §5 Review, reorder & retake | Drag-and-drop thumbnail grid, per-page edit / retake / delete, with confirmation. |
| §5 Export to PDF | Multi-page PDF built in pure JS, zero dependencies. Output verified as valid PDF 1.4. |
| §5 V1.1 image filters | B&W, Grayscale, Boost, Magic — applied per page via canvas filter, baked in on confirm. |
| §6 Performance | Detection runs on a 240px downscale; well under one frame's budget on a mid-range device. |
| §6 Offline support | Service worker caches the app shell, all processing is on-device, no network calls. |
| §6 Privacy | Camera frames are processed locally; no upload path. |
| §6 Accessibility | Controls labeled, drag handles have ARIA labels, status updates announced to screen readers. |
| §7 User flow | Linear: Open camera → Auto-detect → Capture → Add another? → Review → Export PDF. |
| §8 Low-light fallback | Manual corner-adjustment mode is always one tap away from the camera screen. |

Out of scope for this build (called out in PRD as V1.1 / V2):
- OCR / full-text search across scans
- Cloud backup / cross-device sync
- Custom page sizes (Letter is wired but the UI exposes A4)

## Run it

The app is a static site. Two options:

**1. Open it directly**

Open `index.html` in a modern browser. Some browsers block `getUserMedia` on `file://` URLs, so if the camera doesn't start, use option 2.

**2. Serve it locally**

```bash
cd doc-scanner
python3 -m http.server 8765
# then open http://localhost:8765
```

For the full PWA experience (installable, offline, camera on iOS) use HTTPS or `http://localhost` on a phone connected to the same network.

## File map

```
doc-scanner/
├── index.html          # App shell, all four screens, styles
├── manifest.json       # PWA manifest
├── sw.js               # Service worker (offline cache)
├── icons/
│   └── icon.svg        # App icon
└── js/
    ├── edge-detect.js  # Real-time Canny + projection-based quad search
    ├── perspective.js  # 8x8 homography solver + inverse-mapped renderer
    ├── pdf-export.js   # Zero-dependency PDF 1.4 writer (JPEG / DCTDecode)
    └── app.js          # UI controller, camera lifecycle, capture flow
```

## How the core algorithms work

**Edge detection.** Downscale the video frame to 240px wide, convert to luma, 3×3 box-blur, Sobel gradients, non-maximum suppression, dual-threshold. Then project the strong-edge map onto the x and y axes to find the document's bounding rows/columns, and search a small window around each corner for the strongest edge pixel. This is much cheaper than a full Hough transform and is stable on the live preview.

**Perspective correction.** Solve the 8×8 linear system for the 3×3 homography that maps the four destination corners (the flat rectangle) back to the four source corners (the detected quad in the photo). Render the output by inverse-mapping: for every pixel in the output, find which source pixel it comes from. This is what makes a page photographed at an angle look like it was scanned flat.

**PDF export.** A from-scratch PDF 1.4 writer. One Catalog, one Pages tree, one Page per image, each with a content stream that draws `/Im0` (the JPEG XObject, `/DCTDecode` so we don't have to re-encode). xref table + trailer. No external libraries, runs in any modern browser.
