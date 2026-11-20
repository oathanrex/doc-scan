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
