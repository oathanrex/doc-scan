# Texloom Studio Reverse-Engineering Reference Archive

This directory contains the original JavaScript chunk bundles and decompiled, readable algorithmic modules extracted from **Texloom Studio** (`https://texloom.studio/free-tools/flatten-deskew`).

---

## 1. Decompiled Core Algorithm Modules

| File | Module ID | Description |
| :--- | :--- | :--- |
| **`decompiled-perspective-math.js`** | Module 545544 | 8-DOF Projective Homography Matrix, Backward Mapping, Gaussian Elimination with Partial Pivoting, and Proportional Aspect Ratio Sizing |
| **`decompiled-catmull-rom-bicubic.js`** | Module 289816 | 16-Tap Catmull-Rom Bicubic Spline Resampling Kernel for razor-sharp micro-typography and line preservation |
| **`decompiled-corner-detection.js`** | Module 545544 / `c(t)` | Sub-pixel Gradient Normal Sweeping, PCA Linear Regression Line Fitting, and 4-Line Analytic Intersections |

---

## 2. Downloaded Raw Turbopack Chunk Bundles (26 Total)

- **`page.html`** (113 KB): Full server-rendered HTML page with React component hydration payloads and SVG overlay structure.
- **`0dgcsmu4_bgr0.js`** (33 KB): Core Computer Vision, Catmull-Rom Bicubic Resampling, and Homography Transform Engine.
- **`1ve-r37cm9fx2.js`** (40 KB): Interactive Canvas Editor, Drag Handles, Pointer Capture, and Zoom/Pan widget.
- **`0d51ls1q82pt7.js`** (44 KB): Dropzone, file validation, and format constraints.
- **`0cz1d0mv5g_q7.js`** (112 KB): Turbopack component runtime and React framework chunk.
- **`0g816j3rmwag8.js`** (146 KB): Shared state management and UI utilities.
- **`3i85a93oh8qln.js`** (233 KB): Vendor bundle and React-DOM runtime.
- **`198evho4xwjs2.js`** (159 KB): Next.js router and navigation framework.
- Remaining chunks: `turbopack-077hmtqrhcoji.js`, `221puhk557d_f.js`, `05srjpfunfmcp.js`, `2gf4ma8lfv9xd.js`, `20n_drg1zb0_1.js`, `0rqzh40-rwrht.js`, `1rollqli8wkjx.js`, `3mg1r1vcte3ir.js`, `0ihq33abitdks.js`, `05i0wb-l9x_61.js`, `3hr7jzdx7_rv1.js`, `1byn5e-ytxmbl.js`, `3d5fjsyz1j2dg.js`, `0yh0b364_wrmm.js`, `325-o55e6optm.js`, `1jr6mqqlo1xuu.js`, `3lviwi-4mpl8-.js`, `19-wy2i0e0tzt.js`, `3_l5d1k0ibkae.js`.

---

## 3. How These Algorithms Were Integrated into DocScan

1. **`js/perspective.js`**:
   - Replaced basic bilinear interpolation with the 16-tap Catmull-Rom cubic spline polynomial.
   - Text on documents, receipts, contracts, and ID cards remains razor-sharp without blur.
2. **`js/edge-detect.js`**:
   - Added PCA line fitting (`fitLine`) and analytic line intersections (`lineIntersect`) inside `refineQuadWithGradients`.
   - Corners now snap to exact physical document boundaries even on textured bedsheets or shadows.
3. **`index.html` & `js/app.js`**:
   - Added Rule-of-Thirds Dynamic Alignment Grid inside SVG overlay (`#cropGridH1`, `#cropGridH2`, etc.).
   - Integrated 320ms Cubic Ease-Out Corner Snapping Animation (`animateQuadTo`).
   - Added Keyboard Micro-Nudge (Arrow keys for 1px, Shift+Arrow for 5px).
