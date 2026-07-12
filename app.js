// app.js
// Top-level application controller for DocScan. Wires together:
//   - Camera lifecycle (getUserMedia)
//   - Real-time edge detection loop (EdgeDetect)
//   - Capture, perspective correction, multi-page session
//   - Review, reorder, retake, delete
//   - Filter / edit (V1.1 enhancement filters)
//   - PDF export (PdfExport)
//
// Designed to match the PRD's primary user flow:
//   Home -> Camera -> [Auto-detect -> Capture -> loop] -> Review -> Export

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
    pages: [], // { id, src, filter, original }
    editingId: null,
    cam: {
      stream: null,
      tracking: false,
      locked: false,
      quad: null,
      lastDetect: 0,
      manual: false
    }
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $("screen-home"),
    camera: $("screen-camera"),
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
    finishBtn: $("finishBtn"),
    manualBtn: $("manualBtn"),
    flashBtn: $("flashBtn"),
    thumbStrip: $("thumbStrip"),
    startScan: $("startScanBtn"),
    importBtn: $("importBtn"),
    fileInput: $("fileInput"),
    fallbackImportBtn: $("fallbackImportBtn"),
    demoBtn: $("demoBtn"),
    homeStatus: $("homeStatus"),
    reviewList: $("reviewList"),
    reviewMeta: $("reviewMeta"),
    reviewBack: $("reviewBackBtn"),
    addMoreBtn: $("addMoreBtn"),
    exportBtn: $("exportBtn"),
    editStage: $("editStage"),
    editTitle: $("editTitle"),
    editBack: $("editBackBtn"),
    filters: $("filters"),
    retakeBtn: $("retakeBtn"),
    applyBtn: $("applyBtn"),
    toast: $("toast"),
    toastText: $("toastText"),
    toastIco: $("toastIco"),
    modal: $("modal"),
    modalTitle: $("modalTitle"),
    modalBody: $("modalBody"),
    modalOk: $("modalOk"),
    aboutBtn: $("aboutBtn")
  };

  // ---- Screen navigation ----
  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => {
      el.classList.toggle("active", k === name);
    });
    if (name !== "camera") stopCamera();
    if (name === "review") renderReview();
    if (name === "edit") renderEdit();
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
    els.modalBody.textContent = body;
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
      setStatus("Adjusting corners", true);
    };
    const onUp = () => {
      drag = null;
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
  els.closeCam.addEventListener("click", () => showScreen("review"));

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
      filter: "original",
      original: corrected.toDataURL("image/jpeg", 0.9)
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

  // ---- File import (fallback / bulk import) ----
  els.importBtn.addEventListener("click", () => els.fileInput.click());
  els.fallbackImportBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    for (const f of files) {
      try {
        const url = await fileToDataUrl(f);
        const img = await loadImage(url);
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        const page = {
          id: "p_" + Math.random().toString(36).slice(2, 8),
          src: canvas.toDataURL("image/jpeg", 0.9),
          filter: "original",
          original: canvas.toDataURL("image/jpeg", 0.9)
        };
        state.pages.push(page);
      } catch (err) {
        console.error(err);
      }
    }
    els.fileInput.value = "";
    renderThumbs();
    if (state.pages.length) {
      showScreen("review");
      toast(`Imported ${files.length} page(s)`, "success");
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
  els.reviewBack.addEventListener("click", () => showScreen("camera"));
  els.addMoreBtn.addEventListener("click", () => showScreen("camera"));
  els.exportBtn.addEventListener("click", exportPdf);

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
      label.textContent = "P" + (i + 1);
      const actions = document.createElement("div");
      actions.className = "actions";
      const editBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
        "Edit"
      );
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEdit(p.id);
      });
      const delBtn = actionBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
        "Delete"
      );
      delBtn.classList.add("danger");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm("Delete this page?")) {
          state.pages = state.pages.filter((x) => x.id !== p.id);
          renderReview();
          toast("Page deleted");
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      card.appendChild(img);
      card.appendChild(label);
      card.appendChild(actions);
      attachDragHandlers(card);
      els.reviewList.appendChild(card);
    });
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

  // ---- Edit / filters (V1.1) ----
  const FILTERS = [
    { id: "original", name: "Original", css: "none" },
    { id: "bw", name: "B&W", css: "grayscale(1) contrast(1.2)" },
    { id: "grayscale", name: "Gray", css: "grayscale(1)" },
    { id: "boost", name: "Boost", css: "saturate(1.2) contrast(1.1)" },
    { id: "magic", name: "Magic", css: "contrast(1.3) brightness(1.05) saturate(0.9)" }
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

    // Render the filter preview / current image
    els.editStage.innerHTML = "";
    const img = document.createElement("img");
    img.src = page.original;
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
      prev.style.backgroundImage = `url(${page.original})`;
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
  els.editBack.addEventListener("click", () => {
    // Discard filter changes if user backs out
    const page = state.pages.find((p) => p.id === state.editingId);
    if (page) {
      page.filter = "original";
      page.src = page.original;
    }
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
    // Bake the filter into the page's src so it persists
    const page = state.pages.find((p) => p.id === state.editingId);
    if (!page) return showScreen("review");
    const f = FILTERS.find((x) => x.id === page.filter) || FILTERS[0];
    if (page.filter === "original") {
      page.src = page.original;
    } else {
      // Re-render via canvas with the filter applied
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.filter = f.css;
        ctx.drawImage(img, 0, 0);
        page.src = c.toDataURL("image/jpeg", 0.9);
        page.original = page.src; // bake permanently
        state.editingId = null;
        showScreen("review");
        toast("Filter applied", "success");
      };
      img.src = page.original;
      return;
    }
    state.editingId = null;
    showScreen("review");
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
      const blob = PdfExport.buildPdf(images, "A4");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `DocScan-${stamp}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("PDF exported", "success");
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
      "DocScan implements the MVP from the Mobile Document Scanner PRD: automatic border detection, perspective correction, multi-page capture, review/reorder, and PDF export — all on-device."
    );
  });

  // ---- Flash toggle (visual only) ----
  let flashOn = false;
  els.flashBtn.addEventListener("click", () => {
    flashOn = !flashOn;
    els.flashBtn.style.color = flashOn ? "var(--accent-2)" : "";
    document.getElementById("camStage").style.background =
      flashOn ? "rgba(255,235,180,.12)" : "";
  });

  // Initial render
  renderReview();

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
        "Bill To:                        From:",
        "Priya Sharma                    DocScan Demo Co.",
        "Mumbai, India                   123 Maker Street",
        "",
        "Description                     Amount",
        "--------------------------------------",
        "Consulting services            $1,200.00",
        "Reimbursable travel              $180.50",
        "Software license                 $99.00",
        "",
        "Total                          $1,479.50",
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
        "   The contractor will deliver the services",
        "   described in Schedule A within 30 days.",
        "",
        "2. COMPENSATION",
        "   Total fee: USD 1,479.50, payable on",
        "   completion and acceptance of deliverables.",
        "",
        "3. CONFIDENTIALITY",
        "   Both parties agree to keep all shared",
        "   information strictly confidential.",
        "",
        "Signed: _______________________",
        "Date:   _______________________"
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
        "Date: 12/07/2026   Time: 13:42",
        "Order #A-009182",
        "",
        "1x Footlong Veggie              180.00",
        "1x Cookie                          40.00",
        "1x Bottled Water                   20.00",
        "",
        "Subtotal                        240.00",
        "GST (5%)                         12.00",
        "TOTAL                           252.00",
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
      issues.push("This page is not on a secure origin — the camera is blocked. Use Import or Demo instead.");
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
})();
