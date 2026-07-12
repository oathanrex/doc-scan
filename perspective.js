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

  // Render source -> destination, sampling the source via inverse mapping.
  function correct(sourceCanvas, quad) {
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
        const sx = Math.round(p.x);
        const sy = Math.round(p.y);
        const di = (y * size.w + x) * 4;
        if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) {
          data[di] = 255;
          data[di + 1] = 255;
          data[di + 2] = 255;
          data[di + 3] = 255;
          continue;
        }
        const si = (sy * sw + sx) * 4;
        data[di] = sData[si];
        data[di + 1] = sData[si + 1];
        data[di + 2] = sData[si + 2];
        data[di + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  global.Perspective = { correct, computeHomography };
})(window);
