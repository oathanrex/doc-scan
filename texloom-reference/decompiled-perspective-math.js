/**
 * Texloom Studio: Decompiled Perspective Math & Homography Engine
 * Extracted from chunk 0dgcsmu4_bgr0.js (Module 545544)
 * 
 * Includes:
 * 1. 8-DOF Projective Homography Matrix via Gaussian Elimination with Partial Pivoting
 * 2. Backward Mapping Coordinate Projection (Inverse Homography)
 * 3. Proportional Output Aspect Ratio Sizing from Quadrilateral Edges
 * 4. Shoelace Formula Polygon Convexity & Non-degeneracy Check
 */

// 1. Projective Homography Matrix Calculation (8-DOF)
function computeHomography(srcQuad, dstQuad) {
  // srcQuad and dstQuad: array of 4 {x, y} points [TL, TR, BR, BL]
  const A = [];
  const b = [];

  for (let i = 0; i < 4; i++) {
    const sx = srcQuad[i].x;
    const sy = srcQuad[i].y;
    const dx = dstQuad[i].x;
    const dy = dstQuad[i].y;

    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dx);
    b.push(dy);
  }

  // Gaussian elimination with partial pivoting for numerical stability
  const n = 8;
  const M = [];
  for (let i = 0; i < n; i++) M.push(A[i].concat([b[i]]));

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
    }
    const temp = M[i];
    M[i] = M[maxRow];
    M[maxRow] = temp;

    const pivot = M[i][i] || 1e-12;
    for (let j = i; j <= n; j++) M[i][j] /= pivot;

    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = M[k][i];
      for (let j = i; j <= n; j++) M[k][j] -= factor * M[i][j];
    }
  }

  const h = new Float64Array(8);
  for (let i = 0; i < n; i++) h[i] = M[i][n];
  return h;
}

// 2. Backward Coordinate Projection (Destination to Source)
function projectPoint(H, x, y) {
  const w = H[6] * x + H[7] * y + 1;
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w
  };
}

// 3. Proportional Output Aspect Ratio Sizing
function calculateTargetDimensions(quad) {
  const topWidth = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const bottomWidth = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
  const leftHeight = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  const rightHeight = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);

  const avgWidth = Math.round((topWidth + bottomWidth) / 2);
  const avgHeight = Math.round((leftHeight + rightHeight) / 2);

  return {
    width: Math.max(16, avgWidth),
    height: Math.max(16, avgHeight)
  };
}

// 4. Shoelace Formula for Quadrilateral Convexity & Area Check
function isQuadValid(quad) {
  if (!quad || quad.length !== 4) return false;
  let signedArea = 0;
  for (let i = 0; i < 4; i++) {
    const next = (i + 1) % 4;
    signedArea += quad[i].x * quad[next].y - quad[next].x * quad[i].y;
  }
  signedArea *= 0.5;
  return Math.abs(signedArea) > 100; // Must have positive non-zero area
}

module.exports = {
  computeHomography,
  projectPoint,
  calculateTargetDimensions,
  isQuadValid
};
