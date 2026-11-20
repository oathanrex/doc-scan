// app.js
// Top-level application controller for DocScan. Wires together:
// - Camera lifecycle (getUserMedia)
// - Real-time edge detection loop (EdgeDetect)
// - Capture, perspective correction, multi-page session
// - Review, reorder, retake, delete
// - Filter / edit (V1.1 enhancement filters)
// - PDF export (PdfExport)
//
// Designed to match the PRD's primary user flow:
// Home -> Camera -> [Auto-detect -> Capture -> loop] -> Review -> Export

(function () {
 "use strict";

 // ---- Global error visibility ----
 // If anything throws during init, surface it in a banner so the user
 // isn't left staring at a screen that does nothing.
 function showFatal(msg) {
 let el = document.getElementById("__fatal");
 if (!el) {
 el = document.createElement("div");
 el.id = "__fatal";
 el.style.cssText =
 "position:fixed;left:12px;right:12px;top:12px;max-width:456px;margin:0 auto;" +
 "background:#3a1010;color:#ffd5d5;border:1px solid #ff6b6b;border-left-width:3px;" +
 "padding:12px 14px;border-radius:6px;font:13px/1.4 ui-monospace,monospace;z-index:9999;" +
 "white-space:pre-wrap;max-height:60vh;overflow:auto;";
 document.body.appendChild(el);
 }
 el.textContent = "Error: " + msg + "\n" + (el.textContent || "");
 }
 window.addEventListener("error", function (e) {
 showFatal((e.error && e.error.stack) || e.message);
 });
 window.addEventListener("unhandledrejection", function (e) {
 showFatal((e.reason && e.reason.stack) || String(e.reason));
 });

 // ---- State ----
 const state = {
 pages: [], // { id, src, straightened, original, raw, filter, quad }
 editingId: null,
 docTitle: "DocScan-" + new Date().toISOString().slice(0, 10),
 cam: {
 stream: null,
 tracking: false,
 locked: false,
 quad: null,
 lastDetect: 0,
 manual: false
 }
 };

 // ---- Crop / Perspective State (PerspectiveFix Parity) ----
 const cropState = {
    sourceCanvas: null,
    sourceQuad: null,
    displayQuad: null,
    editingPageId: null,
    dispW: 0,
    dispH: 0
  };

 // ---- DOM ----
 const $ = (id) => document.getElementById(id);
 const screens = {
 home: $("screen-home"),
 camera: $("screen-camera"),
 crop: $("screen-crop"),
 review: $("screen-review"),
 edit: $("screen-edit")
 };
 const els = {
 video: $("camVideo"),
 fallback: $("camFallback"),
 status: $("camStatus"),
 statusText: $("camStatusText"),
 overlay: $("detectionOverlay"),
 poly: $("detectionPoly"),
 shutter: $("shutterBtn"),
 closeCam: $("closeCamBtn"),
 camHomeBtn: $("camHomeBtn"),
 camCloseTopBtn: $("camCloseTopBtn"),
 finishBtn: $("finishBtn"),
 manualBtn: $("manualBtn"),
 flashBtn: $("flashBtn"),
    flipCamBtn: $("flipCamBtn"),
 thumbStrip: $("thumbStrip"),
 startScan: $("startScanBtn"),
 importBtn: $("importBtn"),
 fileInput: $("fileInput"),
 fallbackImportBtn: $("fallbackImportBtn"),
 fallbackHomeBtn: $("fallbackHomeBtn"),
 demoBtn: $("demoBtn"),
 resumeBtn: $("resumeBtn"),
 resumeCount: $("resumeCount"),
 themeToggleBtn: $("themeToggleBtn"),
 themeIcon: $("themeIcon"),
 homeStatus: $("homeStatus"),
 clearCacheBtn: $("clearCacheBtn"),
 bootDiag: $("bootDiag"),
 reviewList: $("reviewList"),
 reviewMeta: $("reviewMeta"),
 reviewBack: $("reviewBackBtn"),
 docTitleBtn: $("docTitleBtn"),
 docTitleText: $("docTitleText"),
 addMoreBtn: $("addMoreBtn"),
 exportBtn: $("exportBtn"),
    pdfFormatSelect: $("pdfFormatSelect"),
 editStage: $("editStage"),
 editTitle: $("editTitle"),
 editBack: $("editBackBtn"),
 editRotateBtn: $("editRotateBtn"),
 filters: $("filters"),
 retakeBtn: $("retakeBtn"),
 applyBtn: $("applyBtn"),
 // Crop screen elements
 cropBack: $("cropBackBtn"),
 cropRotateBtn: $("cropRotateBtn"),
 cropApplyTop: $("cropApplyTopBtn"),
 cropApplyBtn: $("cropApplyBtn"),
 cropAutoBtn: $("cropAutoBtn"),
 cropResetBtn: $("cropResetBtn"),
 cropStage: $("cropStage"),
 cropCanvasWrapper: $("cropCanvasWrapper"),
 cropCanvas: $("cropCanvas"),
 cropPoly: $("cropPoly"),
 cropOverlay: $("cropOverlay"),
 cropHandleTL: $("cropHandleTL"),
 cropHandleTR: $("cropHandleTR"),
 cropHandleBR: $("cropHandleBR"),
 cropHandleBL: $("cropHandleBL"),
 cropLoupe: $("cropLoupe"),
 cropLoupeCanvas: $("cropLoupeCanvas"),
 cropInfo: $("cropInfo"),
 toast: $("toast"),
 toastText: $("toastText"),
 toastIco: $("toastIco"),
 modal: $("modal"),
 modalTitle: $("modalTitle"),
 modalBody: $("modalBody"),
 modalOk: $("modalOk"),
 aboutBtn: $("aboutBtn")
 };

 // ---- Image Rotation Helpers (Top 1% Orientation Control) ----
 function rotateImageDataUrl(dataUrl, angleDeg = 90) {
 return new Promise((resolve, reject) => {
 const img = new Image();
 img.onload = () => {
 const c = document.createElement("canvas");
 if (angleDeg === 90 || angleDeg === 270) {
 c.width = img.naturalHeight;
 c.height = img.naturalWidth;
 } else {
 c.width = img.naturalWidth;
 c.height = img.naturalHeight;
 }
 const ctx = c.getContext("2d");
 ctx.translate(c.width / 2, c.height / 2);
 ctx.rotate((angleDeg * Math.PI) / 180);
 ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
 resolve(c.toDataURL("image/jpeg", 0.92));
 };
 img.onerror = reject;
 img.src = dataUrl;
 });
 }

 function rotateCanvas(canvas, angleDeg = 90) {
 const c = document.createElement("canvas");
 if (angleDeg === 90 || angleDeg === 270) {
 c.width = canvas.height;
 c.height = canvas.width;
 } else {
 c.width = canvas.width;
 c.height = canvas.height;
 }
 const ctx = c.getContext("2d");
 ctx.translate(c.width / 2, c.height / 2);
 ctx.rotate((angleDeg * Math.PI) / 180);
 ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
 return c;
 }

 // ---- Theme Toggle (Dark / Light) ----
 function initTheme() {
 const saved = localStorage.getItem("docscan_theme");
 if (saved === "light") {
 document.body.classList.add("light-theme");
 document.body.classList.remove("dark-theme");
 } else if (saved === "dark") {
 document.body.classList.add("dark-theme");
 document.body.classList.remove("light-theme");
 }
 }
 initTheme();

 if (els.themeToggleBtn) {
 els.themeToggleBtn.addEventListener("click", () => {
 const isLight = document.body.classList.contains("light-theme");
 if (isLight) {
 document.body.classList.remove("light-theme");
 document.body.classList.add("dark-theme");
 localStorage.setItem("docscan_theme", "dark");
 toast("Switched to dark theme", "info");
 } else {
 document.body.classList.remove("dark-theme");
 document.body.classList.add("light-theme");
 localStorage.setItem("docscan_theme", "light");
 toast("Switched to light theme", "info");
 }
 });
 }

 // ---- Document Title Renaming ----
 if (els.docTitleBtn) {
 els.docTitleBtn.addEventListener("click", () => {
 const current = state.docTitle || "DocScan";
 const userTitle = prompt("Rename document:", current);
 if (userTitle && userTitle.trim()) {
 const clean = userTitle.trim().replace(/[/\\?%*:|"<>]/g, "-");
 state.docTitle = clean;
 if (els.docTitleText) els.docTitleText.textContent = clean;
 toast("Document title set to: " + clean, "info");
 }
 });
 }

 // ---- Screen navigation ----
 function showScreen(name) {
    state.currentScreen = name;
    const appEl = document.getElementById("app");
    if (appEl) {
      if (name === "home") {
        appEl.classList.remove("in-tool-mode");
      } else {
        appEl.classList.add("in-tool-mode");
      }
    }
    Object.entries(screens).forEach(([k, el]) => {
      if (el) el.classList.toggle("active", k === name);
    });
 if (name !== "camera") stopCamera();
 if (name === "home") updateHomeSessionBtn();
 if (name === "review") renderReview();
 if (name === "edit") renderEdit();
 if (name === "crop") setupCropView();
 }

 function updateHomeSessionBtn() {
 if (els.resumeBtn && els.resumeCount) {
 if (state.pages && state.pages.length > 0) {
 els.resumeCount.textContent = state.pages.length;
 els.resumeBtn.style.display = "inline-flex";
 } else {
 els.resumeBtn.style.display = "none";
 }
 }
 }

 // ---- Toast ----
 let toastTimer = null;
 function toast(msg, kind) {
 els.toastText.textContent = msg;
 els.toast.className = "toast show" + (kind ? " " + kind : "");
 clearTimeout(toastTimer);
 toastTimer = setTimeout(() => {
 els.toast.classList.remove("show");
 }, 2200);
 }

 // ---- Modal ----
 function showModal(title, body) {
 els.modalTitle.textContent = title;
 if (typeof body === "string" && (body.includes("<") || body.includes("&"))) {
 els.modalBody.innerHTML = body;
 } else {
 els.modalBody.textContent = body;
 }
 els.modal.classList.add("show");
 }
 els.modalOk.addEventListener("click", () => els.modal.classList.remove("show"));
 els.modal.addEventListener("click", (e) => {
 if (e.target === els.modal) els.modal.classList.remove("show");
 });

 // ---- Camera ----
 async function startCamera() {
 if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
 showFallback("Camera API not available in this browser.");
 return;
 }
 try {
 const stream = await navigator.mediaDevices.getUserMedia({
 video: {
 facingMode: { ideal: "environment" },
 width: { ideal: 1920 },
 height: { ideal: 1080 }
 },
 audio: false
 });
 state.cam.stream = stream;
 els.video.srcObject = stream;
 await els.video.play().catch(() => {});
 els.fallback.style.display = "none";
 startDetectionLoop();
 } catch (err) {
 showFallback("Camera access denied or unavailable.");
 }
 }
 function showFallback(reason) {
 els.fallback.style.display = "flex";
 const p = els.fallback.querySelector("p");
 if (p) p.textContent = reason + " Use Import to load an image instead.";
 setStatus("Camera unavailable", false);
 }
 function stopCamera() {
 state.cam.tracking = false;
 if (state.cam.stream) {
 state.cam.stream.getTracks().forEach((t) => t.stop());
 state.cam.stream = null;
 }
 }
 function setStatus(text, locked) {
 els.statusText.textContent = text;
 els.status.classList.toggle("locked", !!locked);
 }

 // ---- Detection loop ----
 function startDetectionLoop() {
 state.cam.tracking = true;
 state.cam.locked = false;
 state.cam.quad = null;
 setStatus("Searching for document…", false);
 detectFrame();
 }
 function detectFrame() {
 if (!state.cam.tracking) return;
 const video = els.video;
 if (video.readyState >= 2) {
 const t0 = performance.now();
 const result = EdgeDetect.detect(video);
 state.cam.lastDetect = performance.now() - t0;
 if (result.quad && result.confidence > 0.4) {
 state.cam.quad = result.quad;
 state.cam.locked = true;
 // Scale quad from detection downscale to the displayed video
 // area on screen.
 drawQuadOnOverlay(result.quad, result.w, result.h);
 setStatus("Locked on document", true);
 els.shutter.disabled = false;
 } else {
 state.cam.locked = false;
 if (!state.cam.manual) {
 hideQuad();
 setStatus("Searching for document…", false);
 }
 els.shutter.disabled = !state.cam.manual;
 }
 }
 requestAnimationFrame(detectFrame);
 }

 // The video fills the cam-stage. Map detection coordinates
 // (result.w x result.h) to pixel coordinates on the stage, preserving
 // the camera's aspect via object-fit:cover.
 function drawQuadOnOverlay(quad, dw, dh) {
 const stage = document.getElementById("camStage");
 const sr = stage.clientWidth / stage.clientHeight; // displayed
 const vr = dw / dh; // detection
 // object-fit:cover means the video is scaled by max(sr/vr, vr/sr)
 // and the smaller dimension is centered.
 let scale, offX, offY, drawW, drawH;
 if (vr > sr) {
 // video wider than stage => height matches, width clipped
 drawH = stage.clientHeight;
 drawW = drawH * vr;
 scale = drawH / dh;
 offX = (stage.clientWidth - drawW) / 2;
 offY = 0;
 } else {
 drawW = stage.clientWidth;
 drawH = drawW / vr;
 scale = drawW / dw;
 offX = 0;
 offY = (stage.clientHeight - drawH) / 2;
 }

 const pts = quad.map((p) => {
 const x = offX + p.x * scale;
 const y = offY + p.y * scale;
 return { x, y };
 });
 state.cam.displayQuad = pts;
 renderQuad(pts);
 }
 function renderQuad(pts) {
 const poly = els.poly;
 const stage = document.getElementById("camStage");
 poly.setAttribute("viewBox", `0 0 ${stage.clientWidth} ${stage.clientHeight}`);
 poly.setAttribute("preserveAspectRatio", "none");
 const polyEl = poly.querySelector("polygon");
 polyEl.setAttribute(
 "points",
 pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
 );
 poly.style.display = "";
 els.overlay.querySelectorAll(".corner").forEach((c, i) => {
 c.style.display = "";
 c.style.left = pts[i].x + "px";
 c.style.top = pts[i].y + "px";
 });
 }
 function hideQuad() {
 els.poly.style.display = "none";
 els.overlay.querySelectorAll(".corner").forEach((c) => (c.style.display = "none"));
 }

 // ---- Corner dragging (manual mode) ----
 const loupeEl = document.getElementById("cornerLoupe");
 const loupeCanvas = document.getElementById("loupeCanvas");
 const loupeCtx = loupeCanvas ? loupeCanvas.getContext("2d") : null;

 function updateLoupe(pt) {
 if (!loupeEl || !loupeCtx) return;
 const stage = document.getElementById("camStage");
 if (!stage) return;
 loupeEl.style.display = "block";
 loupeEl.style.left = pt.x + "px";
 loupeEl.style.top = Math.max(65, pt.y - 25) + "px";

 const video = els.video;
 if (!video || !video.videoWidth) return;

 const rect = stage.getBoundingClientRect();
 const rx = (pt.x / rect.width) * video.videoWidth;
 const ry = (pt.y / rect.height) * video.videoHeight;

 const zoom = 2.4;
 const cropW = 110 / zoom;
 const cropH = 110 / zoom;
 const sx = Math.max(0, Math.min(video.videoWidth - cropW, rx - cropW / 2));
 const sy = Math.max(0, Math.min(video.videoHeight - cropH, ry - cropH / 2));

 loupeCtx.clearRect(0, 0, 110, 110);
 loupeCtx.drawImage(video, sx, sy, cropW, cropH, 0, 0, 110, 110);
 }

 function hideLoupe() {
 if (loupeEl) loupeEl.style.display = "none";
 }

 els.overlay.querySelectorAll(".corner").forEach((corner) => {
 let drag = null;
 const onDown = (e) => {
 if (!state.cam.manual) {
 // Tap-to-enable manual mode on the closest corner
 state.cam.manual = true;
 if (!state.cam.displayQuad) {
 const stage = document.getElementById("camStage");
 state.cam.displayQuad = [
 { x: stage.clientWidth * 0.15, y: stage.clientHeight * 0.15 },
 { x: stage.clientWidth * 0.85, y: stage.clientHeight * 0.15 },
 { x: stage.clientWidth * 0.85, y: stage.clientHeight * 0.85 },
 { x: stage.clientWidth * 0.15, y: stage.clientHeight * 0.85 }
 ];
 }
 }
 const pt = pointer(e);
 drag = { id: corner.dataset.corner, start: pt };
 updateLoupe(pt);
 e.preventDefault();
 };
 const onMove = (e) => {
 if (!drag) return;
 const pt = pointer(e);
 const i = ["tl", "tr", "br", "bl"].indexOf(drag.id);
 const stage = document.getElementById("camStage");
 const q = state.cam.displayQuad.slice();
 q[i] = {
 x: Math.max(0, Math.min(stage.clientWidth, pt.x)),
 y: Math.max(0, Math.min(stage.clientHeight, pt.y))
 };
 state.cam.displayQuad = q;
 renderQuad(q);
 updateLoupe(pt);
 setStatus("Adjusting corners", true);
 };
 const onUp = () => {
 drag = null;
 hideLoupe();
 };
 corner.addEventListener("pointerdown", onDown);
 window.addEventListener("pointermove", onMove);
 window.addEventListener("pointerup", onUp);
 });
 function pointer(e) {
 if (e.touches && e.touches[0]) {
 return { x: e.touches[0].clientX, y: e.touches[0].clientY };
 }
 return { x: e.clientX, y: e.clientY };
 }

 els.manualBtn.addEventListener("click", () => {
 state.cam.manual = !state.cam.manual;
 if (state.cam.manual) {
 const stage = document.getElementById("camStage");
 if (!state.cam.displayQuad) {
 state.cam.displayQuad = [
 { x: stage.clientWidth * 0.15, y: stage.clientHeight * 0.15 },
 { x: stage.clientWidth * 0.85, y: stage.clientHeight * 0.15 },
 { x: stage.clientWidth * 0.85, y: stage.clientHeight * 0.85 },
 { x: stage.clientWidth * 0.15, y: stage.clientHeight * 0.85 }
 ];
 }
 els.overlay.classList.add("locked");
 els.overlay.querySelectorAll(".corner").forEach((c) =>
 c.classList.add("manual")
 );
 renderQuad(state.cam.displayQuad);
 setStatus("Adjusting corners", true);
 } else {
 els.overlay.classList.remove("locked");
 els.overlay.querySelectorAll(".corner").forEach((c) =>
 c.classList.remove("manual")
 );
 if (state.cam.quad) drawQuadOnOverlay(state.cam.quad, state.cam.lastW || 240, state.cam.lastH || 180);
 }
 });

 // ---- Capture ----
 els.shutter.addEventListener("click", capturePage);
 els.closeCam.addEventListener("click", () => {
 if (state.pages.length === 0) {
 showScreen("home");
 } else {
 showScreen("review");
 }
 });
 if (els.camHomeBtn) {
 els.camHomeBtn.addEventListener("click", () => showScreen("home"));
 }
 if (els.fallbackHomeBtn) {
 els.fallbackHomeBtn.addEventListener("click", () => showScreen("home"));
 }
 if (els.camCloseTopBtn) {
 els.camCloseTopBtn.addEventListener("click", () => {
 if (state.pages.length === 0) {
 showScreen("home");
 } else {
 showScreen("review");
 }
 });
 }

 async function capturePage() {
 if (!state.cam.stream && els.video.readyState < 2) {
 toast("Camera not ready", "error");
 return;
 }
 // Snapshot the current video frame at native resolution into a canvas.
 const v = els.video;
 const w = v.videoWidth;
 const h = v.videoHeight;
 if (!w || !h) {
 toast("Camera not ready", "error");
 return;
 }
 const canvas = document.createElement("canvas");
 canvas.width = w;
 canvas.height = h;
 const ctx = canvas.getContext("2d");
 ctx.drawImage(v, 0, 0, w, h);

 // Compute the capture quad in source (full-resolution) coords.
 // We need to map the displayed quad back through the object-fit:cover
 // transform used for drawing the overlay.
 const stage = document.getElementById("camStage");
 const sr = stage.clientWidth / stage.clientHeight;
 const vr = w / h;
 let scale, offX, offY, drawW, drawH;
 if (vr > sr) {
 drawH = stage.clientHeight;
 drawW = drawH * vr;
 scale = drawH / h;
 offX = (stage.clientWidth - drawW) / 2;
 offY = 0;
 } else {
 drawW = stage.clientWidth;
 drawH = drawW / vr;
 scale = drawW / w;
 offX = 0;
 offY = (stage.clientHeight - drawH) / 2;
 }

 let sourceQuad = null;
 if (state.cam.displayQuad) {
 sourceQuad = state.cam.displayQuad.map((p) => ({
 x: (p.x - offX) / scale,
 y: (p.y - offY) / scale
 }));
 }

 const t0 = performance.now();
 const corrected = Perspective.correct(canvas, sourceQuad);
 const dt = performance.now() - t0;
 console.log("perspective correction", dt.toFixed(0), "ms");

 const page = {
 id: "p_" + Math.random().toString(36).slice(2, 8),
 src: corrected.toDataURL("image/jpeg", 0.9),
 straightened: corrected.toDataURL("image/jpeg", 0.9),
 filter: "original",
 original: corrected.toDataURL("image/jpeg", 0.9),
 raw: canvas.toDataURL("image/jpeg", 0.92),
 quad: sourceQuad
 };
 state.pages.push(page);
 renderThumbs();
 toast("Page captured", "success");
 // Briefly highlight the new thumb
 setTimeout(() => {
 const t = els.thumbStrip.querySelector(`[data-id="${page.id}"]`);
 if (t) t.scrollIntoView({ behavior: "smooth", block: "nearest" });
 }, 0);
 }

 function renderThumbs() {
 els.thumbStrip.innerHTML = "";
 state.pages.forEach((p, i) => {
 const t = document.createElement("div");
 t.className = "thumb";
 t.dataset.id = p.id;
 t.style.backgroundImage = `url(${p.src})`;
 const n = document.createElement("div");
 n.className = "num";
 n.textContent = i + 1;
 t.appendChild(n);
 els.thumbStrip.appendChild(t);
 });
 }

 // ---- Crop / Perspective View & Handlers (PerspectiveFix Parity) ----
 let activeCropDragIdx = null;

 async function openCropForPage(pageId) {
 const p = state.pages.find((x) => x.id === pageId);
 if (!p) return;
 try {
 const imgSrc = p.raw || p.original || p.src;
 const img = await loadImage(imgSrc);
 startCropWorkflow(img, { pageId: p.id, existingQuad: p.quad });
 } catch (err) {
 console.error(err);
 toast("Could not open page for cropping", "error");
 }
 }

 function startCropWorkflow(source, options = {}) {
 const sw = source.naturalWidth || source.videoWidth || source.width;
 const sh = source.naturalHeight || source.videoHeight || source.height;
 if (!sw || !sh) {
 toast("Invalid image dimensions", "error");
 return;
 }

 const sc = document.createElement("canvas");
 sc.width = sw;
 sc.height = sh;
 const sctx = sc.getContext("2d");
 sctx.drawImage(source, 0, 0, sw, sh);

 cropState.sourceCanvas = sc;
 cropState.editingPageId = options.pageId || null;

 let detectedQuad = options.existingQuad ? options.existingQuad.slice() : null;
 if (!detectedQuad) {
 // Run automatic edge detection
 try {
 const res = EdgeDetect.detect(sc);
 if (res && res.quad && res.confidence > 0.1) {
 const scaleX = sw / res.w;
 const scaleY = sh / res.h;
 detectedQuad = res.quad.map((p) => ({
 x: Math.max(0, Math.min(sw, Math.round(p.x * scaleX))),
 y: Math.max(0, Math.min(sh, Math.round(p.y * scaleY)))
 }));
 }
 } catch (err) {
 console.warn("Edge detection exception:", err);
 }
 }

 if (!detectedQuad) {
 // Default 6% inset quad
 detectedQuad = [
 { x: Math.round(sw * 0.06), y: Math.round(sh * 0.06) },
 { x: Math.round(sw * 0.94), y: Math.round(sh * 0.06) },
 { x: Math.round(sw * 0.94), y: Math.round(sh * 0.94) },
 { x: Math.round(sw * 0.06), y: Math.round(sh * 0.94) }
 ];
 if (els.cropInfo) {
 els.cropInfo.innerHTML = "<span>Drag corners to document edges or tap Auto Detect</span>";
 }
 } else {
 if (els.cropInfo) {
 els.cropInfo.innerHTML = '<span style="color:var(--accent);font-weight:600;">✓ Border detected</span> &bull; Fine-tune corners if needed';
 }
 if (!options.existingQuad) {
 toast("Document border auto-detected!", "success");
 }
 }

 cropState.sourceQuad = detectedQuad;
 showScreen("crop");
 setupCropView();
 }

 function fitCropCanvas() {
    if (!cropState.sourceCanvas || !els.cropCanvas || !els.cropStage) return;
    const sc = cropState.sourceCanvas;
    const cc = els.cropCanvas;
    const wrapper = els.cropCanvasWrapper;

    // Sync underlying pixel buffer
    if (cc.width !== sc.width || cc.height !== sc.height) {
      cc.width = sc.width;
      cc.height = sc.height;
      const ctx = cc.getContext("2d");
      ctx.drawImage(sc, 0, 0);
    }

    // Measure stage dimensions
    const stageRect = els.cropStage.getBoundingClientRect();
    if (stageRect.width <= 0 || stageRect.height <= 0) return;

    // Generous safe padding (40px horizontal, 44px vertical) so handles (32px diameter)
    // never clip against topbar, sides, or bottom toolbar
    const padX = 40;
    const padY = 44;
    const availW = Math.max(100, stageRect.width - padX);
    const availH = Math.max(100, stageRect.height - padY);

    // Compute aspect-ratio-preserving contain scale
    const scale = Math.min(availW / sc.width, availH / sc.height);
    const dispW = Math.max(1, Math.round(sc.width * scale));
    const dispH = Math.max(1, Math.round(sc.height * scale));

    cropState.dispW = dispW;
    cropState.dispH = dispH;

    // Explicitly apply display dimensions
    if (wrapper) {
      wrapper.style.width = dispW + "px";
      wrapper.style.height = dispH + "px";
    }
    cc.style.width = dispW + "px";
    cc.style.height = dispH + "px";

    syncCropDisplayQuad();
  }

  function setupCropView() {
    if (!cropState.sourceCanvas || !els.cropCanvas) return;
    const sc = cropState.sourceCanvas;
    const cc = els.cropCanvas;
    cc.width = sc.width;
    cc.height = sc.height;
    const ctx = cc.getContext("2d");
    ctx.drawImage(sc, 0, 0);

    requestAnimationFrame(() => {
      fitCropCanvas();
    });
  }

  function syncCropDisplayQuad() {
    if (!cropState.sourceCanvas || !cropState.sourceQuad || !els.cropCanvas) return;
    const sw = cropState.sourceCanvas.width;
    const sh = cropState.sourceCanvas.height;
    if (sw <= 0 || sh <= 0) return;

    const dispW = cropState.dispW || els.cropCanvas.clientWidth || 300;
    const dispH = cropState.dispH || els.cropCanvas.clientHeight || 400;

    cropState.displayQuad = cropState.sourceQuad.map((p) => ({
      x: Math.round((p.x / sw) * dispW),
      y: Math.round((p.y / sh) * dispH)
    }));

    renderCropOverlay();
  }

  function renderCropOverlay() {
    if (!cropState.displayQuad || !els.cropPoly) return;
    const pts = cropState.displayQuad;
    const pointsStr = pts.map((p) => `${p.x},${p.y}`).join(" ");
    els.cropPoly.setAttribute("points", pointsStr);

    const handles = [els.cropHandleTL, els.cropHandleTR, els.cropHandleBR, els.cropHandleBL];
    handles.forEach((h, i) => {
      if (h && pts[i]) {
        h.style.left = pts[i].x + "px";
        h.style.top = pts[i].y + "px";
      }
    });
  }

  function updateCropLoupe(idx, clientX, clientY) {
    if (!els.cropLoupe || !els.cropLoupeCanvas || !cropState.sourceCanvas) return;
    const stageRect = els.cropStage.getBoundingClientRect();
    let loupeX = clientX - stageRect.left;
    let loupeY = clientY - stageRect.top - 75;

    // Constrain loupe inside visible stage bounds
    loupeX = Math.max(55, Math.min(stageRect.width - 55, loupeX));
    if (loupeY < 55) {
      loupeY = clientY - stageRect.top + 75;
    }
    loupeY = Math.max(55, Math.min(stageRect.height - 55, loupeY));

    els.cropLoupe.style.display = "block";
    els.cropLoupe.style.left = loupeX + "px";
    els.cropLoupe.style.top = loupeY + "px";

    const pt = cropState.sourceQuad[idx];
    if (!pt) return;
    const sw = cropState.sourceCanvas.width;
    const sh = cropState.sourceCanvas.height;
    const lCtx = els.cropLoupeCanvas.getContext("2d");
    lCtx.clearRect(0, 0, 100, 100);

    const zoom = 2.5;
    const cropW = 100 / zoom;
    const cropH = 100 / zoom;
    const sx = Math.max(0, Math.min(sw - cropW, pt.x - cropW / 2));
    const sy = Math.max(0, Math.min(sh - cropH, pt.y - cropH / 2));

    lCtx.drawImage(cropState.sourceCanvas, sx, sy, cropW, cropH, 0, 0, 100, 100);

    // Render precision crosshair reticle
    lCtx.save();
    lCtx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    lCtx.lineWidth = 1.5;
    lCtx.beginPath();
    lCtx.moveTo(50, 30); lCtx.lineTo(50, 43);
    lCtx.moveTo(50, 57); lCtx.lineTo(50, 70);
    lCtx.moveTo(30, 50); lCtx.lineTo(43, 50);
    lCtx.moveTo(57, 50); lCtx.lineTo(70, 50);
    lCtx.stroke();

    lCtx.strokeStyle = "#2dd4bf";
    lCtx.lineWidth = 2;
    lCtx.beginPath();
    lCtx.arc(50, 50, 6, 0, Math.PI * 2);
    lCtx.stroke();
    lCtx.restore();
  }

  function applyCrop() {
    if (!cropState.sourceCanvas || !cropState.sourceQuad) return;
    try {
      const corrected = Perspective.correct(cropState.sourceCanvas, cropState.sourceQuad);
      const dataUrl = corrected.toDataURL("image/jpeg", 0.92);

      if (cropState.editingPageId) {
        const p = state.pages.find((x) => x.id === cropState.editingPageId);
        if (p) {
          p.src = dataUrl;
          p.straightened = dataUrl;
          p.original = dataUrl; // Keep in sync so edit never reverts to crooked
          p.filter = "original";
          p.quad = cropState.sourceQuad;
        }
        showScreen("review");
        toast("Page perspective straightened!", "success");
      } else {
        const page = {
          id: "p_" + Math.random().toString(36).slice(2, 8),
          src: dataUrl,
          straightened: dataUrl,
          filter: "original",
          original: dataUrl,
          raw: cropState.sourceCanvas.toDataURL("image/jpeg", 0.92),
          quad: cropState.sourceQuad
        };
        state.pages.push(page);
        showScreen("review");
        toast("Straightened & added to scan!", "success");
      }
      renderThumbs();
      saveSession();
      updateHomeSessionBtn();
    } catch (err) {
      console.error("Apply crop error:", err);
      toast("Error straightening page", "error");
    }
  }

  function initCropHandles() {
    const handles = [
      els.cropHandleTL,
      els.cropHandleTR,
      els.cropHandleBR,
      els.cropHandleBL
    ];

    let activePointerId = null;

    const onGlobalPointerMove = (e) => {
      if (activeCropDragIdx === null) return;
      e.preventDefault();

      const wrapper = els.cropCanvasWrapper;
      if (!wrapper || !cropState.sourceCanvas) return;
      const rect = wrapper.getBoundingClientRect();
      const dispW = cropState.dispW || rect.width;
      const dispH = cropState.dispH || rect.height;
      if (dispW <= 0 || dispH <= 0) return;

      const rawX = e.clientX - rect.left;
      const rawY = e.clientY - rect.top;
      const clampedX = Math.max(0, Math.min(dispW, rawX));
      const clampedY = Math.max(0, Math.min(dispH, rawY));

      cropState.displayQuad[activeCropDragIdx] = { x: clampedX, y: clampedY };
      const sw = cropState.sourceCanvas.width;
      const sh = cropState.sourceCanvas.height;
      cropState.sourceQuad[activeCropDragIdx] = {
        x: (clampedX / dispW) * sw,
        y: (clampedY / dispH) * sh
      };

      renderCropOverlay();
      updateCropLoupe(activeCropDragIdx, e.clientX, e.clientY);
    };

    const onGlobalPointerUp = (e) => {
      if (activeCropDragIdx !== null) {
        const h = handles[activeCropDragIdx];
        if (h) {
          h.classList.remove("active");
          try {
            if (activePointerId !== null && h.releasePointerCapture) {
              h.releasePointerCapture(activePointerId);
            }
          } catch (_) {}
        }
        activeCropDragIdx = null;
        activePointerId = null;
        if (els.cropLoupe) els.cropLoupe.style.display = "none";
        window.removeEventListener("pointermove", onGlobalPointerMove);
        window.removeEventListener("pointerup", onGlobalPointerUp);
        window.removeEventListener("pointercancel", onGlobalPointerUp);
      }
    };

    handles.forEach((h, idx) => {
      if (!h) return;

      h.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        activeCropDragIdx = idx;
        activePointerId = e.pointerId;
        h.classList.add("active");
        try {
          if (h.setPointerCapture) h.setPointerCapture(e.pointerId);
        } catch (_) {}

        window.addEventListener("pointermove", onGlobalPointerMove, { passive: false });
        window.addEventListener("pointerup", onGlobalPointerUp, { passive: false });
        window.addEventListener("pointercancel", onGlobalPointerUp, { passive: false });

        updateCropLoupe(idx, e.clientX, e.clientY);
      });
    });

    if (els.cropApplyBtn) els.cropApplyBtn.addEventListener("click", applyCrop);
    if (els.cropApplyTop) els.cropApplyTop.addEventListener("click", applyCrop);

    if (els.cropBack) {
      els.cropBack.addEventListener("click", () => {
        if (cropState.editingPageId || (state.pages && state.pages.length > 0)) {
          showScreen("review");
        } else {
          showScreen("home");
        }
      });
    }

    if (els.cropAutoBtn) {
      els.cropAutoBtn.addEventListener("click", () => {
        if (!cropState.sourceCanvas) return;
        try {
          const res = EdgeDetect.detect(cropState.sourceCanvas);
          if (res && res.quad && res.confidence > 0.1) {
            const sw = cropState.sourceCanvas.width;
            const sh = cropState.sourceCanvas.height;
            const scaleX = sw / res.w;
            const scaleY = sh / res.h;
            cropState.sourceQuad = res.quad.map((p) => ({
              x: Math.max(0, Math.min(sw, Math.round(p.x * scaleX))),
              y: Math.max(0, Math.min(sh, Math.round(p.y * scaleY)))
            }));
            syncCropDisplayQuad();
            if (els.cropInfo) {
              els.cropInfo.innerHTML = '<span style="color:var(--accent);font-weight:600;">✓ Border detected</span>';
            }
            toast("Border detected!", "success");
          } else {
            toast("No clear border found, adjust manually", "warn");
          }
        } catch (err) {
          console.warn(err);
          toast("Detection failed", "error");
        }
      });
    }

    if (els.cropResetBtn) {
      els.cropResetBtn.addEventListener("click", () => {
        if (!cropState.sourceCanvas) return;
        const sw = cropState.sourceCanvas.width;
        const sh = cropState.sourceCanvas.height;
        cropState.sourceQuad = [
          { x: 0, y: 0 },
          { x: sw, y: 0 },
          { x: sw, y: sh },
          { x: 0, y: sh }
        ];
        syncCropDisplayQuad();
        if (els.cropInfo) {
          els.cropInfo.innerHTML = "<span>Full page selected</span>";
        }
        toast("Reset to full image", "info");
      });
    }

    if (els.cropRotateBtn) {
      els.cropRotateBtn.addEventListener("click", () => {
        if (!cropState.sourceCanvas) return;
        cropState.sourceCanvas = rotateCanvas(cropState.sourceCanvas, 90);
        const sw = cropState.sourceCanvas.width;
        const sh = cropState.sourceCanvas.height;
        if (cropState.sourceQuad && cropState.sourceQuad.length === 4) {
          const oldW = sh;
          const oldH = sw;
          cropState.sourceQuad = [
            { x: Math.max(0, Math.min(sw, oldH - cropState.sourceQuad[3].y)), y: Math.max(0, Math.min(sh, cropState.sourceQuad[3].x)) },
            { x: Math.max(0, Math.min(sw, oldH - cropState.sourceQuad[0].y)), y: Math.max(0, Math.min(sh, cropState.sourceQuad[0].x)) },
            { x: Math.max(0, Math.min(sw, oldH - cropState.sourceQuad[1].y)), y: Math.max(0, Math.min(sh, cropState.sourceQuad[1].x)) },
            { x: Math.max(0, Math.min(sw, oldH - cropState.sourceQuad[2].y)), y: Math.max(0, Math.min(sh, cropState.sourceQuad[2].x)) }
          ];
        } else {
          cropState.sourceQuad = [
            { x: Math.round(sw * 0.06), y: Math.round(sh * 0.06) },
            { x: Math.round(sw * 0.94), y: Math.round(sh * 0.06) },
            { x: Math.round(sw * 0.94), y: Math.round(sh * 0.94) },
            { x: Math.round(sw * 0.06), y: Math.round(sh * 0.94) }
          ];
        }
        setupCropView();
        toast("Rotated 90°", "info");
      });
    }

    window.addEventListener("resize", () => {
      if (screens.crop && screens.crop.classList.contains("active")) {
        fitCropCanvas();
      }
    });

    if (window.ResizeObserver && els.cropStage) {
      const ro = new ResizeObserver(() => {
        if (screens.crop && screens.crop.classList.contains("active")) {
          fitCropCanvas();
        }
      });
      ro.observe(els.cropStage);
    }
  }

  // Initialize crop handles
  initCropHandles();

 // ---- File import (fallback / bulk import) ----
 els.importBtn.addEventListener("click", () => els.fileInput.click());

  // ---- Interactive Hero Drop Zone Handlers ----
  const dropZone = document.getElementById("dropZone");
  if (dropZone) {
    dropZone.addEventListener("click", () => els.fileInput.click());
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        els.fileInput.click();
      }
    });
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("drag-active");
    });
    dropZone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("drag-active");
    });
    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("drag-active");
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      if (files.length === 1) {
        try {
          const url = await fileToDataUrl(files[0]);
          const img = await loadImage(url);
          startCropWorkflow(img, { isNew: true });
        } catch (err) {
          console.error("Drop error:", err);
          toast("Failed to load dropped image", "error");
        }
      } else {
        toast(`Processing ${files.length} dropped images...`, "info");
        let count = 0;
        for (const f of files) {
          try {
            const url = await fileToDataUrl(f);
            const img = await loadImage(url);
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d").drawImage(img, 0, 0);

            let quad = null;
            try {
              const res = EdgeDetect.detect(canvas);
              if (res && res.quad && res.confidence > 0.1) {
                const scaleX = canvas.width / res.w;
                const scaleY = canvas.height / res.h;
                quad = res.quad.map((p) => ({
                  x: p.x * scaleX,
                  y: p.y * scaleY
                }));
              }
            } catch (_) {}

            const corrected = Perspective.correct(canvas, quad);
            const page = {
              id: "p_" + Math.random().toString(36).slice(2, 8),
              src: corrected.toDataURL("image/jpeg", 0.9),
              straightened: corrected.toDataURL("image/jpeg", 0.9),
              filter: "original",
              original: canvas.toDataURL("image/jpeg", 0.9),
              raw: canvas.toDataURL("image/jpeg", 0.92),
              quad: quad
            };
            state.pages.push(page);
            count++;
          } catch (err) {
            console.error(err);
          }
        }
        renderThumbs();
        if (state.pages.length) {
          showScreen("review");
          toast(`Imported & straightened ${count} page(s)`, "success");
        }
      }
    });
  }

 els.fallbackImportBtn.addEventListener("click", () => els.fileInput.click());
 if (els.resumeBtn) els.resumeBtn.addEventListener("click", () => showScreen("review"));

 els.fileInput.addEventListener("change", async (e) => {
 const files = Array.from(e.target.files || []);
 if (!files.length) return;
 els.fileInput.value = "";

 if (files.length === 1) {
 // Single image: open interactive perspective crop screen with auto-detected edges!
 try {
 const url = await fileToDataUrl(files[0]);
 const img = await loadImage(url);
 startCropWorkflow(img, { isNew: true });
 } catch (err) {
 console.error("Single file import error:", err);
 toast("Failed to load image", "error");
 }
 } else {
 // Multiple images: auto-detect and correct each one
 toast(`Processing ${files.length} images...`, "info");
 let count = 0;
 for (const f of files) {
 try {
 const url = await fileToDataUrl(f);
 const img = await loadImage(url);
 const canvas = document.createElement("canvas");
 canvas.width = img.naturalWidth;
 canvas.height = img.naturalHeight;
 canvas.getContext("2d").drawImage(img, 0, 0);

 let quad = null;
 try {
 const res = EdgeDetect.detect(canvas);
 if (res && res.quad && res.confidence > 0.1) {
 const scaleX = canvas.width / res.w;
 const scaleY = canvas.height / res.h;
 quad = res.quad.map((p) => ({
 x: p.x * scaleX,
 y: p.y * scaleY
 }));
 }
 } catch (_) {}

 const corrected = Perspective.correct(canvas, quad);
 const page = {
 id: "p_" + Math.random().toString(36).slice(2, 8),
 src: corrected.toDataURL("image/jpeg", 0.9),
 straightened: corrected.toDataURL("image/jpeg", 0.9),
 filter: "original",
 original: canvas.toDataURL("image/jpeg", 0.9),
 raw: canvas.toDataURL("image/jpeg", 0.92),
 quad: quad
 };
 state.pages.push(page);
 count++;
 } catch (err) {
 console.error(err);
 }
 }
 renderThumbs();
 if (state.pages.length) {
 showScreen("review");
 toast(`Imported & straightened ${count} page(s)`, "success");
 }
 }
 });

 function fileToDataUrl(file) {
 return new Promise((res, rej) => {
 const fr = new FileReader();
 fr.onload = () => res(fr.result);
 fr.onerror = () => rej(fr.error);
 fr.readAsDataURL(file);
 });
 }

 function loadImage(url) {
 return new Promise((res, rej) => {
 const img = new Image();
 img.onload = () => res(img);
 img.onerror = rej;
 img.src = url;
 });
 }

 // ---- Review screen ----
 els.reviewBack.addEventListener("click", () => showScreen("home"));
 els.addMoreBtn.addEventListener("click", () => showScreen("camera"));
 els.exportBtn.addEventListener("click", exportPdf);

 
  // ---- Custom Confirmation Modal (Linear/Apple Style, Zero Native Dialogs) ----
  function showConfirm({ title, message, confirmText = "Confirm", cancelText = "Cancel", isDanger = false } = {}) {
    return new Promise((resolve) => {
      const modal = document.getElementById("confirmModal");
      const titleEl = document.getElementById("confirmTitle");
      const msgEl = document.getElementById("confirmMessage");
      const okBtn = document.getElementById("confirmOkBtn");
      const cancelBtn = document.getElementById("confirmCancelBtn");
      if (!modal || !okBtn || !cancelBtn) {
        resolve(true);
        return;
      }
      titleEl.textContent = title || "Confirm Action";
      msgEl.textContent = message || "Are you sure you want to proceed?";
      okBtn.textContent = confirmText;
      cancelBtn.textContent = cancelText;
      if (isDanger) {
        okBtn.className = "pill-btn danger";
      } else {
        okBtn.className = "pill-btn primary";
      }

      modal.classList.add("show");

      function cleanup(result) {
        modal.classList.remove("show");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        modal.removeEventListener("click", onBackdrop);
        window.removeEventListener("keydown", onKeyDown);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onBackdrop(e) { if (e.target === modal) cleanup(false); }
      function onKeyDown(e) {
        if (e.key === "Escape") cleanup(false);
        if (e.key === "Enter") cleanup(true);
      }

      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      modal.addEventListener("click", onBackdrop);
      window.addEventListener("keydown", onKeyDown);
      okBtn.focus();
    });
  }

  // ---- Robust IndexedDB Storage (Bypasses 5MB sessionStorage quota) ----
  const IDB_NAME = "DocScanDB";
  const IDB_STORE = "draft_pages";

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB not supported"));
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveSessionToIDB(pages) {
    try {
      const db = await openDatabase();
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      await new Promise((res, rej) => {
        const clearReq = store.clear();
        clearReq.onsuccess = res;
        clearReq.onerror = rej;
      });
      for (const p of pages) {
        store.put(p);
      }
    } catch (_) {}
  }

  async function loadSessionFromIDB() {
    try {
      const db = await openDatabase();
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (_) {
      return [];
    }
  }

    // ---- In-Browser OCR / Copy Text (Microsoft Lens Parity) ----
  async function performOcr(dataUrl) {
    toast("Initializing on-device OCR engine...", "info");
    if (!window.Tesseract) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("Could not load OCR library from CDN. Please check your internet connection."));
        document.head.appendChild(s);
      });
    }

    if (!window.Tesseract || typeof window.Tesseract.createWorker !== "function") {
      throw new Error("OCR engine failed to initialize");
    }

    toast("Processing document text...", "info");
    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js",
      logger: (m) => {
        if (m && m.status === "recognizing text" && typeof m.progress === "number") {
          const pct = Math.round(m.progress * 100);
          if (pct > 0 && pct % 30 === 0) {
            toast("Recognizing text: " + pct + "%", "info");
          }
        }
      }
    });

    const ret = await worker.recognize(dataUrl);
    await worker.terminate();
    return (ret && ret.data && ret.data.text) ? ret.data.text.trim() : "";
  }

  async function handleOcrPage(pageSrc, pageNum) {
    try {
      const text = await performOcr(pageSrc);
      if (!text) {
        toast("No readable text detected on page " + pageNum + ". Try adjusting contrast with the B&W filter.", "info");
        return;
      }
      const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      showModal(
        "Extracted Text (Page " + pageNum + ")",
        `<div style="text-align:left;">
          <p style="margin:0 0 8px;font-size:13px;color:var(--ink-soft);">Recognized on-device via browser OCR engine:</p>
          <textarea id="ocrResultText" style="width:100%;height:180px;font-family:var(--mono);font-size:12.5px;padding:10px;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);border-radius:8px;resize:vertical;" readonly>${safeText}</textarea>
          <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px;">
            <button class="pill-btn primary" id="copyOcrTextBtn" type="button">Copy to Clipboard</button>
          </div>
        </div>`
      );
      setTimeout(() => {
        const copyBtn = document.getElementById("copyOcrTextBtn");
        const area = document.getElementById("ocrResultText");
        if (copyBtn && area) {
          copyBtn.addEventListener("click", () => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(area.value).then(() => {
                copyBtn.textContent = "Copied!";
                toast("Text copied to clipboard!", "success");
                setTimeout(() => { copyBtn.textContent = "Copy to Clipboard"; }, 2000);
              }).catch(() => {
                area.select();
                document.execCommand("copy");
                toast("Text copied to clipboard!", "success");
              });
            } else {
              area.select();
              document.execCommand("copy");
              toast("Text copied to clipboard!", "success");
            }
          });
        }
      }, 60);
    } catch (err) {
      console.warn("OCR Error handled safely:", err);
      const msg = (err && (err.message || String(err))) || "Network or OCR engine error";
      toast("OCR Notice: " + msg, "error");
    }
  }

  function renderReview() {
    els.reviewList.innerHTML = "";
    els.reviewMeta.textContent =
      state.pages.length + (state.pages.length === 1 ? " page" : " pages");
    if (!state.pages.length) {
      const empty = document.createElement("div");
      empty.className = "review-empty";
      empty.innerHTML = `<p>No pages yet</p><p style="font-size:13px;opacity:.7;">Capture a page or import an image to get started.</p>`;
      els.reviewList.appendChild(empty);
      els.exportBtn.disabled = true;
      saveSession();
      updateHomeSessionBtn();
      return;
    }
    els.exportBtn.disabled = false;
    state.pages.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "page-card";
      card.dataset.id = p.id;
      card.draggable = true;
      const img = document.createElement("img");
      img.src = p.src;
      img.alt = "Page " + (i + 1);
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = "Page " + (i + 1) + " of " + state.pages.length;
      const actions = document.createElement("div");
      actions.className = "actions";

      // 1. Move Left / Earlier Button (Mobile touch & accessibility parity)
      const moveLeftBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
        "Move page earlier"
      );
      if (i === 0) {
        moveLeftBtn.disabled = true;
        moveLeftBtn.title = "First page";
      } else {
        moveLeftBtn.title = "Move page earlier";
        moveLeftBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const temp = state.pages[i];
          state.pages[i] = state.pages[i - 1];
          state.pages[i - 1] = temp;
          renderReview();
          renderThumbs();
          saveSession();
          toast("Moved page to position " + i, "info");
        });
      }

      // 2. Move Right / Later Button
      const moveRightBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
        "Move page later"
      );
      if (i === state.pages.length - 1) {
        moveRightBtn.disabled = true;
        moveRightBtn.title = "Last page";
      } else {
        moveRightBtn.title = "Move page later";
        moveRightBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const temp = state.pages[i];
          state.pages[i] = state.pages[i + 1];
          state.pages[i + 1] = temp;
          renderReview();
          renderThumbs();
          saveSession();
          toast("Moved page to position " + (i + 2), "info");
        });
      }

      // 3. Rotate 90 deg Button
      const rotateBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>',
        "Rotate 90 degrees"
      );
      rotateBtn.title = "Rotate 90 degrees";
      rotateBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const baseImg = p.straightened || p.src;
        const rotated = await rotateImageDataUrl(baseImg, 90);
        p.straightened = rotated;
        p.src = rotated;
        p.original = rotated;
        renderReview();
        saveSession();
        toast("Page rotated 90 degrees", "info");
      });

      // 4. Perspective Crop Button
      const cropBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/></svg>',
        "Perspective Crop"
      );
      cropBtn.title = "Perspective Crop";
      cropBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCropForPage(p.id);
      });

      // 5. Filter / Edit Button
      const editBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
        "Color and Filters"
      );
      editBtn.title = "Color and Filters";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEdit(p.id);
      });

      // 6. Copy Text (OCR - Microsoft Lens Parity)
      const ocrBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
        "Extract Text (OCR)"
      );
      ocrBtn.title = "Extract & Copy Text (OCR)";
      ocrBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleOcrPage(p.src, i + 1);
      });

      // 7. Download Single Page as JPG
      const downloadImgBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        "Save Page as JPG"
      );
      downloadImgBtn.title = "Save Page as JPG";
      downloadImgBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = document.createElement("a");
        a.href = p.src;
        const baseTitle = state.docTitle || ("DocScan-" + new Date().toISOString().slice(0, 10));
        a.download = `${baseTitle}-Page-${i + 1}.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast(`Downloaded Page ${i + 1} as JPG`, "success");
      });

      // 8. Delete Button with Sleek Aether/Apple Confirmation Modal (Zero Native Alerts)
      const delBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
        "Delete page"
      );
      delBtn.title = "Delete page";
      delBtn.classList.add("danger");
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await showConfirm({
          title: "Delete Page " + (i + 1) + "?",
          message: "This page will be removed from your scan. This action cannot be undone.",
          confirmText: "Delete",
          cancelText: "Cancel",
          isDanger: true
        });
        if (ok) {
          state.pages = state.pages.filter((x) => x.id !== p.id);
          renderReview();
          renderThumbs();
          saveSession();
          toast("Page deleted", "info");
        }
      });

      actions.appendChild(moveLeftBtn);
      actions.appendChild(moveRightBtn);
      actions.appendChild(rotateBtn);
      actions.appendChild(cropBtn);
      actions.appendChild(editBtn);
      actions.appendChild(ocrBtn);
      actions.appendChild(downloadImgBtn);
      actions.appendChild(delBtn);

      card.appendChild(img);
      card.appendChild(label);
      card.appendChild(actions);
      attachDragHandlers(card);
      els.reviewList.appendChild(card);
    });
    saveSession();
    updateHomeSessionBtn();
  }

  const SESSION_KEY = "docscan_session_draft";
 function saveSession() {
    try {
      if (state.pages && state.pages.length > 0) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.pages));
      } else {
        sessionStorage.removeItem(SESSION_KEY);
      }
    } catch (_) {}
    if (state.pages) {
      saveSessionToIDB(state.pages);
    }
    updateHomeSessionBtn();
  }

  async function restoreSession() {
    try {
      const idbPages = await loadSessionFromIDB();
      if (idbPages && idbPages.length > 0 && state.pages.length === 0) {
        state.pages = idbPages;
        renderReview();
        renderThumbs();
        updateHomeSessionBtn();
        toast("Restored " + idbPages.length + " pages from previous session", "info");
        return;
      }
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw && state.pages.length === 0) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          state.pages = parsed;
          renderReview();
          renderThumbs();
          updateHomeSessionBtn();
          toast("Restored " + parsed.length + " pages from previous session", "info");
        }
      }
    } catch (_) {}
  }

  function actionBtn(html, label) {
 const b = document.createElement("button");
 b.className = "action";
 b.setAttribute("aria-label", label);
 b.innerHTML = html;
 return b;
 }
 function attachDragHandlers(card) {
 card.addEventListener("dragstart", (e) => {
 card.classList.add("dragging");
 e.dataTransfer.setData("text/plain", card.dataset.id);
 e.dataTransfer.effectAllowed = "move";
 });
 card.addEventListener("dragend", () => card.classList.remove("dragging"));
 card.addEventListener("dragover", (e) => {
 e.preventDefault();
 card.classList.add("drag-over");
 });
 card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
 card.addEventListener("drop", (e) => {
 e.preventDefault();
 card.classList.remove("drag-over");
 const fromId = e.dataTransfer.getData("text/plain");
 const toId = card.dataset.id;
 if (fromId === toId) return;
 const fromIdx = state.pages.findIndex((p) => p.id === fromId);
 const toIdx = state.pages.findIndex((p) => p.id === toId);
 if (fromIdx < 0 || toIdx < 0) return;
 const [moved] = state.pages.splice(fromIdx, 1);
 state.pages.splice(toIdx, 0, moved);
 renderReview();
 toast("Page reordered");
 });
 }

 // ---- Edit / filters (Top 1% Document Enhancement) ----
 const FILTERS = [
 { id: "original", name: "Original", css: "none" },
 { id: "magic", name: "Magic Color", css: "contrast(1.35) brightness(1.08) saturate(1.15)" },
 { id: "bw", name: "B&W Doc", css: "grayscale(1) contrast(1.7) brightness(1.05)" },
 { id: "grayscale", name: "Grayscale", css: "grayscale(1) contrast(1.15) brightness(1.02)" },
 { id: "boost", name: "Text Boost", css: "contrast(1.25) brightness(1.04) saturate(1.3)" },
 { id: "sharp", name: "Sharp", css: "contrast(1.45) brightness(0.96)" }
 ];

 function openEdit(id) {
 state.editingId = id;
 showScreen("edit");
 }

 function renderEdit() {
 if (!state.editingId) return;
 const page = state.pages.find((p) => p.id === state.editingId);
 if (!page) {
 showScreen("review");
 return;
 }
 els.editTitle.textContent =
 "Page " + (state.pages.findIndex((p) => p.id === state.editingId) + 1);

 // CRITICAL: Always use the straightened document as the base for filters!
 const baseImgSrc = page.straightened || page.src;

 // Render the filter preview / current image
 els.editStage.innerHTML = "";
 const img = document.createElement("img");
 img.src = baseImgSrc;
 img.id = "editImg";
 const f = FILTERS.find((x) => x.id === page.filter) || FILTERS[0];
 img.style.filter = f.css;
 els.editStage.appendChild(img);

 // Render filter strip
 els.filters.innerHTML = "";
 FILTERS.forEach((flt) => {
 const b = document.createElement("button");
 b.className = "filter-btn" + (page.filter === flt.id ? " active" : "");
 const prev = document.createElement("div");
 prev.className = "preview";
 prev.style.backgroundImage = `url(${baseImgSrc})`;
 prev.style.filter = flt.css;
 const name = document.createElement("div");
 name.className = "name";
 name.textContent = flt.name;
 b.appendChild(prev);
 b.appendChild(name);
 b.addEventListener("click", () => {
 page.filter = flt.id;
 img.style.filter = flt.css;
 els.filters.querySelectorAll(".filter-btn").forEach((x, i) => {
 x.classList.toggle("active", FILTERS[i].id === flt.id);
 });
 });
 els.filters.appendChild(b);
 });
 }

 if (els.editRotateBtn) {
 els.editRotateBtn.addEventListener("click", async () => {
 const page = state.pages.find((p) => p.id === state.editingId);
 if (!page) return;
 const baseImg = page.straightened || page.src;
 const rotated = await rotateImageDataUrl(baseImg, 90);
 page.straightened = rotated;
 page.src = rotated;
 page.original = rotated;
 renderEdit();
 saveSession();
 toast("Rotated 90°", "info");
 });
 }

 els.editBack.addEventListener("click", () => {
 // Return to review without reverting perspective or breaking the straightened document!
 state.editingId = null;
 showScreen("review");
 });

 els.retakeBtn.addEventListener("click", () => {
 // Remove this page and re-open camera
 state.pages = state.pages.filter((p) => p.id !== state.editingId);
 state.editingId = null;
 showScreen("camera");
 });

 els.applyBtn.addEventListener("click", () => {
 // Bake the filter into the page's src on top of the straightened image
 const page = state.pages.find((p) => p.id === state.editingId);
 if (!page) return showScreen("review");
 const baseImgSrc = page.straightened || page.src;
 const f = FILTERS.find((x) => x.id === page.filter) || FILTERS[0];

 if (page.filter === "original") {
 page.src = baseImgSrc;
 page.original = baseImgSrc;
 state.editingId = null;
 renderReview();
 showScreen("review");
 saveSession();
 toast("Filter applied", "success");
 } else {
 const img = new Image();
 img.onload = () => {
 const c = document.createElement("canvas");
 c.width = img.naturalWidth;
 c.height = img.naturalHeight;
 const ctx = c.getContext("2d");
 ctx.filter = f.css;
 ctx.drawImage(img, 0, 0);
 page.src = c.toDataURL("image/jpeg", 0.92);
 // page.straightened remains clean straightened base!
 page.original = page.src;
 state.editingId = null;
 renderReview();
 showScreen("review");
 saveSession();
 toast("Filter applied", "success");
 };
 img.src = baseImgSrc;
 }
 });

 // ---- Export PDF ----
 async function exportPdf() {
 if (!state.pages.length) return;
 els.exportBtn.disabled = true;
 const oldLabel = els.exportBtn.textContent;
 els.exportBtn.textContent = "Building…";
 try {
 const images = [];
 for (const p of state.pages) {
 const img = await loadImage(p.src);
 const j = await PdfExport.imageToJpegBytes(img, 1800);
 images.push(j);
 }
 const fmt = els.pdfFormatSelect ? els.pdfFormatSelect.value : "AUTO";
      const blob = PdfExport.buildPdf(images, fmt);
 const url = URL.createObjectURL(blob);
 const a = document.createElement("a");
 a.href = url;
 const fileName = (state.docTitle || `DocScan-${new Date().toISOString().slice(0, 10)}`) + ".pdf";
 a.download = fileName;
 document.body.appendChild(a);
 a.click();
 a.remove();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
 toast("PDF exported: " + fileName, "success");
 } catch (err) {
 console.error(err);
 toast("Export failed", "error");
 } finally {
 els.exportBtn.textContent = oldLabel;
 els.exportBtn.disabled = false;
 }
 }

 // ---- Home -> Camera ----
 els.startScan.addEventListener("click", async () => {
 showScreen("camera");
 await startCamera();
 });
 els.aboutBtn.addEventListener("click", () => {
 showModal(
 "About DocScan",
 `<div style="text-align:left;line-height:1.6;font-size:13.5px;">
 <p style="margin:0 0 10px;"><b>Hello 👋 I'm Oathan Rex</b>, software developer and creator of <a href="https://perspectivefix.app" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:600;text-decoration:underline;">PerspectiveFix.app</a> and <b>DocScan</b>.</p>
 <p style="margin:0 0 10px;">I built DocScan as a 100% on-device, zero-download document scanner and perspective rectification tool. Everything runs directly inside your browser memory without cloud servers, account sign-ups, or subscriptions.</p>
 <ul style="margin:0 0 12px;padding-left:18px;">
 <li><b>Zero Cloud Uploads:</b> Camera frames and PDFs never leave your device.</li>
 <li><b>Computer Vision:</b> Real-time Sobel/Canny edge detection and bilinear homography.</li>
 <li><b>Forever Free:</b> Zero ads, zero watermarks, zero paywalls.</li>
 </ul>
 <div style="margin-top:14px;display:flex;flex-direction:column;gap:8px;">
 <a href="https://buymeacoffee.com/oathanrex" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;background:#FFDD00;color:#000000;font-weight:700;padding:10px 14px;border-radius:8px;text-decoration:none;">
 ☕ Buy Me a Coffee (Support Independent Tools)
 </a>
 <a href="https://perspectivefix.app" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;color:var(--ink);font-weight:600;text-decoration:none;border:1px solid var(--line);padding:8px 12px;border-radius:8px;background:var(--surface-2);">
 Explore PerspectiveFix.app &rarr;
 </a>
 </div>
 </div>`
 );
 });

 // ---- Flash / Torch toggle ----
 let flashOn = false;
 els.flashBtn.addEventListener("click", async () => {
 flashOn = !flashOn;
 els.flashBtn.style.color = flashOn ? "var(--accent-2)" : "";
 document.getElementById("camStage").style.background =
 flashOn ? "rgba(255,235,180,.12)" : "";
 if (state.cam.stream) {
 try {
 const track = state.cam.stream.getVideoTracks()[0];
 if (track && track.applyConstraints) {
 const caps = track.getCapabilities ? track.getCapabilities() : {};
 if (caps.torch) {
 await track.applyConstraints({ advanced: [{ torch: flashOn }] });
 }
 }
 } catch (err) {
 console.warn("Torch toggle error:", err);
 }
 }
 });

 // Initial render & restore previous session
 renderReview();
 restoreSession();

 // ---- Demo: generate sample documents so the full flow can be tried
 // without a camera. Renders 3 "scanned document" pages into a canvas,
 // adds them to the session, and jumps to the review screen.
 const SAMPLE_DOCS = [
 {
 title: "INVOICE #4821",
 lines: [
 "INVOICE #4821",
 "Date: July 12, 2026",
 "",
 "Bill To: From:",
 "Priya Sharma DocScan Demo Co.",
 "Mumbai, India 123 Maker Street",
 "",
 "Description Amount",
 "--------------------------------------",
 "Consulting services $1,200.00",
 "Reimbursable travel $180.50",
 "Software license $99.00",
 "",
 "Total $1,479.50",
 "",
 "Payment due within 30 days.",
 "Thank you for your business."
 ],
 font: "16px Georgia, serif"
 },
 {
 title: "CONTRACT",
 lines: [
 "FREELANCE SERVICES AGREEMENT",
 "",
 "This agreement is made on July 12, 2026,",
 "between DocScan Demo Co. (\"Client\") and",
 "the undersigned contractor.",
 "",
 "1. SCOPE OF WORK",
 " The contractor will deliver the services",
 " described in Schedule A within 30 days.",
 "",
 "2. COMPENSATION",
 " Total fee: USD 1,479.50, payable on",
 " completion and acceptance of deliverables.",
 "",
 "3. CONFIDENTIALITY",
 " Both parties agree to keep all shared",
 " information strictly confidential.",
 "",
 "Signed: _______________________",
 "Date: _______________________"
 ],
 font: "16px Georgia, serif"
 },
 {
 title: "RECEIPT",
 lines: [
 "RECEIPT",
 "",
 "Subway Sandwiches",
 "12 Main Street, Mumbai",
 "Tel: 555-0142",
 "",
 "Date: 12/07/2026 Time: 13:42",
 "Order #A-009182",
 "",
 "1x Footlong Veggie 180.00",
 "1x Cookie 40.00",
 "1x Bottled Water 20.00",
 "",
 "Subtotal 240.00",
 "GST (5%) 12.00",
 "TOTAL 252.00",
 "",
 "Paid by UPI",
 "Thank you, visit again!"
 ],
 font: "16px Georgia, serif"
 }
 ];

 function generateSampleDocument(spec) {
 const c = document.createElement("canvas");
 c.width = 600;
 c.height = 800;
 const ctx = c.getContext("2d");
 ctx.fillStyle = "#fdfcf7";
 ctx.fillRect(0, 0, 600, 800);
 // Subtle paper texture
 for (let i = 0; i < 4000; i++) {
 ctx.fillStyle = "rgba(0,0,0," + Math.random() * 0.04 + ")";
 ctx.fillRect(Math.random() * 600, Math.random() * 800, 1, 1);
 }
 ctx.fillStyle = "#111";
 let y = 60;
 for (const line of spec.lines) {
 const isTitle = line === spec.title;
 ctx.font = isTitle ? "bold 28px Georgia, serif" : spec.font;
 ctx.fillText(line, 50, y);
 y += isTitle ? 44 : 26;
 }
 return c.toDataURL("image/jpeg", 0.9);
 }

 function runDemo() {
 state.pages = [];
 SAMPLE_DOCS.forEach((spec) => {
 const src = generateSampleDocument(spec);
 state.pages.push({
 id: "p_" + Math.random().toString(36).slice(2, 8),
 src,
 filter: "original",
 original: src
 });
 });
 showScreen("review");
 toast("Loaded " + state.pages.length + " sample pages", "success");
 }
 els.demoBtn.addEventListener("click", runDemo);

 // ---- Environment diagnostics on home screen ----
 // Show a banner explaining if the camera won't work, so the user
 // knows to use Import or Demo instead.
 function showHomeStatus() {
 const issues = [];
 if (!window.isSecureContext) {
 issues.push("This page is not on a secure origin , the camera is blocked. Use Import or Demo instead.");
 }
 if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
 issues.push("Camera API (getUserMedia) is not available in this browser. Use Import or Demo instead.");
 }
 if (issues.length) {
 els.homeStatus.hidden = false;
 els.homeStatus.innerHTML =
 "<b>Heads up</b>" + issues.map((s) => "<div>" + s + "</div>").join("");
 } else {
 els.homeStatus.hidden = true;
 }
 }
 showHomeStatus();

 // Expose runDemo on window for easy debugging
 window.runDemo = runDemo;

 // ---- Boot diagnostics ----
 // Show, at the bottom of the home screen, which modules are loaded
 // and whether the environment can support the camera. This is the
 // first thing to look at if the app feels "dummy" (the user's word).
 function updateBootDiag() {
 if (!els.bootDiag) return;
 const have = {
 edge: !!window.EdgeDetect,
 perspective: !!window.Perspective,
 pdf: !!window.PdfExport
 };
 const cam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
 const secure = !!window.isSecureContext;
 const missing = Object.keys(have).filter((k) => !have[k]);
 if (missing.length) {
 els.bootDiag.className = "home-foot-diag err";
 els.bootDiag.textContent =
 "Boot error , missing modules: " + missing.join(", ") +
 ". Try \"Clear cache\" below.";
 return;
 }
 els.bootDiag.className = "home-foot-diag " + (cam && secure ? "ok" : "warn");
 els.bootDiag.textContent =
 "app: ready · modules: ok · " +
 "https: " + (secure ? "yes" : "NO") + " · " +
 "camera: " + (cam ? "available" : "blocked");
 }
 updateBootDiag();

 // ---- Clear cache & hard reload ----
 if (els.clearCacheBtn) {
 els.clearCacheBtn.addEventListener("click", async function () {
 els.clearCacheBtn.disabled = true;
 els.clearCacheBtn.textContent = "Clearing…";
 try {
 // 1. Delete every cache
 if (window.caches && caches.keys) {
 const keys = await caches.keys();
 await Promise.all(keys.map((k) => caches.delete(k)));
 }
 // 2. Unregister all service workers
 if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
 const regs = await navigator.serviceWorker.getRegistrations();
 await Promise.all(regs.map((r) => r.unregister()));
 }
 // 3. Hard reload (bypasses HTTP cache)
 var url = new URL(window.location.href);
 url.searchParams.set("_", Date.now());
 window.location.replace(url.toString());
 } catch (err) {
 // Last-resort reload
 window.location.reload();
 }
 });
 }

 // ---- Desktop Keyboard Shortcuts (Top 1% DX & WCAG Navigation) ----
 window.addEventListener("keydown", (e) => {
 if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) {
 return;
 }
 if (e.key === "Escape") {
 if (els.modal.classList.contains("show")) {
 els.modal.classList.remove("show");
 return;
 }
 if (state.currentScreen === "camera") {
 stopCamera();
 showScreen("home");
 } else if (state.currentScreen === "crop") {
 if (state.pages.length > 0) {
 showScreen("review");
 } else {
 showScreen("home");
 }
 } else if (state.currentScreen === "edit") {
 showScreen("review");
 }
 } else if (e.key === "r" || e.key === "R") {
 if (state.currentScreen === "crop" && els.cropRotateBtn) {
 els.cropRotateBtn.click();
 } else if (state.currentScreen === "edit" && els.editRotateBtn) {
 els.editRotateBtn.click();
 }
 } else if (e.key === "Enter") {
 if (els.modal.classList.contains("show")) {
 els.modalOk.click();
 } else if (state.currentScreen === "crop" && els.cropApplyBtn) {
 els.cropApplyBtn.click();
 } else if (state.currentScreen === "edit" && els.editDoneBtn) {
 els.editDoneBtn.click();
 }
 } else if (e.key === " " && state.currentScreen === "camera") {
 e.preventDefault();
 if (els.shutterBtn) els.shutterBtn.click();
 }
 });

  // ---- Top 1% PWA Installation Manager ----
  let deferredPrompt = null;
  const pwaCard = document.getElementById("pwaCard");
  const pwaInstallBtn = document.getElementById("pwaCardInstallBtn");
  const pwaDismissBtn = document.getElementById("pwaCardDismissBtn");
  const footerInstallBtn = document.getElementById("footerInstallBtn");
  const iosModal = document.getElementById("iosInstallModal");
  const closeIosBtn = document.getElementById("closeIosInstallBtn");

  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  function showPwaBanner() {
    if (isStandalone) return;
    try {
      if (localStorage.getItem("docscan_pwa_dismissed") === "true") return;
    } catch (_) {}
    if (pwaCard) pwaCard.classList.add("visible");
  }

  function hidePwaBanner() {
    if (pwaCard) pwaCard.classList.remove("visible");
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(showPwaBanner, 2200);
  });

  if (isIos && !isStandalone) {
    setTimeout(showPwaBanner, 3000);
  }

  async function triggerInstallFlow() {
    if (isStandalone) {
      toast("DocScan is already running as an installed app", "info");
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        hidePwaBanner();
        toast("DocScan installed successfully!", "success");
      }
      deferredPrompt = null;
    } else if (isIos) {
      if (iosModal) iosModal.classList.add("open"); iosModal.classList.add("show");
    } else {
      toast("To install DocScan, tap the Install icon in your browser address bar", "info");
    }
  }

  if (pwaInstallBtn) pwaInstallBtn.addEventListener("click", triggerInstallFlow);
  if (footerInstallBtn) footerInstallBtn.addEventListener("click", triggerInstallFlow);

  if (pwaDismissBtn) {
    pwaDismissBtn.addEventListener("click", () => {
      hidePwaBanner();
      try {
        localStorage.setItem("docscan_pwa_dismissed", "true");
      } catch (_) {}
    });
  }

    const iosOkBtn = document.getElementById("iosModalOkBtn");
  if (iosOkBtn && iosModal) {
    iosOkBtn.addEventListener("click", () => iosModal.classList.remove("open"));
  }
  if (closeIosBtn && iosModal) {
    closeIosBtn.addEventListener("click", () => iosModal.classList.remove("open"));
    iosModal.addEventListener("click", (e) => {
      if (e.target === iosModal) iosModal.classList.remove("open"); iosModal.classList.remove("show");
    });
  }

  
  // Test query parameter hooks for automation
  if (typeof window !== "undefined" && window.location) {
    const params = new URLSearchParams(window.location.search);
    if (params.has("testPwa")) {
      setTimeout(() => {
        const c = document.getElementById("pwaCard");
        if (c) c.classList.add("visible");
      }, 150);
    }
    if (params.has("testIos")) {
      setTimeout(() => {
        const m = document.getElementById("iosInstallModal");
        if (m) m.classList.add("open"); m.classList.add("show");
      }, 150);
    }
  }

  window.addEventListener("appinstalled", () => {
    hidePwaBanner();
    deferredPrompt = null;
    toast("DocScan installed successfully!", "success");
  });

})();
