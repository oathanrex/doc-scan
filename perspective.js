// perspective.js
// Maps a quadrilateral in a source image to a flat, axis-aligned
// rectangle in the output, using a homographic transform. Output
// image is the "as if scanned straight-on" page the PRD promises.

(function (global) {
  "use strict";

  // Compute the 8 elements of the 3x3 homography matrix that maps the
  // four source corners -> the four destination corners.
  //
  // src and dst are arrays of 4 {x, y} points, ordered TL, TR, BR, BL.
  function computeHomography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const sx = src[i].x;
      const sy = src[i].y;
      const dx = dst[i].x;
      const dy = dst[i].y;
      A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
      b.push(dx);
      b.push(dy);
    }
    const n = 8;
    const M = [];
    for (let i = 0; i < n; i++) M.push(A[i].concat([b[i]]));
    for (let i = 0; i < n; i++) {
      let max = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(M[k][i]) > Math.abs(M[max][i])) max = k;
      }
      const tmp = M[i];
      M[i] = M[max];
      M[max] = tmp;
      const piv = M[i][i] || 1e-12;
      for (let j = i; j <= n; j++) M[i][j] /= piv;
      for (let k = 0; k < n; k++) {
        if (k === i) continue;
        const f = M[k][i];
        for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
      }
    }
    const h = new Float64Array(8);
    for (let i = 0; i < n; i++) h[i] = M[i][n];
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + 1;
    return {
      x: (H[0] * x + H[1] * y + H[2]) / w,
      y: (H[3] * x + H[4] * y + H[5]) / w
    };
  }

  function outputSize(quad) {
    const top = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    const bottom = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
    const left = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    const right = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
    const w = Math.round((top + bottom) / 2);
    const h = Math.round((left + right) / 2);
    return { w: Math.max(64, w), h: Math.max(64, h) };
  }

  // 1D Catmull-Rom cubic spline interpolation
  function catmullRom(t, p0, p1, p2, p3) {
    const v = 0.5 * (
      2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
    );
    return v < 0 ? 0 : (v > 255 ? 255 : (v + 0.5 | 0));
  }

  // Render source -> destination, sampling the source via inverse mapping.
  // Supports options.interpolation: 'bicubic' (default high-fidelity Catmull-Rom) or 'bilinear'.
  function correct(sourceCanvas, quad, options) {
    options = options || {};
    const useBicubic = options.interpolation !== "bilinear";

    if (!quad || quad.length !== 4) {
      const out = document.createElement("canvas");
      out.width = sourceCanvas.width;
      out.height = sourceCanvas.height;
      out.getContext("2d").drawImage(sourceCanvas, 0, 0);
      return out;
    }

    const size = outputSize(quad);
    const dst = [
      { x: 0, y: 0 },
      { x: size.w, y: 0 },
      { x: size.w, y: size.h },
      { x: 0, y: size.h }
    ];
    const H = computeHomography(dst, quad);

    const out = document.createElement("canvas");
    out.width = size.w;
    out.height = size.h;
    const octx = out.getContext("2d");
    const img = octx.createImageData(size.w, size.h);
    const data = img.data;
    const sctx = sourceCanvas.getContext("2d");
    const sData = sctx.getImageData(
      0,
      0,
      sourceCanvas.width,
      sourceCanvas.height
    ).data;
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;

    for (let y = 0; y < size.h; y++) {
      for (let x = 0; x < size.w; x++) {
        const p = applyH(H, x, y);
        const px = p.x;
        const py = p.y;
        const di = (y * size.w + x) * 4;

        if (px < 0 || px >= sw - 1 || py < 0 || py >= sh - 1) {
          if (px >= 0 && px < sw && py >= 0 && py < sh) {
            const si = ((py | 0) * sw + (px | 0)) * 4;
            data[di] = sData[si];
            data[di + 1] = sData[si + 1];
            data[di + 2] = sData[si + 2];
            data[di + 3] = 255;
          } else {
            data[di] = 255;
            data[di + 1] = 255;
            data[di + 2] = 255;
            data[di + 3] = 255;
          }
          continue;
        }

        const x0 = px | 0;
        const y0 = py | 0;
        const dx = px - x0;
        const dy = py - y0;

        if (useBicubic && x0 >= 1 && x0 < sw - 2 && y0 >= 1 && y0 < sh - 2) {
          // High-fidelity 16-tap Catmull-Rom bicubic interpolation
          const ym1 = (y0 - 1) * sw;
          const y0w = y0 * sw;
          const yp1 = (y0 + 1) * sw;
          const yp2 = (y0 + 2) * sw;

          for (let c = 0; c < 3; c++) {
            const r0 = catmullRom(
              dx,
              sData[(ym1 + x0 - 1) * 4 + c],
              sData[(ym1 + x0) * 4 + c],
              sData[(ym1 + x0 + 1) * 4 + c],
              sData[(ym1 + x0 + 2) * 4 + c]
            );
            const r1 = catmullRom(
              dx,
              sData[(y0w + x0 - 1) * 4 + c],
              sData[(y0w + x0) * 4 + c],
              sData[(y0w + x0 + 1) * 4 + c],
              sData[(y0w + x0 + 2) * 4 + c]
            );
            const r2 = catmullRom(
              dx,
              sData[(yp1 + x0 - 1) * 4 + c],
              sData[(yp1 + x0) * 4 + c],
              sData[(yp1 + x0 + 1) * 4 + c],
              sData[(yp1 + x0 + 2) * 4 + c]
            );
            const r3 = catmullRom(
              dx,
              sData[(yp2 + x0 - 1) * 4 + c],
              sData[(yp2 + x0) * 4 + c],
              sData[(yp2 + x0 + 1) * 4 + c],
              sData[(yp2 + x0 + 2) * 4 + c]
            );
            data[di + c] = catmullRom(dy, r0, r1, r2, r3);
          }
          data[di + 3] = 255;
        } else {
          // Bilinear fallback near image boundaries
          const x1 = x0 + 1;
          const y1 = y0 + 1;
          const w00 = (1 - dx) * (1 - dy);
          const w10 = dx * (1 - dy);
          const w01 = (1 - dx) * dy;
          const w11 = dx * dy;

          const i00 = (y0 * sw + x0) * 4;
          const i10 = (y0 * sw + x1) * 4;
          const i01 = (y1 * sw + x0) * 4;
          const i11 = (y1 * sw + x1) * 4;

          data[di] = (sData[i00] * w00 + sData[i10] * w10 + sData[i01] * w01 + sData[i11] * w11) + 0.5 | 0;
          data[di + 1] = (sData[i00 + 1] * w00 + sData[i10 + 1] * w10 + sData[i01 + 1] * w01 + sData[i11 + 1] * w11) + 0.5 | 0;
          data[di + 2] = (sData[i00 + 2] * w00 + sData[i10 + 2] * w10 + sData[i01 + 2] * w01 + sData[i11 + 2] * w11) + 0.5 | 0;
          data[di + 3] = 255;
        }
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // Calculate largest interior inscribed rectangle within rotated rectangle
  function getLargestInscribedRect(width, height, angleRad) {
    const absAngle = Math.abs(angleRad) % (Math.PI / 2);
    if (absAngle < 1e-4) {
      return { width, height };
    }
    const cos = Math.cos(absAngle);
    const sin = Math.sin(absAngle);
    const cos2 = cos * cos;
    const sin2 = sin * sin;
    if (Math.abs(cos2 - sin2) < 1e-4) {
      const s = Math.min(width, height) / (Math.SQRT2);
      return { width: Math.round(s), height: Math.round(s) };
    }
    const w = Math.max(16, Math.round((width * cos - height * sin) / (cos2 - sin2)));
    const h = Math.max(16, Math.round((height * cos - width * sin) / (cos2 - sin2)));
    return { width: Math.min(width, w), height: Math.min(height, h) };
  }

  const api = { correct, computeHomography, outputSize, applyH, catmullRom, getLargestInscribedRect };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.Perspective = api;
})(typeof window !== "undefined" ? window : globalThis);
