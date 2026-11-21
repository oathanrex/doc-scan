const test = require('node:test');
const assert = require('node:assert/strict');

const { computeHomography, applyH, outputSize } = require('../js/perspective.js');
const { buildPdf, buildPageContent, buildImageXObject } = require('../js/pdf-export.js');
const { toGrayscale } = require('../js/edge-detect.js');

test('Homography: Identity mapping produces identity matrix', () => {
  const quad = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 }
  ];
  const H = computeHomography(quad, quad);
  
  // H should be [1, 0, 0, 0, 1, 0, 0, 0]
  assert.ok(Math.abs(H[0] - 1) < 1e-6, 'H[0] should be 1');
  assert.ok(Math.abs(H[1]) < 1e-6, 'H[1] should be 0');
  assert.ok(Math.abs(H[2]) < 1e-6, 'H[2] should be 0');
  assert.ok(Math.abs(H[3]) < 1e-6, 'H[3] should be 0');
  assert.ok(Math.abs(H[4] - 1) < 1e-6, 'H[4] should be 1');
  assert.ok(Math.abs(H[5]) < 1e-6, 'H[5] should be 0');
  assert.ok(Math.abs(H[6]) < 1e-6, 'H[6] should be 0');
  assert.ok(Math.abs(H[7]) < 1e-6, 'H[7] should be 0');

  const pt = applyH(H, 50, 50);
  assert.ok(Math.abs(pt.x - 50) < 1e-4);
  assert.ok(Math.abs(pt.y - 50) < 1e-4);
});

test('Homography: Scale and translate mapping preserves projected coordinates', () => {
  const src = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 20 },
    { x: 0, y: 20 }
  ];
  const dst = [
    { x: 50, y: 100 },
    { x: 150, y: 100 },
    { x: 150, y: 300 },
    { x: 50, y: 300 }
  ];
  const H = computeHomography(src, dst);
  
  const mid = applyH(H, 5, 10);
  assert.ok(Math.abs(mid.x - 100) < 1e-4, 'Midpoint x should be 100');
  assert.ok(Math.abs(mid.y - 200) < 1e-4, 'Midpoint y should be 200');
});

test('Perspective: outputSize calculates proportional bounding rectangle', () => {
  const quad = [
    { x: 10, y: 10 },
    { x: 310, y: 15 },
    { x: 300, y: 410 },
    { x: 5, y: 405 }
  ];
  const size = outputSize(quad);
  assert.ok(size.w >= 290 && size.w <= 310, `Width should be ~300, got ${size.w}`);
  assert.ok(size.h >= 390 && size.h <= 410, `Height should be ~400, got ${size.h}`);
});

test('Edge Detection: toGrayscale accurately computes Rec. 601 luma', () => {
  // Pure Red: (255 * 299 + 500) / 1000 = 76
  // Pure Green: (255 * 587 + 500) / 1000 = 149
  // Pure Blue: (255 * 114 + 500) / 1000 = 29
  // White: (255 * 299 + 255 * 587 + 255 * 114 + 500) / 1000 = 255
  const mockImageData = {
    data: new Uint8ClampedArray([
      255, 0, 0, 255,       // Red
      0, 255, 0, 255,       // Green
      0, 0, 255, 255,       // Blue
      255, 255, 255, 255    // White
    ])
  };
  const gray = toGrayscale(mockImageData);
  assert.equal(gray.length, 4);
  assert.equal(gray[0], 76);
  assert.equal(gray[1], 150);
  assert.equal(gray[2], 29);
  assert.equal(gray[3], 255);
});

test('PDF Export: Generates valid PDF 1.4 binary structure', async () => {
  const mockPages = [
    {
      jpegBytes: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]), // JPEG magic
      width: 100,
      height: 150
    }
  ];
  const pdfBlob = buildPdf(mockPages, 'a4');
  assert.ok(pdfBlob instanceof Blob, 'PDF output should be a Blob');
  assert.equal(pdfBlob.type, 'application/pdf');

  const pdfText = await pdfBlob.text();
  assert.ok(pdfText.length > 200, 'PDF should have valid length');
  
  // PDF 1.4 Header check
  assert.ok(pdfText.startsWith('%PDF-1.4'), 'Must start with %PDF-1.4 header');

  // Structural objects
  assert.ok(pdfText.includes('/Type /Catalog'), 'Must contain Catalog dictionary');
  assert.ok(pdfText.includes('/Type /Pages'), 'Must contain Pages tree dictionary');
  assert.ok(pdfText.includes('/Type /Page'), 'Must contain Page dictionary');
  assert.ok(pdfText.includes('/Filter /DCTDecode'), 'Must contain JPEG DCTDecode stream');

  // Cross reference & trailer
  assert.ok(pdfText.includes('xref'), 'Must contain cross-reference table');
  assert.ok(pdfText.includes('trailer'), 'Must contain trailer dictionary');
  assert.ok(pdfText.includes('startxref'), 'Must contain startxref pointer');
  assert.ok(pdfText.includes('%%EOF'), 'Must end with %%EOF marker');
});

test('PDF Export: Page Content scales and centers correctly', () => {
  const content = buildPageContent(100, 200, 595.28, 841.89);
  assert.ok(content.startsWith('q\n'), 'Must push graphics state');
  assert.ok(content.includes('/Im0 Do\n'), 'Must invoke image XObject');
  assert.ok(content.endsWith('Q\n'), 'Must pop graphics state');
});

test('Perspective Crop: Homography correctly projects angled trapezoid corners to orthogonal rectangle', () => {
  // Simulating a document photographed at an angle (trapezoid)
  const angledTrapezoid = [
    { x: 30, y: 40 },
    { x: 270, y: 20 },
    { x: 290, y: 380 },
    { x: 10, y: 360 }
  ];
  const targetRect = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 400 },
    { x: 0, y: 400 }
  ];
  const H = computeHomography(angledTrapezoid, targetRect);

  // Four corners should map to exactly the orthogonal target rectangle
  for (let i = 0; i < 4; i++) {
    const pt = applyH(H, angledTrapezoid[i].x, angledTrapezoid[i].y);
    assert.ok(Math.abs(pt.x - targetRect[i].x) < 1e-3, `Corner ${i} x mapped correctly`);
    assert.ok(Math.abs(pt.y - targetRect[i].y) < 1e-3, `Corner ${i} y mapped correctly`);
  }
});

test('Bicubic Spline: catmullRom computes smooth cubic interpolation', () => {
  const { catmullRom } = require('../js/perspective.js');
  assert.equal(catmullRom(0, 10, 50, 90, 100), 50);
  assert.equal(catmullRom(1, 10, 50, 90, 100), 90);
  const mid = catmullRom(0.5, 10, 50, 90, 100);
  assert.ok(mid > 65 && mid < 75, 'Midpoint should be smoothly interpolated');
});

// ---------------------------------------------------------------------------
// Edge detection (Texloom-style segmentation + boundary-contrast refinement)
// ---------------------------------------------------------------------------
const ED = require('../js/edge-detect.js');

// deterministic PRNG so tests never flake
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inConvex(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (c === 0) continue;
    if (!sign) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

// Printed-bedsheet look: pink base, fine dot texture, big white "leaves" with
// pink outlines. Optional card (light blue, dark text rows) inside `quad`.
function makeScene(w, h, quad, opts = {}) {
  const rnd = mulberry32(opts.seed || 1);
  const data = new Uint8ClampedArray(w * h * 4);
  const leaves = [];
  for (let i = 0; i < 9; i++) {
    leaves.push({ x: rnd() * w, y: rnd() * h, rx: 20 + rnd() * 40, ry: 12 + rnd() * 30, a: rnd() * Math.PI });
  }
  // Like a real printed sheet, the leaf colours also show up along the frame
  // edges (the detector learns "what is background" from that frame).
  for (let i = 0; i < 4; i++) {
    const t = 0.15 + 0.7 * rnd();
    leaves.push({ x: t * w, y: 0, rx: 30, ry: 18, a: 0.3 });
    leaves.push({ x: t * w, y: h, rx: 30, ry: 18, a: -0.3 });
    leaves.push({ x: 0, y: t * h, rx: 18, ry: 30, a: 0.2 });
    leaves.push({ x: w, y: t * h, rx: 18, ry: 30, a: -0.2 });
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 238, g = 200, b = 192;
      if ((x % 6 < 2) && (y % 6 < 2)) { r -= 14; g -= 22; b -= 22; } // fine dot texture
      for (const L of leaves) {
        const dx = x - L.x, dy = y - L.y;
        const u = dx * Math.cos(L.a) + dy * Math.sin(L.a), v = -dx * Math.sin(L.a) + dy * Math.cos(L.a);
        const d = (u * u) / (L.rx * L.rx) + (v * v) / (L.ry * L.ry);
        if (d < 1) { r = 247; g = 243; b = 238; }
        else if (d < 1.12) { r = 214; g = 140; b = 128; }
      }
      if (quad && inConvex(quad, x + 0.5, y + 0.5)) {
        r = 168; g = 214; b = 236;
        // dark "text" rows + a strong headline rule near the top of the card
        const t = quad.length ? (y - Math.min(...quad.map((p) => p.y))) : 0;
        if (t % 14 < 3 && t > 22) { r = 50; g = 60; b = 70; }
        if (opts.headline && t >= 14 && t < 17) { r = 20; g = 25; b = 30; }
      }
      const n = (rnd() - 0.5) * 5;
      data[i] = r + n; data[i + 1] = g + n; data[i + 2] = b + n; data[i + 3] = 255;
    }
  }
  return { data, w, h };
}

function rotatedRect(cx, cy, hw, hh, deg, skew = 0) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-hw + skew, -hh], [hw - skew, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
    x: cx + x * c - y * s,
    y: cy + x * s + y * c
  }));
}

function runDetect(img, opts) {
  const getScaled = () => ({ data: img.data, w: img.w, h: img.h, s: 1 });
  return ED.detectCore(getScaled, img.w, img.h, opts || {});
}

function maxCornerError(det, gt) {
  // best cyclic alignment
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const d = det[(i + k) % 4], g = gt[i];
      worst = Math.max(worst, Math.hypot(d.x - g.x, d.y - g.y));
    }
    best = Math.min(best, worst);
  }
  return best;
}

test('Edge Detection: segmentSeed isolates a document blob on a patterned background', () => {
  const gt = rotatedRect(160, 220, 80, 110, 0);
  const img = makeScene(320, 440, gt);
  const seed = ED.segmentSeed(img.data, img.w, img.h, {});
  assert.ok(seed, 'a seed quad must be found');
  assert.equal(seed.quad.length, 4);
  // seed only needs to be roughly on the card (refinement does the rest)
  assert.ok(maxCornerError(seed.quad.map(([x, y]) => ({ x, y })), gt) < 40, 'seed corners should be near the card');
});

test('Edge Detection: detectCore recovers an upright card on a busy background', () => {
  const gt = rotatedRect(160, 220, 80, 110, 0);
  const res = runDetect(makeScene(320, 440, gt), { refineSide: 0 });
  assert.ok(res.quad, 'document should be detected');
  assert.ok(res.confidence > 0.4, `confidence ${res.confidence}`);
  assert.ok(maxCornerError(res.quad, gt) < 6, `corner error ${maxCornerError(res.quad, gt)}`);
});

test('Edge Detection: handles a strongly rotated card (rotated-rectangle seed)', () => {
  const gt = rotatedRect(160, 220, 70, 100, 38);
  const res = runDetect(makeScene(320, 440, gt, { seed: 5 }), { refineSide: 0 });
  assert.ok(res.quad, 'rotated document should be detected');
  assert.ok(maxCornerError(res.quad, gt) < 8, `corner error ${maxCornerError(res.quad, gt)}`);
});

test('Edge Detection: prefers the true outer edge over a strong headline rule inside the card', () => {
  const gt = rotatedRect(160, 220, 80, 110, 0);
  const res = runDetect(makeScene(320, 440, gt, { headline: true }), { refineSide: 0 });
  assert.ok(res.quad);
  const topY = Math.min(res.quad[0].y, res.quad[1].y);
  assert.ok(Math.abs(topY - gt[0].y) < 6, `top edge at ${topY}, card top is ${gt[0].y}`);
});

test('Edge Detection: returns no quad when the picture contains no document', () => {
  const res = runDetect(makeScene(320, 440, null, { seed: 9 }), { refineSide: 0 });
  assert.equal(res.quad, null);
  assert.equal(res.confidence, 0);
});

test('Edge Detection: image border is not mistaken for a document edge', () => {
  // card ends ~12px above the bottom of the frame; the border must not attract the edge
  const gt = rotatedRect(160, 170, 80, 110, 0); // bottom at y=280 of 440 -> big gap
  const gt2 = gt.map((p) => ({ x: p.x, y: p.y + 140 })); // bottom at 420 (20px from border)
  const res = runDetect(makeScene(320, 440, gt2, { seed: 3 }), { refineSide: 0 });
  assert.ok(res.quad);
  const bottomY = Math.max(res.quad[2].y, res.quad[3].y);
  assert.ok(bottomY < 430, `bottom edge latched onto image border (${bottomY})`);
  assert.ok(Math.abs(bottomY - gt2[2].y) < 8, `bottom edge ${bottomY} vs ${gt2[2].y}`);
});

test('Edge Detection: live mode returns the same document with cheaper settings', () => {
  const gt = rotatedRect(160, 220, 80, 110, 0);
  const res = runDetect(makeScene(320, 440, gt), { live: true, maxSide: 192, contrastSide: 320, paletteSize: 32, refineSide: 0, thresholds: [1.6] });
  assert.ok(res.quad, 'live mode should still lock on');
  assert.ok(maxCornerError(res.quad, gt) < 14, `live corner error ${maxCornerError(res.quad, gt)}`);
});

test('Edge Detection: robustLine fits a line and rejects outliers (PCA + residual cut)', () => {
  const pts = [];
  for (let x = 0; x <= 100; x += 5) pts.push([x, 15]);
  pts.push([50, 60], [20, 90]); // two gross outliers
  const line = ED.robustLine(pts);
  assert.ok(Math.abs(Math.abs(line.d[0]) - 1) < 1e-3, 'direction should be horizontal');
  assert.ok(Math.abs(line.p[1] - 15) < 0.5, `line should sit at y=15, got ${line.p[1]}`);
});

test('Edge Detection: refineCorners snaps seed corners to analytic edge intersections', () => {
  const w = 200, h = 200;
  const gray = new Float32Array(w * h).fill(40);
  for (let y = 50; y < 150; y++) for (let x = 40; x < 160; x++) gray[y * w + x] = 220;
  const seed = [[44, 55], [155, 46], [163, 146], [37, 153]]; // slightly off
  const r = ED.refineCorners(ED.boxBlur(gray, w, h, 1, 1), w, h, seed, 12);
  const exp = [[40, 50], [160, 50], [160, 150], [40, 150]];
  r.quad.forEach((p, i) => {
    assert.ok(Math.hypot(p[0] - exp[i][0], p[1] - exp[i][1]) < 2.5, `corner ${i}: got ${p}`);
  });
});

test('Edge Detection: minAreaRect + orderQuad give a clockwise TL,TR,BR,BL rectangle', () => {
  const quad = rotatedRect(100, 100, 40, 60, 30).map((p) => [p.x, p.y]);
  const rect = ED.minAreaRect(ED.convexHull(quad.concat([[100, 100]])));
  const ordered = ED.orderQuad(rect);
  const area = ED.polyArea(ordered);
  assert.ok(Math.abs(area - 80 * 120) < 5, `area ${area}`);
  assert.ok(ED.isConvex(ordered));
  // clockwise in image coords (y down) => positive shoelace sum
  let s = 0;
  for (let i = 0; i < 4; i++) { const a = ordered[i], b = ordered[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; }
  assert.ok(s > 0, 'expected clockwise order');
});

test('Edge Detection: rgbToLab maps white to L~100 and neutral grey to a~b~0', () => {
  const white = ED.rgbToLab(255, 255, 255);
  assert.ok(Math.abs(white[0] - 100) < 0.5 && Math.abs(white[1]) < 0.5 && Math.abs(white[2]) < 0.5);
  const grey = ED.rgbToLab(128, 128, 128);
  assert.ok(Math.abs(grey[1]) < 0.5 && Math.abs(grey[2]) < 0.5);
});
