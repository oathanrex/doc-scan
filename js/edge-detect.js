// edge-detect.js
// Advanced document edge detection combining Texloom-grade Perceptual
// CIE L*a*b* saliency & texture variance segmentation with sub-pixel
// gradient normal sweeps and PCA line intersection corner snapping.

(function (global) {
  "use strict";

  // ---------- Image Helpers & Color Space ----------
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

  // Fast separable sliding-window box blur
  function boxBlur(t, w, h, r, passes) {
    passes = passes || 1;
    const l = 2 * r + 1;
    let curr = t.slice();
    const tmp = new Float32Array(t.length);
    const clamp = (v, m) => (v < 0 ? 0 : v > m ? m : v);

    for (let p = 0; p < passes; p++) {
      // Horizontal pass
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += curr[row + clamp(i, w - 1)];
        for (let x = 0; x < w; x++) {
          tmp[row + x] = sum / l;
          sum += curr[row + clamp(x + r + 1, w - 1)] - curr[row + clamp(x - r, w - 1)];
        }
      }
      // Vertical pass
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += tmp[clamp(i, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          curr[y * w + x] = sum / l;
          sum += tmp[clamp(y + r + 1, h - 1) * w + x] - tmp[clamp(y - r, h - 1) * w + x];
        }
      }
    }
    return curr;
  }

  function blur(gray, w, h) {
    const res = boxBlur(gray, w, h, 1, 1);
    const out = new Uint8ClampedArray(res.length);
    for (let i = 0; i < res.length; i++) out[i] = Math.round(res[i]);
    return out;
  }

  function morph(t, w, h, r, isDilate) {
    const blurred = boxBlur(t, w, h, r, 1);
    const out = new Float32Array(t.length);
    const thresh = isDilate ? 1e-4 : 0.9999;
    for (let i = 0; i < t.length; i++) {
      out[i] = +(blurred[i] > thresh);
    }
    return out;
  }

  // CIE sRGB to CIE L*a*b* conversion
  const srgbToLinear = function (e) {
    const t = e / 255;
    return t > 0.04045 ? Math.pow((t + 0.055) / 1.055, 2.4) : t / 12.92;
  };

  const labF = function (e) {
    return e > 0.008856 ? Math.cbrt(e) : 7.787 * e + 16 / 116;
  };

  function rgbToLab(r, g, b) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const x = labF((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
    const y = labF(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
    const z = labF((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  function median(arr) {
    const a = Float32Array.from(arr).sort();
    return a.length ? a[a.length >> 1] : 0;
  }

  function percentile(arr, pct) {
    const a = Float32Array.from(arr).sort();
    if (!a.length) return 0;
    return a[Math.min(a.length - 1, Math.floor((pct / 100) * a.length))];
  }

  // ---------- Classical Canny/Sobel Pipeline ----------
  function sobel(gray, w, h) {
    const mag = new Float32Array(gray.length);
    const dir = new Float32Array(gray.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const tl = gray[i - w - 1], tc = gray[i - w], tr = gray[i - w + 1];
        const ml = gray[i - 1], mr = gray[i + 1];
        const bl = gray[i + w - 1], bc = gray[i + w], br = gray[i + w + 1];
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
      else if (edges[i] >= low) out[i] = 80;
    }
    return out;
  }

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
    if (!points || points.length < 2) return null;
    let sx = 0, sy = 0;
    for (let i = 0; i < points.length; i++) {
      sx += points[i].x !== undefined ? points[i].x : points[i][0];
      sy += points[i].y !== undefined ? points[i].y : points[i][1];
    }
    const mx = sx / points.length;
    const my = sy / points.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < points.length; i++) {
      const px = points[i].x !== undefined ? points[i].x : points[i][0];
      const py = points[i].y !== undefined ? points[i].y : points[i][1];
      const dx = px - mx;
      const dy = py - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    // PCA line equation: a*x + b*y + c = 0
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const a = -Math.sin(theta);
    const b = Math.cos(theta);
    const c = -(a * mx + b * my);
    return { a, b, c, p: [mx, my], d: [Math.cos(theta), Math.sin(theta)] };
  }

  function lineIntersect(l1, l2) {
    if (!l1 || !l2) return null;
    const det = l1.a * l2.b - l2.a * l1.b;
    if (Math.abs(det) < 1e-6) return null;
    const x = (l1.b * l2.c - l2.b * l1.c) / det;
    const y = (l2.a * l1.c - l1.a * l2.c) / det;
    return { x, y };
  }

  function refineQuadWithGradients(quad, gray, w, h, customRadius) {
    if (!quad || quad.length !== 4) return quad;
    const radius = customRadius || Math.max(4, Math.round(0.0175 * Math.max(w, h)));
    const getP = (x, y) =>
      gray[
        Math.min(h - 1, Math.max(0, Math.round(y))) * w +
          Math.min(w - 1, Math.max(0, Math.round(x)))
      ];
    const lines = [];

    for (let i = 0; i < 4; i++) {
      const p1 = quad[i];
      const p2 = quad[(i + 1) % 4];
      const p1x = p1.x !== undefined ? p1.x : p1[0];
      const p1y = p1.y !== undefined ? p1.y : p1[1];
      const p2x = p2.x !== undefined ? p2.x : p2[0];
      const p2y = p2.y !== undefined ? p2.y : p2[1];

      const dx = p2x - p1x;
      const dy = p2y - p1y;
      const len = Math.hypot(dx, dy);
      if (len < 12) return quad;
      const nx = -dy / len;
      const ny = dx / len;

      const edgePoints = [];
      const numSamples = 120;
      for (let s = 0; s < numSamples; s++) {
        const t = 0.08 + (0.84 * s) / (numSamples - 1);
        const bx = p1x + t * dx;
        const by = p1y + t * dy;
        let maxG = -1;
        let bestDist = 0;
        for (let d = -radius; d <= radius; d++) {
          const sx = bx + d * nx;
          const sy = by + d * ny;
          const g = Math.abs(getP(sx + nx, sy + ny) - getP(sx - nx, sy - ny));
          if (g > maxG) {
            maxG = g;
            bestDist = d;
          }
        }
        if (maxG > 5) {
          edgePoints.push({ x: bx + bestDist * nx, y: by + bestDist * ny });
        }
      }

      if (edgePoints.length < 10) {
        lines.push(null);
        continue;
      }

      const l0 = fitLine(edgePoints);
      if (!l0) {
        lines.push(null);
        continue;
      }

      // Statistical outlier rejection (2.5x median error)
      const distFromLine = (pt) =>
        Math.abs((pt.x - l0.p[0]) * l0.d[1] - (pt.y - l0.p[1]) * l0.d[0]);
      const medDist = median(edgePoints.map(distFromLine)) || 1;
      const thresh = Math.max(1, 2.5 * medDist);
      const inliers = edgePoints.filter((pt) => distFromLine(pt) <= thresh);
      lines.push(inliers.length >= 8 ? fitLine(inliers) : l0);
    }

    const q0 = lineIntersect(lines[3], lines[0]);
    const q1 = lineIntersect(lines[0], lines[1]);
    const q2 = lineIntersect(lines[1], lines[2]);
    const q3 = lineIntersect(lines[2], lines[3]);

    if (!q0 || !q1 || !q2 || !q3) return quad;

    const refined = [q0, q1, q2, q3];
    for (let i = 0; i < 4; i++) {
      const p = refined[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return quad;
      const origPt = quad[i];
      const ox = origPt.x !== undefined ? origPt.x : origPt[0];
      const oy = origPt.y !== undefined ? origPt.y : origPt[1];
      if (Math.hypot(p.x - ox, p.y - oy) > 2.5 * radius) {
        return quad;
      }
    }

    return refined.map((p) => ({
      x: Math.max(0, Math.min(w, Math.round(p.x))),
      y: Math.max(0, Math.min(h, Math.round(p.y)))
    }));
  }

  // ---------- Perceptual Lab Saliency & Texture Segmentation ----------
  function detectDocumentFromRgba(rgba, srcW, srcH) {
    const maxDim = 512;
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.max(2, Math.round(srcW * scale));
    const h = Math.max(2, Math.round(srcH * scale));
    const s = w * h;

    const u = new Float32Array(s),
      a_ch = new Float32Array(s),
      b_ch = new Float32Array(s);
    for (let y = 0; y < h; y++) {
      const origY = Math.min(srcH - 1, Math.round(y / scale));
      for (let x = 0; x < w; x++) {
        const origX = Math.min(srcW - 1, Math.round(x / scale));
        const idx = (origY * srcW + origX) * 4;
        const [labL, labA, labB] = rgbToLab(rgba[idx], rgba[idx + 1], rgba[idx + 2]);
        const p = y * w + x;
        u[p] = 2.55 * labL;
        a_ch[p] = labA;
        b_ch[p] = labB;
      }
    }

    const c = boxBlur(u, w, h, 4, 1);
    const d = boxBlur(a_ch, w, h, 4, 1);
    const g = boxBlur(b_ch, w, h, 4, 1);

    const p = new Float32Array(s);
    for (let t = 0; t < s; t++) p[t] = u[t] * u[t];
    const m = boxBlur(p, w, h, 4, 1);
    const varL = new Float32Array(s);
    for (let t = 0; t < s; t++) varL[t] = Math.sqrt(Math.max(0, m[t] - c[t] * c[t]));

    const yBorder = Math.max(3, Math.round(0.012 * Math.max(w, h)));
    const borderIndices = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < yBorder || y < yBorder || x >= w - yBorder || y >= h - yBorder) {
          borderIndices.push(y * w + x);
        }
      }
    }

    const b = median(borderIndices.map((i) => varL[i]));
    const step = Math.max(1, Math.floor(borderIndices.length / 256));
    const U = [];
    for (let t = 0; t < borderIndices.length; t += step) {
      const idx = borderIndices[t];
      U.push(c[idx], d[idx], g[idx]);
    }

    const S = new Float32Array(s),
      A = new Float32Array(s);
    for (let t = 0; t < s; t++) {
      let minD = Infinity;
      for (let r = 0; r < U.length; r += 3) {
        const dist =
          (c[t] - U[r]) ** 2 + (d[t] - U[r + 1]) ** 2 + (g[t] - U[r + 2]) ** 2;
        if (dist < minD) minD = dist;
      }
      S[t] = Math.sqrt(minD);
      A[t] = Math.abs(varL[t] - b);
    }

    const D = [];
    for (let t = step >> 1; t < borderIndices.length; t += step) D.push(S[borderIndices[t]]);
    const j = percentile(D, 95) + 2;
    const I = percentile(borderIndices.map((i) => A[i]), 95) + 1;

    const E = new Float32Array(s);
    for (let t = 0; t < s; t++) E[t] = Math.max(S[t] / j, A[t] / I);

    const k = boxBlur(E, w, h, 1, 1);
    let F = new Float32Array(s);
    for (let t = 0; t < s; t++) F[t] = +(k[t] > 1.6);

    F = morph(morph(F, w, h, 1, false), w, h, 1, true);
    const T = 2;
    F = morph(morph(F, w, h, T, true), w, h, T, false);

    // Connected component flood fill
    const visited = new Uint8Array(s);
    const stack = new Int32Array(s);
    let largestComp = new Int32Array(0);

    for (let i = 0; i < s; i++) {
      if (!F[i] || visited[i]) continue;
      let sp = 0,
        count = 0;
      const compPixels = [];
      stack[sp++] = i;
      visited[i] = 1;

      while (sp > 0) {
        const cur = stack[--sp];
        compPixels.push(cur);
        count++;
        const cx = cur % w;
        const cy = (cur - cx) / w;

        const neighbors = [
          cx > 0 ? cur - 1 : -1,
          cx < w - 1 ? cur + 1 : -1,
          cy > 0 ? cur - w : -1,
          cy < h - 1 ? cur + w : -1
        ];
        for (let nb of neighbors) {
          if (nb >= 0 && F[nb] && !visited[nb]) {
            visited[nb] = 1;
            stack[sp++] = nb;
          }
        }
      }

      if (count > largestComp.length) {
        largestComp = Int32Array.from(compPixels);
      }
    }

    if (largestComp.length < 0.05 * s || largestComp.length > 0.95 * s) {
      return null;
    }

    // Seed corners from diagonal extremes
    let idxTL = 0,
      idxTR = 0,
      idxBR = 0,
      idxBL = 0;
    let minSum = Infinity,
      maxSum = -Infinity,
      maxDiff = -Infinity,
      minDiff = Infinity;
    for (let idx of largestComp) {
      const x = idx % w;
      const y = (idx - x) / w;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        idxTL = idx;
      }
      if (sum > maxSum) {
        maxSum = sum;
        idxBR = idx;
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        idxTR = idx;
      }
      if (diff < minDiff) {
        minDiff = diff;
        idxBL = idx;
      }
    }

    const seedCorners = [
      { x: Math.round((idxTL % w) / scale), y: Math.round(Math.floor(idxTL / w) / scale) },
      { x: Math.round((idxTR % w) / scale), y: Math.round(Math.floor(idxTR / w) / scale) },
      { x: Math.round((idxBR % w) / scale), y: Math.round(Math.floor(idxBR / w) / scale) },
      { x: Math.round((idxBL % w) / scale), y: Math.round(Math.floor(idxBL / w) / scale) }
    ];

    // High-res sub-pixel refinement
    const gray = new Float32Array(srcW * srcH);
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const idx = (y * srcW + x) * 4;
        gray[y * srcW + x] =
          0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
      }
    }
    const smoothedGray = boxBlur(gray, srcW, srcH, 1, 2);
    const normalRadius = Math.max(4, Math.round(0.0175 * Math.max(srcW, srcH)));
    const refinedQuad = refineQuadWithGradients(
      seedCorners,
      smoothedGray,
      srcW,
      srcH,
      normalRadius
    );

    return {
      quad: refinedQuad,
      confidence: 0.95,
      w: srcW,
      h: srcH
    };
  }

  // ---------- Public Unified API ----------
  function detect(source) {
    let rgba, srcW, srcH;
    if (source && source.data && source.width && source.height) {
      rgba = source.data;
      srcW = source.width;
      srcH = source.height;
    } else if (typeof document !== "undefined") {
      srcW = source.videoWidth || source.naturalWidth || source.width || 320;
      srcH = source.videoHeight || source.naturalHeight || source.height || 240;
      const canvas = document.createElement("canvas");
      canvas.width = srcW;
      canvas.height = srcH;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      try {
        ctx.drawImage(source, 0, 0, srcW, srcH);
        const imgData = ctx.getImageData(0, 0, srcW, srcH);
        rgba = imgData.data;
      } catch (e) {
        return { quad: null, confidence: 0 };
      }
    } else {
      return { quad: null, confidence: 0 };
    }

    // 1. Primary: Texloom-grade Perceptual Lab Saliency & Texture Segmentation
    try {
      const salRes = detectDocumentFromRgba(rgba, srcW, srcH);
      if (salRes && salRes.quad) {
        return salRes;
      }
    } catch (e) {
      // Fall through to classical contour pipeline
    }

    // 2. Secondary Fallback: Sobel edge contour detector
    const targetW = 240;
    const aspect = srcH / srcW || 0.75;
    const w = targetW;
    const h = Math.max(1, Math.round(targetW * aspect));

    const gray = new Uint8ClampedArray(w * h);
    const scaleX = srcW / w;
    const scaleY = srcH / h;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(srcH - 1, Math.round(y * scaleY));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(srcW - 1, Math.round(x * scaleX));
        const idx = (sy * srcW + sx) * 4;
        gray[y * w + x] =
          (rgba[idx] * 299 + rgba[idx + 1] * 587 + rgba[idx + 2] * 114 + 500) / 1000 | 0;
      }
    }

    const blurred = blur(gray, w, h);
    const { mag, dir } = sobel(blurred, w, h);
    const nms = nonMaxSuppression(mag, dir, w, h);
    const edges = threshold(nms, 40, 100);
    const initialQuad = findQuad(edges, w, h);

    if (!initialQuad) return { quad: null, confidence: 0 };

    const quad = refineQuadWithGradients(initialQuad, gray, w, h);
    const dx1 = quad[1].x - quad[0].x;
    const dy1 = quad[1].y - quad[0].y;
    const dx2 = quad[2].x - quad[1].x;
    const dy2 = quad[2].y - quad[1].y;
    const top = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const right = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    const area = ((quad[2].x - quad[0].x) * (quad[2].y - quad[0].y)) / (w * h);
    const rect = Math.min(top, right) / Math.max(top, right);
    const confidence = Math.min(1, area * 2) * rect;

    const finalQuad = quad.map((p) => ({
      x: Math.round(p.x * scaleX),
      y: Math.round(p.y * scaleY)
    }));

    return { quad: finalQuad, confidence, w: srcW, h: srcH };
  }

  const api = {
    detect,
    detectDocumentFromRgba,
    toGrayscale,
    blur,
    boxBlur,
    morph,
    sobel,
    nonMaxSuppression,
    threshold,
    findQuad,
    fitLine,
    lineIntersect,
    refineQuadWithGradients,
    rgbToLab
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.EdgeDetect = api;
})(typeof window !== "undefined" ? window : globalThis);
