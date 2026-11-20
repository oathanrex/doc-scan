// edge-detect.js
// Real-time document edge detection from a <video> frame or image
// using a Canny-style pipeline followed by sub-pixel gradient normal
// sampling and PCA line intersections for laser-accurate corner snapping.

(function (global) {
  "use strict";

  // ---------- Image helpers ----------
  function toGrayscale(imageData) {
    const d = imageData.data;
    const n = d.length;
    const out = new Uint8ClampedArray(n / 4);
    for (let i = 0, j = 0; i < n; i += 4, j++) {
      // Rec. 601 luma
      out[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 + 500) / 1000 | 0;
    }
    return out;
  }

  function blur(gray, w, h) {
    // 3x3 box blur (separable, two passes): fast and stable.
    const tmp = new Uint8ClampedArray(gray.length);
    const out = new Uint8ClampedArray(gray.length);
    // Horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const xm = Math.max(0, x - 1);
        const xp = Math.min(w - 1, x + 1);
        tmp[row + x] = (gray[row + xm] + gray[row + x] + gray[row + xp]) / 3 | 0;
      }
    }
    // Vertical
    for (let y = 0; y < h; y++) {
      const ym = Math.max(0, y - 1);
      const yp = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const a = tmp[ym * w + x];
        const b = tmp[y * w + x];
        const c = tmp[yp * w + x];
        out[y * w + x] = (a + b + c) / 3 | 0;
      }
    }
    return out;
  }

  function sobel(gray, w, h) {
    const mag = new Float32Array(gray.length);
    const dir = new Float32Array(gray.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const tl = gray[i - w - 1],
          tc = gray[i - w],
          tr = gray[i - w + 1];
        const ml = gray[i - 1],
          mr = gray[i + 1];
        const bl = gray[i + w - 1],
          bc = gray[i + w],
          br = gray[i + w + 1];
        const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
        const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
        mag[i] = Math.sqrt(gx * gx + gy * gy);
        dir[i] = Math.atan2(gy, gx);
      }
    }
    return { mag, dir };
  }

  function nonMaxSuppression(mag, dir, w, h) {
    const out = new Uint8ClampedArray(mag.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const a = dir[i];
        // Quantize to 4 directions
        let n1, n2;
        const ax = Math.abs(Math.cos(a));
        const ay = Math.abs(Math.sin(a));
        if (ax > ay) {
          n1 = mag[i - 1];
          n2 = mag[i + 1];
        } else {
          n1 = mag[i - w];
          n2 = mag[i + w];
        }
        if (mag[i] >= n1 && mag[i] >= n2) out[i] = mag[i] | 0;
      }
    }
    return out;
  }

  function threshold(edges, low, high) {
    const out = new Uint8ClampedArray(edges.length);
    for (let i = 0; i < edges.length; i++) {
      if (edges[i] >= high) out[i] = 255;
      else if (edges[i] >= low) out[i] = 80; // weak
    }
    return out;
  }

  // ---------- Quad search ----------
  function findQuad(edges, w, h) {
    const rowScore = new Float32Array(h);
    const colScore = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) {
        const v = edges[y * w + x];
        s += v;
        colScore[x] += v;
      }
      rowScore[y] = s;
    }

    const rowMax = Math.max.apply(null, rowScore);
    const colMax = Math.max.apply(null, colScore);
    if (rowMax === 0 || colMax === 0) return null;
    const rowThresh = rowMax * 0.3;
    const colThresh = colMax * 0.3;

    const rows = [];
    for (let y = 0; y < h; y++) if (rowScore[y] > rowThresh) rows.push(y);
    const cols = [];
    for (let x = 0; x < w; x++) if (colScore[x] > colThresh) cols.push(x);

    if (!rows.length || !cols.length) return null;

    const top = rows[0];
    const bottom = rows[rows.length - 1];
    const left = cols[0];
    const right = cols[cols.length - 1];

    if (bottom - top < h * 0.2 || right - left < w * 0.2) return null;

    function findCorner(rowDir, colDir) {
      const corner = { x: 0, y: 0 };
      if (rowDir === "top") corner.y = top;
      else corner.y = bottom;
      if (colDir === "left") corner.x = left;
      else corner.x = right;

      const cx = corner.x;
      const cy = corner.y;
      const r = 12;
      let bestX = cx;
      let bestY = cy;
      let bestScore = -1;
      let bestDist = Infinity;
      for (let dy = -r; dy <= r; dy += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          const x = Math.max(0, Math.min(w - 1, cx + dx));
          const y = Math.max(0, Math.min(h - 1, cy + dy));
          const s = edges[(y * w + x) | 0];
          const dist = dx * dx + dy * dy;
          if (s > bestScore || (s === bestScore && dist < bestDist)) {
            bestScore = s;
            bestDist = dist;
            bestX = x;
            bestY = y;
          }
        }
      }
      return { x: bestX, y: bestY };
    }

    return [
      findCorner("top", "left"),
      findCorner("top", "right"),
      findCorner("bottom", "right"),
      findCorner("bottom", "left")
    ];
  }

  // ---------- PCA Line Fitting & Line Intersection (Texloom Method) ----------
  function fitLine(points) {
    if (points.length < 3) return null;
    let sx = 0, sy = 0;
    for (let i = 0; i < points.length; i++) {
      sx += points[i].x;
      sy += points[i].y;
    }
    const mx = sx / points.length;
    const my = sy / points.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - mx;
      const dy = points[i].y - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    // PCA line equation: a*x + b*y + c = 0
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const a = -Math.sin(theta);
    const b = Math.cos(theta);
    const c = -(a * mx + b * my);
    return { a, b, c };
  }

  function lineIntersect(l1, l2) {
    if (!l1 || !l2) return null;
    const det = l1.a * l2.b - l2.a * l1.b;
    if (Math.abs(det) < 1e-6) return null;
    const x = (l1.b * l2.c - l2.b * l1.c) / det;
    const y = (l2.a * l1.c - l1.a * l2.c) / det;
    return { x, y };
  }

  function refineQuadWithGradients(quad, gray, w, h) {
    if (!quad || quad.length !== 4) return quad;
    const lines = [];

    for (let i = 0; i < 4; i++) {
      const p1 = quad[i];
      const p2 = quad[(i + 1) % 4];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 12) return quad;
      const nx = -dy / len;
      const ny = dx / len;

      const points = [];
      const numSamples = 20;
      for (let s = 1; s < numSamples; s++) {
        const t = s / numSamples;
        const bx = p1.x + t * dx;
        const by = p1.y + t * dy;
        let maxG = -1;
        let bestDist = 0;
        for (let d = -10; d <= 10; d++) {
          const sx = Math.round(bx + d * nx);
          const sy = Math.round(by + d * ny);
          if (sx >= 1 && sx < w - 1 && sy >= 1 && sy < h - 1) {
            const gx = gray[sy * w + sx + 1] - gray[sy * w + sx - 1];
            const gy = gray[(sy + 1) * w + sx] - gray[(sy - 1) * w + sx];
            const g = Math.abs(gx * nx + gy * ny);
            if (g > maxG) {
              maxG = g;
              bestDist = d;
            }
          }
        }
        if (maxG > 12) {
          points.push({ x: bx + bestDist * nx, y: by + bestDist * ny });
        }
      }

      const l = fitLine(points);
      if (!l) return quad;
      lines.push(l);
    }

    // Intersections: (L3, L0), (L0, L1), (L1, L2), (L2, L3)
    const q0 = lineIntersect(lines[3], lines[0]);
    const q1 = lineIntersect(lines[0], lines[1]);
    const q2 = lineIntersect(lines[1], lines[2]);
    const q3 = lineIntersect(lines[2], lines[3]);

    if (!q0 || !q1 || !q2 || !q3) return quad;

    const refined = [q0, q1, q2, q3];
    for (let i = 0; i < 4; i++) {
      const p = refined[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return quad;
      if (p.x < -w * 0.1 || p.x > w * 1.1 || p.y < -h * 0.1 || p.y > h * 1.1) return quad;
    }

    return refined.map(p => ({
      x: Math.max(0, Math.min(w, Math.round(p.x))),
      y: Math.max(0, Math.min(h, Math.round(p.y)))
    }));
  }

  // ---------- Public API ----------
  function detect(source) {
    const srcW = source.videoWidth || source.naturalWidth || source.width || 320;
    const srcH = source.videoHeight || source.naturalHeight || source.height || 240;
    const targetW = 240;
    const aspect = srcH / srcW || 0.75;
    const w = targetW;
    const h = Math.max(1, Math.round(targetW * aspect));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    try {
      ctx.drawImage(source, 0, 0, w, h);
    } catch (e) {
      return { quad: null, confidence: 0 };
    }
    const data = ctx.getImageData(0, 0, w, h);
    const gray = toGrayscale(data);
    const blurred = blur(gray, w, h);
    const { mag } = sobel(blurred, w, h);
    const nms = nonMaxSuppression(mag, blurred, w, h);
    const edges = threshold(nms, 40, 100);
    const initialQuad = findQuad(edges, w, h);

    if (!initialQuad) return { quad: null, confidence: 0 };

    // Refine with sub-pixel gradient normal sampling and PCA line intersections
    const quad = refineQuadWithGradients(initialQuad, gray, w, h);

    // Confidence: how "rectangular" the found quad is + how big it is.
    const dx1 = quad[1].x - quad[0].x;
    const dy1 = quad[1].y - quad[0].y;
    const dx2 = quad[2].x - quad[1].x;
    const dy2 = quad[2].y - quad[1].y;
    const top = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const right = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    const area = ((quad[2].x - quad[0].x) * (quad[2].y - quad[0].y)) / (w * h);
    const rect = Math.min(top, right) / Math.max(top, right);
    const confidence = Math.min(1, area * 2) * rect;

    return { quad, confidence, w, h };
  }

  const api = {
    detect,
    toGrayscale,
    blur,
    sobel,
    nonMaxSuppression,
    threshold,
    findQuad,
    fitLine,
    lineIntersect,
    refineQuadWithGradients
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.EdgeDetect = api;
})(typeof window !== "undefined" ? window : globalThis);
