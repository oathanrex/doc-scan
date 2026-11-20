/**
 * Texloom Studio: Decompiled 16-Tap Catmull-Rom Bicubic Resampling Kernel
 * Extracted from chunk 0dgcsmu4_bgr0.js (Module 289816)
 * 
 * Evaluates Catmull-Rom cubic polynomial over a 4x4 (16 pixel) neighborhood.
 * Avoids bilinear blur while eliminating Lanczos ringing.
 */

// 1D Catmull-Rom cubic spline polynomial
function catmullRom1D(t, p0, p1, p2, p3) {
  const v = 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  );
  return v < 0 ? 0 : (v > 255 ? 255 : (v + 0.5 | 0));
}

/**
 * 2D 16-Tap Bicubic Pixel Resampling
 * @param {Uint8ClampedArray} srcData - Source RGBA buffer
 * @param {number} sw - Source image width
 * @param {number} sh - Source image height
 * @param {number} px - Sub-pixel X coordinate
 * @param {number} py - Sub-pixel Y coordinate
 * @param {number} channel - 0 for Red, 1 for Green, 2 for Blue
 */
function sampleBicubicChannel(srcData, sw, sh, px, py, channel) {
  const x0 = px | 0;
  const y0 = py | 0;
  const dx = px - x0;
  const dy = py - y0;

  // Clamped indices across 4 rows and 4 columns
  const xm1 = Math.max(0, x0 - 1);
  const xp1 = Math.min(sw - 1, x0 + 1);
  const xp2 = Math.min(sw - 1, x0 + 2);

  const ym1 = Math.max(0, y0 - 1) * sw;
  const y0w = y0 * sw;
  const yp1 = Math.min(sh - 1, y0 + 1) * sw;
  const yp2 = Math.min(sh - 1, y0 + 2) * sw;

  // Evaluate Catmull-Rom across 4 rows
  const r0 = catmullRom1D(
    dx,
    srcData[(ym1 + xm1) * 4 + channel],
    srcData[(ym1 + x0) * 4 + channel],
    srcData[(ym1 + xp1) * 4 + channel],
    srcData[(ym1 + xp2) * 4 + channel]
  );
  const r1 = catmullRom1D(
    dx,
    srcData[(y0w + xm1) * 4 + channel],
    srcData[(y0w + x0) * 4 + channel],
    srcData[(y0w + xp1) * 4 + channel],
    srcData[(y0w + xp2) * 4 + channel]
  );
  const r2 = catmullRom1D(
    dx,
    srcData[(yp1 + xm1) * 4 + channel],
    srcData[(yp1 + x0) * 4 + channel],
    srcData[(yp1 + xp1) * 4 + channel],
    srcData[(yp1 + xp2) * 4 + channel]
  );
  const r3 = catmullRom1D(
    dx,
    srcData[(yp2 + xm1) * 4 + channel],
    srcData[(yp2 + x0) * 4 + channel],
    srcData[(yp2 + xp1) * 4 + channel],
    srcData[(yp2 + xp2) * 4 + channel]
  );

  // Evaluate vertically across the 4 row results
  return catmullRom1D(dy, r0, r1, r2, r3);
}

module.exports = {
  catmullRom1D,
  sampleBicubicChannel
};
