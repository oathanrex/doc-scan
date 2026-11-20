/**
 * Texloom Studio: Decompiled Sub-Pixel Corner Refinement & PCA Line Intersection
 * Extracted from chunk 0dgcsmu4_bgr0.js (Module 545544 / c(t))
 * 
 * Replaces crude bounding boxes with sub-pixel gradient normal sweeping,
 * PCA linear regression, and 4-line analytic intersections.
 */

// Fit line a*x + b*y + c = 0 to 2D points using Principal Component Analysis
function fitLinePCA(points) {
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

  // Smallest eigenvector gives the line normal (a, b)
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const a = -Math.sin(theta);
  const b = Math.cos(theta);
  const c = -(a * mx + b * my);
  return { a, b, c };
}

// Compute analytic intersection point between line1 and line2
function intersectLines(l1, l2) {
  if (!l1 || !l2) return null;
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-6) return null; // Lines are parallel
  const x = (l1.b * l2.c - l2.b * l1.c) / det;
  const y = (l2.a * l1.c - l1.a * l2.c) / det;
  return { x, y };
}

/**
 * Sweep perpendicular normal vectors to locate true edge gradient peaks,
 * fit 4 lines via PCA, and compute the 4 analytic corner intersections.
 */
function refineQuadWithEdgeGradients(initialQuad, gray, width, height) {
  if (!initialQuad || initialQuad.length !== 4) return initialQuad;
  const lines = [];

  for (let i = 0; i < 4; i++) {
    const p1 = initialQuad[i];
    const p2 = initialQuad[(i + 1) % 4];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 12) return initialQuad;

    // Unit normal vector perpendicular to edge segment
    const nx = -dy / len;
    const ny = dx / len;

    const edgePoints = [];
    const numSamples = 24;

    for (let s = 1; s < numSamples; s++) {
      const t = s / numSamples;
      const bx = p1.x + t * dx;
      const by = p1.y + t * dy;

      let maxGrad = -1;
      let bestOffset = 0;

      // Scan +/- 10px perpendicular to edge
      for (let d = -10; d <= 10; d++) {
        const sx = Math.round(bx + d * nx);
        const sy = Math.round(by + d * ny);
        if (sx >= 1 && sx < width - 1 && sy >= 1 && sy < height - 1) {
          const gx = gray[sy * width + sx + 1] - gray[sy * width + sx - 1];
          const gy = gray[(sy + 1) * width + sx] - gray[(sy - 1) * width + sx];
          const grad = Math.abs(gx * nx + gy * ny);
          if (grad > maxGrad) {
            maxGrad = grad;
            bestOffset = d;
          }
        }
      }

      if (maxGrad > 12) {
        edgePoints.push({ x: bx + bestOffset * nx, y: by + bestOffset * ny });
      }
    }

    const fittedLine = fitLinePCA(edgePoints);
    if (!fittedLine) return initialQuad;
    lines.push(fittedLine);
  }

  // Intersect adjacent boundary lines: (L3, L0), (L0, L1), (L1, L2), (L2, L3)
  const q0 = intersectLines(lines[3], lines[0]);
  const q1 = intersectLines(lines[0], lines[1]);
  const q2 = intersectLines(lines[1], lines[2]);
  const q3 = intersectLines(lines[2], lines[3]);

  if (!q0 || !q1 || !q2 || !q3) return initialQuad;

  const refined = [q0, q1, q2, q3];
  for (let i = 0; i < 4; i++) {
    const p = refined[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return initialQuad;
    if (p.x < -width * 0.1 || p.x > width * 1.1 || p.y < -height * 0.1 || p.y > height * 1.1) return initialQuad;
  }

  return refined.map(p => ({
    x: Math.max(0, Math.min(width, Math.round(p.x))),
    y: Math.max(0, Math.min(height, Math.round(p.y)))
  }));
}

module.exports = {
  fitLinePCA,
  intersectLines,
  refineQuadWithEdgeGradients
};
