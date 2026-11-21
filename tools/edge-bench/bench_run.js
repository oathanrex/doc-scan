const fs = require("fs");
const OLD = require("./edge-detect.old.js");
const NEW = require(process.env.EDGE_JS || "../../js/edge-detect.js");
const { decode, resize } = require("./lib");

function oldDetect(img) {
  const w = 240, h = Math.max(1, Math.round(240 * img.h / img.w));
  const small = resize(img, w, h);
  const gray = OLD.toGrayscale({ data: small.data });
  const blurred = OLD.blur(gray, w, h);
  const { mag } = OLD.sobel(blurred, w, h);
  const nms = OLD.nonMaxSuppression(mag, blurred, w, h);
  const edges = OLD.threshold(nms, 40, 100);
  const initial = OLD.findQuad(edges, w, h);
  if (!initial) return null;
  const q = OLD.refineQuadWithGradients(initial, gray, w, h);
  const dx1 = q[1].x - q[0].x, dy1 = q[1].y - q[0].y, dx2 = q[2].x - q[1].x, dy2 = q[2].y - q[1].y;
  const top = Math.hypot(dx1, dy1), right = Math.hypot(dx2, dy2);
  const area = ((q[2].x - q[0].x) * (q[2].y - q[0].y)) / (w * h);
  const conf = Math.min(1, area * 2) * (Math.min(top, right) / Math.max(top, right));
  const sc = img.w / w;
  return { quad: q.map(p => ({ x: p.x * sc, y: p.y * sc })), confidence: conf };
}

function newDetect(img, opts) {
  const getScaled = (maxSide) => {
    const s = Math.min(1, maxSide / Math.max(img.w, img.h));
    const r = s === 1 ? img : resize(img, Math.max(2, Math.round(img.w * s)), Math.max(2, Math.round(img.h * s)));
    return { data: r.data, w: r.w, h: r.h, s };
  };
  const res = NEW.detectCore(getScaled, img.w, img.h, Object.assign(process.env.NM ? { narrowMin: parseFloat(process.env.NM) } : {}, opts || {}));
  return res.quad ? { quad: res.quad, confidence: res.confidence } : null;
}

// polygon IoU by rasterising on a coarse grid
function inPoly(q, x, y) {
  let c = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    if ((q[i].y > y) !== (q[j].y > y) && x < ((q[j].x - q[i].x) * (y - q[i].y)) / (q[j].y - q[i].y) + q[i].x) c = !c;
  }
  return c;
}
function iou(a, b, W, H) {
  let inter = 0, uni = 0;
  const st = 4;
  for (let y = 0; y < H; y += st) for (let x = 0; x < W; x += st) {
    const A = inPoly(a, x, y), B = inPoly(b, x, y);
    if (A && B) inter++;
    if (A || B) uni++;
  }
  return uni ? inter / uni : 0;
}
function cornerErr(det, gt, W, H) {
  const diag = Math.hypot(W, H);
  let best = Infinity;
  for (let s = 0; s < 4; s++) {
    let e = 0;
    for (let i = 0; i < 4; i++) e += Math.hypot(det[(i + s) % 4].x - gt[i].x, det[(i + s) % 4].y - gt[i].y);
    best = Math.min(best, e / 4);
  }
  return (100 * best) / diag;
}

const DIR = process.argv[2] || "bench";
const cases = JSON.parse(fs.readFileSync(DIR + "/cases.json"));
const groups = {};
for (const c of cases) {
  const img = decode(c.file);
  const t0 = Date.now();
  const o = oldDetect(img);
  const t1 = Date.now();
  const n = newDetect(img);
  const t2 = Date.now();
  const g = (groups[c.name] = groups[c.name] || { n: 0, old: [], neu: [], oldMs: 0, newMs: 0 });
  g.n++; g.oldMs += t1 - t0; g.newMs += t2 - t1;
  for (const [key, r] of [["old", o], ["neu", n]]) {
    if (c.gt === null) { g[key].push({ found: !!r }); continue; }
    if (!r) { g[key].push({ found: false, iou: 0, err: 99 }); continue; }
    g[key].push({ found: true, iou: iou(r.quad, c.gt, c.w, c.h), err: cornerErr(r.quad, c.gt, c.w, c.h), conf: r.confidence });
  }
}

const pct = (a, f) => (100 * a.filter(f).length / a.length).toFixed(0).padStart(3) + "%";
const avg = (a, k) => (a.reduce((s, x) => s + x[k], 0) / a.length);
console.log("group                  n | OLD: iou>=.95  iou>=.85  meanIoU  meanErr%diag | NEW: iou>=.95  iou>=.85  meanIoU  meanErr%diag |  ms old/new");
let tot = { old: [], neu: [] };
for (const [name, g] of Object.entries(groups)) {
  if (name === "negative") {
    console.log(name.padEnd(22), String(g.n).padStart(2), "| OLD false-positives:", g.old.filter(x => x.found).length, "/", g.n, "          | NEW false-positives:", g.neu.filter(x => x.found).length, "/", g.n);
    continue;
  }
  tot.old.push(...g.old); tot.neu.push(...g.neu);
  console.log(name.padEnd(22), String(g.n).padStart(2), "|     ", pct(g.old, x => x.iou >= .95), "    ", pct(g.old, x => x.iou >= .85), "    ", avg(g.old, "iou").toFixed(3), "   ", avg(g.old, "err").toFixed(2).padStart(6),
    "      |     ", pct(g.neu, x => x.iou >= .95), "    ", pct(g.neu, x => x.iou >= .85), "    ", avg(g.neu, "iou").toFixed(3), "   ", avg(g.neu, "err").toFixed(2).padStart(6), "     |", (g.oldMs / g.n).toFixed(0), "/", (g.newMs / g.n).toFixed(0));
}
console.log("-".repeat(150));
console.log("ALL (positives)".padEnd(22), String(tot.old.length).padStart(2), "|     ", pct(tot.old, x => x.iou >= .95), "    ", pct(tot.old, x => x.iou >= .85), "    ", avg(tot.old, "iou").toFixed(3), "   ", avg(tot.old, "err").toFixed(2).padStart(6),
  "      |     ", pct(tot.neu, x => x.iou >= .95), "    ", pct(tot.neu, x => x.iou >= .85), "    ", avg(tot.neu, "iou").toFixed(3), "   ", avg(tot.neu, "err").toFixed(2).padStart(6));

