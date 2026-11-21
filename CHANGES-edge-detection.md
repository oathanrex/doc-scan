# Edge detection rewrite (v1.3.0)

## Problem
`findQuad` summed edge strength per row/column. On a patterned surface (floral
bedsheet) *every* row/column has edges, so the document was never isolated: it
returned nothing (card front) or snapped to a white leaf (card back).
Only Texloom's last stage (PCA line refinement) had been ported; its
segmentation stage, which is what makes it work, was missing.

## What changed
| File | Change |
|---|---|
| `js/edge-detect.js` (+ root copy) | New pipeline: background model (Lab colour + texture from border frame) -> segmentation -> seed quad (extremes or min-area rotated rectangle) -> boundary-contrast line search (outermost, sharp edge) -> Texloom PCA sub-pixel polish -> validation. Threshold ladder for pale-on-pale documents. `detect(src, {live:true})` for the camera loop. |
| `js/app.js` (+ root copy) | Camera loop uses `{live:true}`, runs ~9x/s (was every frame) with corner smoothing. Shutter re-runs full-accuracy detection on the captured frame unless corners were set by hand. |
| `sw.js` | Cache name bumped to `docscan-v2.4.0` so installed PWAs pick up the new JS. |
| `tests/scanner.test.js` | Replaced the two tests of removed helpers (`findQuad`, `fitLine`/`lineIntersect`); added 11 edge-detection tests on synthetic scenes. |
| `README.md`, `package.json` | Pipeline description, version 1.3.0. |

`EdgeDetect.detect(source)` keeps its contract: `{ quad:[{x,y}] TL,TR,BR,BL, confidence, w, h }`.
`quad` is now in the source's own pixel space (float, not rounded).

## Not updated
`GUIDE.md` and `guide.html` still describe the old Canny/Sobel pipeline.
