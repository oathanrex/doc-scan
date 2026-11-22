// edge-detect.js
// Automatic document-border detection for DocScan.
//
// Pipeline (ported from the Texloom "Flatten & Deskew" reference):
//
//   1. SEGMENT  - Learn what the *background* looks like from a thin frame
//                 around the image border (colour in CIE-Lab + local texture),
//                 then mark every pixel that is unlike that background.
//                 This is what makes it work on busy surfaces (printed
//                 bedsheets, wood grain, tablecloths) where plain edge
//                 detection drowns in pattern edges.
//   2. CLEAN    - morphological open + close, keep the largest connected blob.
//   3. SEED     - take the 4 extreme points of that blob (min/max of x+y, x-y).
//   4. REFINE   - on a 1600px grayscale copy, sweep perpendicular to each seed
//                 edge, find the strongest gradient, fit a line through those
//                 points (PCA + outlier rejection) and intersect adjacent
//                 lines -> sub-pixel corners.
//   5. VALIDATE - size / convexity / inside-vs-outside colour contrast.
//
// The core (detectCore) has no DOM dependency so it can be unit-tested in
// Node. detect(source) is the browser wrapper used by app.js.
//
// Public contract (unchanged for app.js):
//   detect(source) -> { quad: [{x,y} TL,TR,BR,BL], confidence: 0..1, w, h }
//   where quad is expressed in a w x h pixel space (the source's own pixel
//   size), so callers can scale with (targetW / res.w).

(function (global) {
  "use strict";

  // ------------------------------------------------------------------
  // Small numeric helpers
  // ------------------------------------------------------------------
  function median(arr) {
    if (!arr.length) return 0;
    const s = Float32Array.from(arr).sort();
    return s[s.length >> 1];
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = Float32Array.from(arr).sort();
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  }

  const clampIdx = (v, max) => (v < 0 ? 0 : v > max ? max : v);

  // ------------------------------------------------------------------
  // Colour: sRGB -> CIE-Lab (D65). Perceptual distance makes "pink vs pale
  // blue" separable even when their luminance is nearly identical.
  // ------------------------------------------------------------------
  const SRGB_LUT = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    SRGB_LUT[i] = t > 0.04045 ? Math.pow((t + 0.055) / 1.055, 2.4) : t / 12.92;
  }
  const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  function rgbToLab(r, g, b) {
    const R = SRGB_LUT[r | 0], G = SRGB_LUT[g | 0], B = SRGB_LUT[b | 0];
    const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
    const fy = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
    const fz = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  // ------------------------------------------------------------------
  // Separable box blur with clamped edges, O(n) via running sums.
  // Returns a new Float32Array (input is not modified).
  // ------------------------------------------------------------------
  function boxBlur(src, w, h, radius, iterations) {
    const win = 2 * radius + 1;
    const a = Float32Array.from(src);
    const b = new Float32Array(src.length);
    for (let it = 0; it < iterations; it++) {
      // horizontal a -> b
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += a[row + clampIdx(k, w - 1)];
        for (let x = 0; x < w; x++) {
          b[row + x] = s / win;
          s += a[row + clampIdx(x + radius + 1, w - 1)] - a[row + clampIdx(x - radius, w - 1)];
        }
      }
      // vertical b -> a
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += b[clampIdx(k, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = s / win;
          s += b[clampIdx(y + radius + 1, h - 1) * w + x] - b[clampIdx(y - radius, h - 1) * w + x];
        }
      }
    }
    return a;
  }

  // Binary morphology with a square structuring element (box-blur based).
  // dilate=true  -> any neighbour set   -> grows blobs / fills holes
  // dilate=false -> all neighbours set  -> erodes blobs / removes specks
  function morph(mask, w, h, radius, dilate) {
    const blurred = boxBlur(mask, w, h, radius, 1);
    const out = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      out[i] = dilate ? +(blurred[i] > 1e-4) : +(blurred[i] > 0.9999);
    }
    return out;
  }

  // Largest 4-connected blob of a binary mask; also tracks the 4 diagonal
  // extreme pixels while flooding, so no second pass is needed.
  function largestBlob(mask, w, h) {
    const seen = new Uint8Array(mask.length);
    const stack = new Int32Array(mask.length);
    let best = null;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      let sp = 0, size = 0;
      let minSum = Infinity, maxSum = -Infinity, maxDiff = -Infinity, minDiff = Infinity;
      let iTL = start, iBR = start, iTR = start, iBL = start;
      stack[sp++] = start;
      seen[start] = 1;
      while (sp) {
        const p = stack[--sp];
        size++;
        const x = p % w, y = (p - x) / w;
        const sum = x + y, diff = x - y;
        if (sum < minSum) { minSum = sum; iTL = p; }
        if (sum > maxSum) { maxSum = sum; iBR = p; }
        if (diff > maxDiff) { maxDiff = diff; iTR = p; }
        if (diff < minDiff) { minDiff = diff; iBL = p; }
        if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (!best || size > best.size) best = { size, start, iTL, iTR, iBR, iBL };
    }
    return best;
  }


  // ------------------------------------------------------------------
  // Seed-shape helpers: convex hull + minimum-area rotated rectangle.
  // The 4 "diagonal extreme" points only describe an (almost) upright
  // document; once it is rotated ~35deg or more two of them collapse onto the
  // same corner. The rotated rectangle covers that case.
  // ------------------------------------------------------------------
  function convexHull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function minAreaRect(hull) {
    let best = null;
    const n = hull.length;
    for (let i = 0; i < n; i++) {
      const a = hull[i], b = hull[(i + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      const ux = ex / len, uy = ey / len, vx = -uy, vy = ux;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of hull) {
        const pu = p[0] * ux + p[1] * uy, pv = p[0] * vx + p[1] * vy;
        if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
        if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) {
        const c = (u, v) => [u * ux + v * vx, u * uy + v * vy];
        best = { area, corners: [c(minU, minV), c(maxU, minV), c(maxU, maxV), c(minU, maxV)] };
      }
    }
    return best ? best.corners : null;
  }

  // Order 4 corners clockwise (image coords, y down) starting from the one
  // closest to the image's top-left, i.e. TL,TR,BR,BL for an upright document.
  function orderQuad(c) {
    let s = 0;
    for (let i = 0; i < 4; i++) { const a = c[i], b = c[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; }
    const q = s < 0 ? c.slice().reverse() : c.slice();
    let k = 0, bestSum = Infinity;
    for (let i = 0; i < 4; i++) if (q[i][0] + q[i][1] < bestSum) { bestSum = q[i][0] + q[i][1]; k = i; }
    return [q[k], q[(k + 1) % 4], q[(k + 2) % 4], q[(k + 3) % 4]];
  }

  // Fraction of (blob U quad) covered by both -> how well a quad explains the blob.
  function maskQuadIoU(mask, w, h, q) {
    let inter = 0, onlyMask = 0, onlyQuad = 0;
    let minY = Infinity, maxY = -Infinity;
    for (const p of q) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
    // pixels of the mask outside the quad's y-range are all "onlyMask"
    let maskTotal = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) maskTotal++;
    for (let y = y0; y <= y1; y++)
      for (let x = 0; x < w; x++) {
        const inQ = pointInConvex(q, x + 0.5, y + 0.5);
        if (!inQ) continue;
        if (mask[y * w + x]) inter++; else onlyQuad++;
      }
    onlyMask = maskTotal - inter;
    const uni = inter + onlyMask + onlyQuad;
    return uni ? inter / uni : 0;
  }

  // ------------------------------------------------------------------
  // STAGE 1-3: foreground segmentation -> seed quad
  // segmentPrepare: expensive, threshold-independent 'how unlike the background
  // is each pixel' map. segmentFromScore: cheap, run once per threshold.
  // ------------------------------------------------------------------
  function segmentPrepare(rgba, w, h, opts) {
    opts = opts || {};
    const n = w * h;
    if (w < 16 || h < 16) return null;
    const maxSide = Math.max(w, h);

    // Lab planes (L rescaled to 0..255 so distances are comparable to RGB-ish units)
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lab = rgbToLab(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
      L[i] = 2.55 * lab[0];
      A[i] = lab[1];
      B[i] = lab[2];
    }

    // Local mean colour + local texture (std-dev of L) in a 9x9 window.
    const mL = boxBlur(L, w, h, 4, 1);
    const mA = boxBlur(A, w, h, 4, 1);
    const mB = boxBlur(B, w, h, 4, 1);
    const L2 = new Float32Array(n);
    for (let i = 0; i < n; i++) L2[i] = L[i] * L[i];
    const mL2 = boxBlur(L2, w, h, 4, 1);
    const tex = new Float32Array(n);
    for (let i = 0; i < n; i++) tex[i] = Math.sqrt(Math.max(0, mL2[i] - mL[i] * mL[i]));

    // Border frame (~1.2% of the long side) = background reference.
    const bw = Math.max(3, Math.round(0.012 * maxSide));
    const border = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (x < bw || y < bw || x >= w - bw || y >= h - bw) border.push(y * w + x);

    const bgTex = median(border.map((i) => tex[i]));

    // Background palette: ~paletteSize evenly spaced border pixels.
    const paletteSize = opts.paletteSize || 256;
    const step = Math.max(1, Math.floor(border.length / paletteSize));
    const palette = [];
    for (let t = 0; t < border.length; t += step) {
      const i = border[t];
      palette.push(mL[i], mA[i], mB[i]);
    }
    const pn = palette.length;

    // Colour distance to nearest background palette entry + texture difference.
    const S = new Float32Array(n);
    const T = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = mL[i], a = mA[i], b = mB[i];
      let best = Infinity;
      for (let k = 0; k < pn; k += 3) {
        const dl = l - palette[k], da = a - palette[k + 1], db = b - palette[k + 2];
        const d = dl * dl + da * da + db * db;
        if (d < best) best = d;
      }
      S[i] = Math.sqrt(best);
      T[i] = Math.abs(tex[i] - bgTex);
    }

    // Normalise by how much the *background itself* varies (95th percentile of
    // the border), so busy backgrounds demand a bigger difference to count.
    const borderS = [];
    for (let t = step >> 1; t < border.length; t += step) borderS.push(S[border[t]]);
    const sNorm = percentile(borderS, 95) + 2;
    const tNorm = percentile(border.map((i) => T[i]), 95) + 1;

    const E = new Float32Array(n);
    for (let i = 0; i < n; i++) E[i] = Math.max(S[i] / sNorm, T[i] / tNorm);

    const smooth = boxBlur(E, w, h, 1, 1);
    return { smooth, w, h };
  }

  // thr ~1.6 = confident foreground only; lower values also accept pale
  // documents that sit close to the background colour.
  function segmentFromScore(prep, thr) {
    if (!prep) return null;
    const { smooth, w, h } = prep;
    const n = w * h;
    const maxSide = Math.max(w, h);
    let F = new Float32Array(n);
    for (let i = 0; i < n; i++) F[i] = +(smooth[i] > thr);

    // open (remove specks) then close (fill text/pattern holes inside the doc)
    F = morph(morph(F, w, h, 1, false), w, h, 1, true);
    const cr = Math.max(3, Math.round(0.01 * maxSide));
    F = morph(morph(F, w, h, cr, true), w, h, cr, false);

    // Clear border frame margin so boundary shadows never anchor extreme corners
    const bm = Math.max(3, Math.round(0.012 * maxSide));
    for (let y = 0; y < h; y++) {
      if (y < bm || y >= h - bm) {
        F.fill(0, y * w, (y + 1) * w);
      } else {
        for (let x = 0; x < bm; x++) {
          F[y * w + x] = 0;
          F[y * w + (w - 1 - x)] = 0;
        }
      }
    }

    const blob = largestBlob(F, w, h);
    if (!blob || blob.size < 0.05 * n || blob.size > 0.95 * n) return null;

    const xy = (i) => [i % w, Math.floor(i / w)];
    let quad = [xy(blob.iTL), xy(blob.iTR), xy(blob.iBR), xy(blob.iBL)];
    let seedKind = "extremes";

    // Candidate 2: minimum-area rotated rectangle of the blob's convex hull.
    // Per-row left/right extents of the blob are enough to build the hull.
    const hullPts = [];
    {
      const rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1);
      const seen = new Uint8Array(n);
      const stack = new Int32Array(n);
      let sp = 0;
      stack[sp++] = blob.start; seen[blob.start] = 1;
      while (sp) {
        const pI = stack[--sp];
        const x = pI % w, y = (pI - x) / w;
        if (x < rowMin[y]) rowMin[y] = x;
        if (x > rowMax[y]) rowMax[y] = x;
        if (x > 0 && F[pI - 1] && !seen[pI - 1]) { seen[pI - 1] = 1; stack[sp++] = pI - 1; }
        if (x < w - 1 && F[pI + 1] && !seen[pI + 1]) { seen[pI + 1] = 1; stack[sp++] = pI + 1; }
        if (y > 0 && F[pI - w] && !seen[pI - w]) { seen[pI - w] = 1; stack[sp++] = pI - w; }
        if (y < h - 1 && F[pI + w] && !seen[pI + w]) { seen[pI + w] = 1; stack[sp++] = pI + w; }
      }
      for (let y = 0; y < h; y++) if (rowMax[y] >= 0) { hullPts.push([rowMin[y], y], [rowMax[y] + 1, y + 1]); }
    }
    const rect = hullPts.length >= 3 ? minAreaRect(convexHull(hullPts)) : null;
    if (rect) {
      const rq = orderQuad(rect);
      if (isConvex(rq)) {
        const iouExt = maskQuadIoU(F, w, h, quad);
        const iouRect = maskQuadIoU(F, w, h, rq);
        if (iouRect > iouExt + 0.02) { quad = rq; seedKind = "rotated-rect"; }
      }
    }

    return {
      quad,
      mask: F,
      blobSize: blob.size,
      threshold: thr,
      seedKind
    };
  }

  function segmentSeed(rgba, w, h, opts) {
    opts = opts || {};
    return segmentFromScore(segmentPrepare(rgba, w, h, opts), opts.fgThreshold || 1.6);
  }

  // ------------------------------------------------------------------
  // STAGE 4: sub-pixel refinement (gradient sweep + PCA line fit)
  // ------------------------------------------------------------------

  // PCA line through points -> { p:[cx,cy], d:[dx,dy] } (unit direction)
  function pcaLine(pts) {
    let mx = 0, my = 0;
    for (const q of pts) { mx += q[0]; my += q[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const q of pts) {
      const dx = q[0] - mx, dy = q[1] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { p: [mx, my], d: [Math.cos(th), Math.sin(th)] };
  }

  // PCA fit, then drop points further than 2.5 x median residual and refit.
  function robustLine(pts) {
    if (pts.length < 2) return null;
    const first = pcaLine(pts);
    const resid = (q) =>
      Math.abs((q[0] - first.p[0]) * first.d[1] - (q[1] - first.p[1]) * first.d[0]);
    const cut = Math.max(1, 2.5 * median(pts.map(resid)));
    const inliers = pts.filter((q) => resid(q) <= cut);
    const line = inliers.length >= 2 ? pcaLine(inliers) : first;
    line.inliers = inliers.length;
    line.samples = pts.length;
    return line;
  }

  // gray: Float32Array (w*h), quad: [[x,y]x4] in the same pixel space.
  // Returns { quad, support, snapped } -- `support` = mean inlier ratio (0..1).
  function refineCorners(gray, w, h, quad, reach) {
    const px = (x, y) =>
      gray[clampIdx(Math.round(y), h - 1) * w + clampIdx(Math.round(x), w - 1)];
    const lines = [];
    let supportSum = 0;
    const SAMPLES = 120;

    for (let e = 0; e < 4; e++) {
      const a = quad[e], b = quad[(e + 1) % 4];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len; // unit normal
      const pts = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t = 0.08 + (0.84 * i) / (SAMPLES - 1);
        const bx = a[0] + t * dx, by = a[1] + t * dy;
        let bestG = 0, bestOff = 0;
        for (let o = -reach; o <= reach; o++) {
          const x = bx + o * nx, y = by + o * ny;
          const g = Math.abs(px(x + nx, y + ny) - px(x - nx, y - ny));
          if (g > bestG) { bestG = g; bestOff = o; }
        }
        if (bestG > 5) pts.push([bx + bestOff * nx, by + bestOff * ny]);
      }
      const line = pts.length >= 20 ? robustLine(pts) : null;
      lines.push(line);
      if (line) supportSum += line.inliers / SAMPLES;
    }

    let snapped = 0;
    const out = quad.map((seed, e) => {
      const r = lines[(e + 3) % 4], a = lines[e];
      if (!r || !a) return seed;
      const den = r.d[1] * a.d[0] - r.d[0] * a.d[1];
      if (Math.abs(den) < 1e-6) return seed;
      const ix = a.p[0] - r.p[0], iy = a.p[1] - r.p[1];
      const u = (iy * a.d[0] - ix * a.d[1]) / den;
      const pt = [r.p[0] + u * r.d[0], r.p[1] + u * r.d[1]];
      if (Math.hypot(pt[0] - seed[0], pt[1] - seed[1]) < 2 * reach) {
        snapped++;
        return pt;
      }
      return seed;
    });
    return { quad: out, support: supportSum / 4, snapped, lines };
  }


  // ------------------------------------------------------------------
  // STAGE 3b: boundary-contrast line search
  //
  // The colour segmentation can under-cover a document whose paper is close
  // to the background (e.g. a pale card top next to white flowers). Here every
  // side is re-fitted as the line whose *inside strip* and *outside strip*
  // differ most in Lab colour, consistently along its whole length:
  //
  //   score = P30(|step|) * coherence
  //
  //   step      = mean Lab(inside strip) - mean Lab(outside strip), per sample
  //   P30       = 30th percentile over the samples -> a few strong text pixels
  //               can't fake an edge, and ~30% breakage (a leaf touching the
  //               paper) doesn't kill a real one
  //   coherence = |mean step| / mean|step| -> a real paper edge has the same
  //               colour step all along it; pattern lines have random ones
  // ------------------------------------------------------------------
  function makeLabPlanes(rgba, w, h) {
    const n = w * h;
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lab = rgbToLab(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
      L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    }
    return {
      L: boxBlur(L, w, h, 1, 1),
      A: boxBlur(A, w, h, 1, 1),
      B: boxBlur(B, w, h, 1, 1),
      w, h
    };
  }

  const _sL = new Float32Array(256), _sA = new Float32Array(256), _sB = new Float32Array(256);
  const _mag = new Float32Array(256);

  // Score of one candidate line (x0,y0)->(x1,y1) with outward unit normal (nx,ny).
  // taps: array of pixel offsets from the line used for the inside/outside strips.
  function lineContrast(lab, x0, y0, x1, y1, nx, ny, taps, samples, margin) {
    const { L, A, B, w, h } = lab;
    const m = taps.length;
    let n = 0;
    for (let i = 0; i < samples; i++) {
      const t = margin + ((1 - 2 * margin) * i) / (samples - 1);
      const bx = x0 + t * (x1 - x0), by = y0 + t * (y1 - y0);
      // A sample is only valid if BOTH strips lie fully inside the picture.
      // (Clamping strips at the border replicates the edge pixel and fakes a
      // strong "edge" along the image border.)
      const far = taps[m - 1];
      const fx = far * nx, fy = far * ny;
      if (bx + fx < 0 || bx + fx > w - 1 || by + fy < 0 || by + fy > h - 1 ||
          bx - fx < 0 || bx - fx > w - 1 || by - fy < 0 || by - fy > h - 1) continue;
      let il = 0, ia = 0, ib = 0, ol = 0, oa = 0, ob = 0;
      for (let k = 0; k < m; k++) {
        const ox = clampIdx(Math.round(bx + taps[k] * nx), w - 1);
        const oy = clampIdx(Math.round(by + taps[k] * ny), h - 1);
        const ix = clampIdx(Math.round(bx - taps[k] * nx), w - 1);
        const iy = clampIdx(Math.round(by - taps[k] * ny), h - 1);
        const oi = oy * w + ox, ii = iy * w + ix;
        ol += L[oi]; oa += A[oi]; ob += B[oi];
        il += L[ii]; ia += A[ii]; ib += B[ii];
      }
      _sL[n] = (il - ol) / m;
      _sA[n] = (ia - oa) / m;
      _sB[n] = (ib - ob) / m;
      n++;
    }
    if (n < 0.3 * samples) return 0;
    let sl = 0, sa = 0, sb = 0, sm = 0;
    for (let i = 0; i < n; i++) {
      sl += _sL[i]; sa += _sA[i]; sb += _sB[i];
      _mag[i] = Math.sqrt(_sL[i] * _sL[i] + _sA[i] * _sA[i] + _sB[i] * _sB[i]);
      sm += _mag[i];
    }
    const coherence = Math.sqrt(sl * sl + sa * sa + sb * sb) / (sm + 1e-9);
    const sorted = _mag.slice(0, n);
    sorted.sort();
    return sorted[Math.floor(0.3 * (n - 1))] * coherence;
  }

  // quad: [[x,y]x4] (TL,TR,BR,BL) in lab's pixel space.
  //   reach     max shift (px) of each side end along its normal
  //   opts.stripStart / opts.stripLen   strip geometry (px)
  //   opts.outermost  true  -> pick the OUTERMOST significant line (robust to
  //                            printed content that out-contrasts a pale edge)
  //                   false -> pick the best line in the window (precise)
  function contrastRefine(lab, quad, reach, opts) {
    opts = opts || {};
    const step = opts.step || 3;
    const stripStart = opts.stripStart || 2;
    const stripLen = opts.stripLen || 3;
    const taps = [];
    for (let k = 0; k < stripLen; k++) taps.push(stripStart + k);
    const narrowTaps = [2, 3, 4];
    const narrowMin = opts.narrowMin === undefined ? 2.0 : opts.narrowMin;
    const minContrast = opts.minContrast === undefined ? 3.0 : opts.minContrast;
    const relFloor = opts.relFloor === undefined ? 0.08 : opts.relFloor;
    const outermost = !!opts.outermost;
    const SAMPLES = opts.samples || 70, MARGIN = 0.1;

    const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
    const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;

    const lines = [];
    const sideScores = [];
    for (let e = 0; e < 4; e++) {
      const a = quad[e], b = quad[(e + 1) % 4];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }

      const score = (d0, d1) =>
        lineContrast(lab, a[0] + d0 * nx, a[1] + d0 * ny, b[0] + d1 * nx, b[1] + d1 * ny,
          nx, ny, taps, SAMPLES, MARGIN);
      // same line seen through a thin strip: sharp for real edges, weak for noise
      const narrowScore = (d0, d1) =>
        lineContrast(lab, a[0] + d0 * nx, a[1] + d0 * ny, b[0] + d1 * nx, b[1] + d1 * ny,
          nx, ny, narrowTaps, SAMPLES, MARGIN);

      // 2) best line of the grid, polished to a 1px local peak
      const lim = 2 * step;
      const climb = (cur0, limit) => {
        let cur = cur0;
        const sd0 = cur.d0, sd1 = cur.d1;
        for (let iter = 0; iter < 60; iter++) {
          let moved = false;
          for (let a0 = -1; a0 <= 1; a0++)
            for (let a1 = -1; a1 <= 1; a1++) {
              if (!a0 && !a1) continue;
              const n0 = cur.d0 + a0, n1 = cur.d1 + a1;
              if (Math.abs(n0 - sd0) > limit || Math.abs(n1 - sd1) > limit) continue;
              const sc = score(n0, n1);
              if (sc > cur.raw + 1e-6) { cur = { raw: sc, d0: n0, d1: n1 }; moved = true; }
            }
          if (!moved) break;
        }
        return cur;
      };
      // Precise pass: never search the window afresh (a stronger printed line
      // just inside the edge would win). Only slide to the nearest local peak.
      if (opts.localOnly) {
        const c = climb({ raw: score(0, 0), d0: 0, d1: 0 }, reach);
        const q0 = [a[0] + c.d0 * nx, a[1] + c.d0 * ny];
        const q1 = [b[0] + c.d1 * nx, b[1] + c.d1 * ny];
        const l2 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
        lines.push({ p: q0, d: [(q1[0] - q0[0]) / l2, (q1[1] - q0[1]) / l2] });
        sideScores.push(c.raw);
        continue;
      }

      // 1) evaluate the whole (d0,d1) grid
      const nSteps = Math.floor((2 * reach) / step) + 1;
      const grid = new Float32Array(nSteps * nSteps);
      let top = 0, topI = 0, topJ = 0;
      for (let i = 0; i < nSteps; i++)
        for (let j = 0; j < nSteps; j++) {
          const sc = score(-reach + i * step, -reach + j * step);
          grid[i * nSteps + j] = sc;
          if (sc > top) { top = sc; topI = i; topJ = j; }
        }

      let cur = climb({ raw: top, d0: -reach + topI * step, d1: -reach + topJ * step }, lim);

      // 3) OUTERMOST significant parallel line (1-D scan, tilt kept fixed).
      //    Printed content inside a document (headline rules, barcodes, photo
      //    frames) can out-contrast a pale paper edge, but the real edge is
      //    always further out than any of them. Scanning in 1-D keeps the
      //    noise maximum low, unlike picking from the whole 2-D grid.
      if (outermost) {
        const outReach = opts.outReach || reach;
        const thr = Math.max(minContrast, relFloor * cur.raw);
        // A genuine edge, seen through a stripLen-px strip, produces a plateau at
        // least ~stripLen px wide. A lone 1-3px spike is just pattern noise.
        const minRun = Math.max(4, Math.round(0.75 * stripLen));
        // ...and a real edge is also SHARP: it shows a clear peak through a thin
        // strip (pattern noise and the shoulders of an edge do not).
        const wideS = new Float32Array(outReach + 1), narS = new Float32Array(outReach + 1);
        for (let t = 1; t <= outReach; t++) {
          wideS[t] = score(cur.d0 + t, cur.d1 + t);
          narS[t] = wideS[t] >= thr ? narrowScore(cur.d0 + t, cur.d1 + t) : 0;
        }
        let bestRun = null, runLen = 0, runStart = 0;
        const closeRun = (end) => {
          if (runLen >= minRun) {
            let pk = -1, pkT = 0;
            for (let t = runStart; t <= end; t++) if (narS[t] > pk) { pk = narS[t]; pkT = t; }
            if (pk >= narrowMin) bestRun = { raw: wideS[pkT], d0: cur.d0 + pkT, d1: cur.d1 + pkT };
          }
          runLen = 0;
        };
        for (let t = 1; t <= outReach; t++) {
          if (wideS[t] >= thr) { if (!runLen) runStart = t; runLen++; }
          else if (runLen) closeRun(t - 1);
        }
        if (runLen) closeRun(outReach);
        if (bestRun) cur = climb(bestRun, 3);
      }

      const p0 = [a[0] + cur.d0 * nx, a[1] + cur.d0 * ny];
      const p1 = [b[0] + cur.d1 * nx, b[1] + cur.d1 * ny];
      const ln = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      lines.push({ p: p0, d: [(p1[0] - p0[0]) / ln, (p1[1] - p0[1]) / ln] });
      sideScores.push(cur.raw);
    }

    const out = quad.map((seed, e) => {
      const r = lines[(e + 3) % 4], a = lines[e];
      const den = r.d[1] * a.d[0] - r.d[0] * a.d[1];
      if (Math.abs(den) < 1e-6) return seed;
      const ix = a.p[0] - r.p[0], iy = a.p[1] - r.p[1];
      const u = (iy * a.d[0] - ix * a.d[1]) / den;
      return [r.p[0] + u * r.d[0], r.p[1] + u * r.d[1]];
    });
    return { quad: out, sideScores };
  }

  // ------------------------------------------------------------------
  // STAGE 5: validation helpers
  // ------------------------------------------------------------------
  function polyArea(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cr === 0) continue;
      if (!sign) sign = Math.sign(cr);
      else if (Math.sign(cr) !== sign) return false;
    }
    return sign !== 0;
  }

  // Not degenerate: sides at least 15% of the frame, area at least 5%, convex.
  function quadIsUsable(q, w, h) {
    const d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const wid = Math.min(d(q[0], q[1]), d(q[3], q[2]));
    const hei = Math.min(d(q[0], q[3]), d(q[1], q[2]));
    if (wid < 0.15 * w || hei < 0.15 * h) return false;
    if (polyArea(q) < 0.05 * w * h) return false;
    return isConvex(q);
  }

  function pointInConvex(q, x, y) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (c === 0) continue;
      if (!sign) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
    return true;
  }

  // Colour histogram overlap (inside quad vs outside, 64 bins). Near 1 means
  // the "document" looks just like the background -> detection is bogus.
  function insideOutsideOverlap(rgba, w, h, q) {
    const inH = new Float64Array(64), outH = new Float64Array(64);
    let nIn = 0, nOut = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const bin = ((4 * rgba[i]) >> 8) * 16 + ((4 * rgba[i + 1]) >> 8) * 4 + ((4 * rgba[i + 2]) >> 8);
        if (pointInConvex(q, x + 0.5, y + 0.5)) { inH[bin]++; nIn++; } else { outH[bin]++; nOut++; }
      }
    }
    if (nIn === 0 || nOut < 0.01 * w * h) return null; // quad ~ whole frame: can't judge
    let ov = 0;
    for (let k = 0; k < 64; k++) ov += Math.min(inH[k] / nIn, outH[k] / nOut);
    return ov;
  }

  // ------------------------------------------------------------------
  // Core entry point (DOM-free)
  //   getScaled(maxSide) -> { data:Uint8ClampedArray RGBA, w, h, s } | null
  //       s = scale factor applied to the source (<= 1)
  //   srcW/srcH = full source size
  // Returns { quad:[{x,y}x4] in source pixels, confidence, w, h, debug } or
  //         { quad:null, confidence:0, ... }
  //
  // Strategy: try the confident segmentation threshold first. If that finds
  // nothing usable (pale paper on a pale background), retry with progressively
  // more permissive thresholds -- every attempt must still pass the same
  // boundary-evidence checks, so a permissive threshold can't invent a document.
  // ------------------------------------------------------------------
  function detectCore(getScaled, srcW, srcH, opts) {
    opts = opts || {};
    const segSide = opts.maxSide || 512;
    const midSide = opts.contrastSide || 800;
    const refineSide = opts.refineSide === undefined ? 1600 : opts.refineSide;
    const live = !!opts.live; // cheap per-frame settings for the camera loop
    const ladder = opts.thresholds || (opts.fgThreshold ? [opts.fgThreshold] : [1.6, 1.3, 1.0, 0.8]);
    const dbg = opts.debug ? { attempts: [] } : null;
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

    // memoise getScaled: the same scale is requested by several stages
    const memo = {};
    const scaled = (side) => {
      const key = Math.min(side, Math.max(srcW, srcH));
      if (!(key in memo)) memo[key] = getScaled(side);
      return memo[key];
    };
    const miss = () => ({ quad: null, confidence: 0, w: srcW, h: srcH, debug: dbg });

    const seg = scaled(segSide);
    if (!seg) return miss();
    const prep = segmentPrepare(seg.data, seg.w, seg.h, opts);
    if (!prep) return miss();

    const mid = scaled(midSide);
    if (!mid) return miss();
    const lab = makeLabPlanes(mid.data, mid.w, mid.h);
    const M = Math.max(mid.w, mid.h);
    const kMid = mid.s / seg.s;

    let hiGray = null; // built lazily, shared by attempts
    const getHiGray = () => {
      if (hiGray) return hiGray;
      const hi = scaled(refineSide);
      if (!hi) return null;
      const g = new Float32Array(hi.w * hi.h);
      for (let i = 0; i < g.length; i++) {
        g[i] = 0.299 * hi.data[4 * i] + 0.587 * hi.data[4 * i + 1] + 0.114 * hi.data[4 * i + 2];
      }
      hiGray = { gs: boxBlur(g, hi.w, hi.h, 1, 2), w: hi.w, h: hi.h, s: hi.s, data: hi.data };
      return hiGray;
    };

    const attempt = (thr, index) => {
      const seed = segmentFromScore(prep, thr);
      const rec = dbg ? { thr, seed: !!seed } : null;
      if (dbg) dbg.attempts.push(rec);
      if (!seed) return null;
      if (dbg && index === 0) { dbg.seed = seed; dbg.seg = seg; }

      // ---- 3b. boundary-contrast line search (wide, then precise) ----
      const seedMid = seed.quad.map(([x, y]) => [x * kMid, y * kMid]);
      const passA = contrastRefine(lab, seedMid, Math.round((live ? 0.08 : 0.10) * M), {
        outermost: true,
        stripStart: Math.max(2, Math.round(0.00375 * M)),
        stripLen: live ? 5 : 8,
        outReach: Math.round((live ? 0.08 : 0.10) * M),
        narrowMin: opts.narrowMin,
        samples: live ? 36 : 70
      });
      const passB = live
        ? passA // camera loop: skip the precise pass, a per-frame overlay doesn't need it
        : contrastRefine(lab, passA.quad, Math.max(3, Math.round(0.006 * M)), {
            localOnly: true,
            stripStart: 2,
            stripLen: 3
          });

      // refined quad must be sane, convex and similar in size to the seed
      const seedArea = polyArea(seedMid);
      const bArea = polyArea(passB.quad);
      const usedContrast =
        quadIsUsable(passB.quad, mid.w, mid.h) && bArea > 0.4 * seedArea && bArea < 3 * seedArea;
      const quadMid = usedContrast ? passB.quad : seedMid;

      // boundary evidence: mean of the two weakest sides (wide-strip scores)
      const ss = passA.sideScores.slice().sort((x, y) => x - y);
      const weak = (ss[0] + ss[1]) / 2;
      const support = usedContrast ? Math.min(1, weak / 6) : 0;
      if (rec) Object.assign(rec, { usedContrast, sideScores: passA.sideScores, support });

      // permissive attempts must show real boundary evidence on ALL sides
      if (index > 0 && (!usedContrast || ss[0] < 2.5 || support < 0.5)) return null;

      let quadSrc = quadMid.map(([x, y]) => [x / mid.s, y / mid.s]);

      // ---- 4. Texloom PCA polish at high resolution (small reach) ----
      let polished = false;
      if (refineSide > 0) {
        const hi = getHiGray();
        if (hi) {
          const reach = Math.max(4, Math.round(0.0175 * Math.max(hi.w, hi.h)));
          const start = quadSrc.map(([x, y]) => [x * hi.s, y * hi.s]);
          const r = refineCorners(hi.gs, hi.w, hi.h, start, reach);
          if (r.snapped >= 2 && quadIsUsable(r.quad, hi.w, hi.h)) {
            quadSrc = r.quad.map(([x, y]) => [x / hi.s, y / hi.s]);
            polished = true;
          }
        }
      }
      if (!quadIsUsable(quadSrc, srcW, srcH)) return null;

      // ---- 5. does the "document" differ from its surroundings? ----
      // The colour-histogram test only vetoes when boundary evidence is weak:
      // white paper on a pale sheet has near-identical coarse colour histograms
      // yet a perfectly clear edge.
      const chk = live ? null : scaled(512);
      if (chk) {
        const qs = quadSrc.map(([x, y]) => [x * chk.s, y * chk.s]);
        const ov = insideOutsideOverlap(chk.data, chk.w, chk.h, qs);
        if (rec) rec.overlap = ov;
        if (ov !== null && ov > (opts.overlapMax === undefined ? 0.6 : opts.overlapMax) && support < 0.7) return null;
      }

      // ---- confidence ----
      const q = quadSrc;
      const d = (p1, p2) => Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const top = d(q[0], q[1]), bot = d(q[3], q[2]);
      const lef = d(q[0], q[3]), rig = d(q[1], q[2]);
      const areaFrac = polyArea(q) / (srcW * srcH);
      const sizeScore = Math.min(1, areaFrac / 0.12);
      const shapeScore = (Math.min(top, bot) / Math.max(top, bot)) * (Math.min(lef, rig) / Math.max(lef, rig));
      const supportScore = usedContrast ? support : 0.35;
      const confidence = Math.max(0, Math.min(1, sizeScore * (0.3 + 0.7 * supportScore) * Math.sqrt(shapeScore)));

      if (dbg) Object.assign(dbg, { passA, passB, usedContrast, attemptUsed: index, thresholdUsed: thr });
      return {
        quad: q.map(([x, y]) => ({ x, y })),
        confidence,
        w: srcW,
        h: srcH,
        refined: usedContrast,
        polished,
        threshold: thr,
        debug: dbg
      };
    };

    for (let i = 0; i < ladder.length; i++) {
      const r = attempt(ladder[i], i);
      if (r) return r;
    }

    // ---- Stage 3 Fallback: Texloom 3x3 Sobel radial detector c(t) ----
    if (!live) {
      const fb = scaled(256);
      if (fb) {
        const fw = fb.w, fh = fb.h;
        const g = new Float32Array(fw * fh);
        for (let i = 0; i < g.length; i++) {
          g[i] = 0.299 * fb.data[4 * i] + 0.587 * fb.data[4 * i + 1] + 0.114 * fb.data[4 * i + 2];
        }
        const grad = new Float32Array(fw * fh);
        let maxGrad = 0;
        for (let y = 1; y < fh - 1; y++) {
          for (let x = 1; x < fw - 1; x++) {
            const idx = y * fw + x;
            const a = g[idx - fw - 1], n = g[idx - fw], i = g[idx - fw + 1];
            const l = g[idx - 1], s = g[idx + 1];
            const u = g[idx + fw - 1], f = g[idx + fw], gg = g[idx + fw + 1];
            const dx = -a - 2 * l - u + i + 2 * s + gg;
            const dy = -a - 2 * n - i + u + 2 * f + gg;
            const mag = Math.hypot(dx, dy);
            grad[idx] = mag;
            if (mag > maxGrad) maxGrad = mag;
          }
        }
        if (maxGrad >= 0.001) {
          const gThr = 0.18 * maxGrad;
          let pCount = 0;
          let minSum = Infinity, maxSum = -Infinity, maxDiff = -Infinity, minDiff = Infinity;
          let ptTL = [0, 0], ptTR = [fw - 1, 0], ptBR = [fw - 1, fh - 1], ptBL = [0, fh - 1];
          for (let y = 1; y < fh - 1; y++) {
            for (let x = 1; x < fw - 1; x++) {
              if (grad[y * fw + x] < gThr) continue;
              pCount++;
              const sum = x + y, diff = x - y;
              if (sum < minSum) { minSum = sum; ptTL = [x, y]; }
              if (sum > maxSum) { maxSum = sum; ptBR = [x, y]; }
              if (diff > maxDiff) { maxDiff = diff; ptTR = [x, y]; }
              if (diff < minDiff) { minDiff = diff; ptBL = [x, y]; }
            }
          }
          const frac = pCount / ((fw - 2) * (fh - 2));
          const candQuad = [ptTL, ptTR, ptBR, ptBL].map(([x, y]) => [x / fb.s, y / fb.s]);
          const candArea = polyArea(candQuad);
          if (frac >= 0.005 && frac <= 0.92 && candArea < 0.82 * srcW * srcH && quadIsUsable(candQuad, srcW, srcH)) {
            const chk = scaled(512);
            if (chk) {
              const qs = candQuad.map(([x, y]) => [x * chk.s, y * chk.s]);
              const ov = insideOutsideOverlap(chk.data, chk.w, chk.h, qs);
              if (ov !== null && ov > 0.55) return miss();
            }
            let polishedQuad = candQuad;
            if (refineSide > 0) {
              const hi = getHiGray();
              if (hi) {
                const reach = Math.max(4, Math.round(0.0175 * Math.max(hi.w, hi.h)));
                const start = candQuad.map(([x, y]) => [x * hi.s, y * hi.s]);
                const r = refineCorners(hi.gs, hi.w, hi.h, start, reach);
                if (r.snapped >= 2 && quadIsUsable(r.quad, hi.w, hi.h)) {
                  polishedQuad = r.quad.map(([x, y]) => [x / hi.s, y / hi.s]);
                }
              }
            }
            return {
              quad: polishedQuad.map(([x, y]) => ({ x, y })),
              confidence: 0.65,
              w: srcW,
              h: srcH,
              refined: true,
              polished: true,
              fallback: "sobel",
              debug: dbg
            };
          }
        }
      }
    }

    return miss();
  }

  // ------------------------------------------------------------------
  // Browser wrapper: <video> | <canvas> | <img> | ImageBitmap
  //   opts.live = true -> cheaper settings for per-frame video use
  // ------------------------------------------------------------------
  function detect(source, opts) {
    opts = Object.assign({}, opts);
    if (opts.live) {
      opts.maxSide = opts.maxSide || 192;
      opts.contrastSide = opts.contrastSide || 320;
      opts.paletteSize = opts.paletteSize || 32;
      if (opts.refineSide === undefined) opts.refineSide = 0; // no hi-res polish per frame
      if (!opts.thresholds) opts.thresholds = [1.6];
    }
    const srcW = source.videoWidth || source.naturalWidth || source.width || 320;
    const srcH = source.videoHeight || source.naturalHeight || source.height || 240;
    if (srcW < 16 || srcH < 16) return { quad: null, confidence: 0, w: srcW, h: srcH };

    const cache = {};
    function getScaled(maxSide) {
      const s = Math.min(1, maxSide / Math.max(srcW, srcH));
      const key = s.toFixed(5);
      if (cache[key]) return cache[key];
      const cw = Math.max(2, Math.round(srcW * s));
      const ch = Math.max(2, Math.round(srcH * s));
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      try {
        ctx.drawImage(source, 0, 0, cw, ch);
        const id = ctx.getImageData(0, 0, cw, ch);
        return (cache[key] = { data: id.data, w: cw, h: ch, s });
      } catch (e) {
        return null;
      }
    }

    try {
      const res = detectCore(getScaled, srcW, srcH, opts);
      delete res.debug;
      return res;
    } catch (e) {
      return { quad: null, confidence: 0, w: srcW, h: srcH };
    }
  }

  // Kept for tests / external callers.
  function toGrayscale(imageData) {
    const d = imageData.data;
    const n = d.length;
    const out = new Uint8ClampedArray(n / 4);
    for (let i = 0, j = 0; i < n; i += 4, j++) {
      out[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 + 500) / 1000 | 0; // Rec. 601
    }
    return out;
  }

  const api = {
    detect,
    detectCore,
    segmentSeed,
    convexHull,
    minAreaRect,
    orderQuad,
    segmentPrepare,
    segmentFromScore,
    refineCorners,
    contrastRefine,
    makeLabPlanes,
    robustLine,
    pcaLine,
    boxBlur,
    morph,
    largestBlob,
    rgbToLab,
    toGrayscale,
    polyArea,
    isConvex,
    quadIsUsable,
    insideOutsideOverlap
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.EdgeDetect = api;
})(typeof window !== "undefined" ? window : globalThis);
