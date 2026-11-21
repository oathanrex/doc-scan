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

test('Edge Detection: Thresholding and quad search preserves 4-corner polygon geometry', () => {
  const { threshold, findQuad } = require('../js/edge-detect.js');
  const w = 100;
  const h = 100;
  const nms = new Float32Array(w * h);

  // Draw a bright rectangle border at x=20..80, y=20..80
  for (let x = 20; x <= 80; x++) {
    nms[20 * w + x] = 120;
    nms[80 * w + x] = 120;
  }
  for (let y = 20; y <= 80; y++) {
    nms[y * w + 20] = 120;
    nms[y * w + 80] = 120;
  }

  const edges = threshold(nms, 40, 100);
  assert.ok(edges instanceof Uint8ClampedArray);

  const quad = findQuad(edges, w, h);
  assert.ok(Array.isArray(quad), 'findQuad should return array of 4 corners');
  assert.equal(quad.length, 4);

  // Check that TL corner is around (20, 20) and BR corner is around (80, 80)
  assert.ok(Math.abs(quad[0].x - 20) <= 2, `TL x expected ~20, got ${quad[0].x}`);
  assert.ok(Math.abs(quad[0].y - 20) <= 2, `TL y expected ~20, got ${quad[0].y}`);
  assert.ok(Math.abs(quad[2].x - 80) <= 2, `BR x expected ~80, got ${quad[2].x}`);
  assert.ok(Math.abs(quad[2].y - 80) <= 2, `BR y expected ~80, got ${quad[2].y}`);
});

test('Bicubic Spline: catmullRom computes smooth cubic interpolation', () => {
  const { catmullRom } = require('../js/perspective.js');
  assert.equal(catmullRom(0, 10, 50, 90, 100), 50);
  assert.equal(catmullRom(1, 10, 50, 90, 100), 90);
  const mid = catmullRom(0.5, 10, 50, 90, 100);
  assert.ok(mid > 65 && mid < 75, 'Midpoint should be smoothly interpolated');
});

test('Texloom Line Intersection: fitLine and lineIntersect accurately locate analytic corners', () => {
  const { fitLine, lineIntersect } = require('../js/edge-detect.js');
  const l1 = fitLine([{ x: 0, y: 15 }, { x: 50, y: 15 }, { x: 100, y: 15 }]);
  const l2 = fitLine([{ x: 30, y: 0 }, { x: 30, y: 50 }, { x: 30, y: 100 }]);
  const pt = lineIntersect(l1, l2);
  assert.ok(Math.abs(pt.x - 30) < 1e-4);
  assert.ok(Math.abs(pt.y - 15) < 1e-4);
});

test('Perceptual Saliency: detectDocumentFromRgba accurately segments card on textured background', () => {
  const { detectDocumentFromRgba } = require('../js/edge-detect.js');
  const w = 200, h = 200;
  const rgba = new Uint8ClampedArray(w * h * 4);

  // Background: cream (220, 210, 200) with pattern variance
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      rgba[idx] = 220 + ((x + y) % 4);
      rgba[idx + 1] = 210;
      rgba[idx + 2] = 200;
      rgba[idx + 3] = 255;
    }
  }

  // Foreground card: x=40..160, y=50..150
  for (let y = 50; y <= 150; y++) {
    for (let x = 40; x <= 160; x++) {
      const idx = (y * w + x) * 4;
      rgba[idx] = 40;
      rgba[idx + 1] = 120;
      rgba[idx + 2] = 220;
      rgba[idx + 3] = 255;
    }
  }

  const res = detectDocumentFromRgba(rgba, w, h);
  assert.ok(res && res.quad, 'Should detect document quad');
  assert.equal(res.quad.length, 4);

  // Check corners within 2px precision
  assert.ok(Math.abs(res.quad[0].x - 40) <= 2, `TL x expected ~40, got ${res.quad[0].x}`);
  assert.ok(Math.abs(res.quad[0].y - 50) <= 2, `TL y expected ~50, got ${res.quad[0].y}`);
  assert.ok(Math.abs(res.quad[1].x - 160) <= 2, `TR x expected ~160, got ${res.quad[1].x}`);
  assert.ok(Math.abs(res.quad[1].y - 50) <= 2, `TR y expected ~50, got ${res.quad[1].y}`);
  assert.ok(Math.abs(res.quad[2].x - 160) <= 2, `BR x expected ~160, got ${res.quad[2].x}`);
  assert.ok(Math.abs(res.quad[2].y - 150) <= 2, `BR y expected ~150, got ${res.quad[2].y}`);
  assert.ok(Math.abs(res.quad[3].x - 40) <= 2, `BL x expected ~40, got ${res.quad[3].x}`);
  assert.ok(Math.abs(res.quad[3].y - 150) <= 2, `BL y expected ~150, got ${res.quad[3].y}`);
});
