# edge-bench: synthetic benchmark for `js/edge-detect.js`

Pastes real document photos onto real background textures with random
rotation / perspective / blur and known ground-truth corners, then scores the
old (Canny) and new detectors: IoU, corner error, false positives.

Put this folder at `doc-scan-main/tools/edge-bench/` (or anywhere; set `EDGE_JS`).

```bash
cd tools/edge-bench
npm i pngjs jpeg-js                    # decoders used by lib.js
pip install pillow numpy               # for the generators
CARD_DIR=/path/to/cards python3 gen_bench.py   # writes bench/   (50 positives + 6 negatives)
CARD_DIR=/path/to/cards python3 gen_hard.py    # writes bench_hard/
node bench_run.js bench
node bench_run.js bench_hard
```
`CARD_DIR` must contain `votercard01.png` and `votercard02.jpeg` (the two
photos used for development; they are NOT included here because they are a
real person's ID card). The generators rectify them with hard-coded corner
quads, so for other photos edit the `rectify(...)` lines.
