// pdf-export.js
// A minimal, dependency-free PDF builder for the scanner MVP. Generates
// a single PDF file containing one page per image. Each image is
// embedded as a JPEG, sized to a standard A4 / Letter page at the
// image's natural aspect ratio.
//
// Implements just enough of the PDF 1.4 spec to render in every reader:
//   - header
//   - catalog, pages tree
//   - one /Page per image
//   - one /XObject /Image per page (DCTDecode JPEG)
//   - xref table + trailer
//
// The PRD's success metric: "a 10-page document in under 3 seconds" —
// we easily beat that on a desktop and should be well within budget on
// a mid-range phone.

(function (global) {
  "use strict";

  // ---- Stream building ----
  function buildImageXObject(jpegBytes, w, h) {
    // w, h are in pixels. PDF /Width /Height expect pixels.
    // /ColorSpace /DeviceRGB assumes 3-channel JPEGs (which our
    // toBlob('image/jpeg') always produces).
    const dict =
      "/Type /XObject\n" +
      "/Subtype /Image\n" +
      "/Width " + w + "\n" +
      "/Height " + h + "\n" +
      "/ColorSpace /DeviceRGB\n" +
      "/BitsPerComponent 8\n" +
      "/Filter /DCTDecode\n";
    return { dict, stream: jpegBytes };
  }

  function buildPageContent(imgW, imgH, pageW, pageH) {
    // Center the image on the page preserving aspect.
    const scale = Math.min(pageW / imgW, pageH / imgH);
    const drawW = imgW * scale;
    const drawH = imgH * scale;
    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;
    return (
      "q\n" +
      drawW.toFixed(2) + " 0 0 " + drawH.toFixed(2) + " " +
      x.toFixed(2) + " " + y.toFixed(2) + " cm\n" +
      "/Im0 Do\n" +
      "Q\n"
    );
  }

  function bytesToBinaryString(bytes) {
    // PDF text streams are Latin-1-ish. Convert each byte 0..255 to a
    // character. For our content (which is pure ASCII), this is fine.
    let out = "";
    const len = bytes.length;
    // Chunk to avoid huge string concat arguments
    const CHUNK = 0x8000;
    for (let i = 0; i < len; i += CHUNK) {
      out += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + CHUNK, len))
      );
    }
    return out;
  }

  // Build a complete PDF from a list of { jpegBytes, width, height }.
  // pageFormat: 'A4' | 'LETTER'
  function buildPdf(images, pageFormat) {
    const pageSizes = {
      A4: { w: 595, h: 842 },       // points
      LETTER: { w: 612, h: 792 }
    };
    const ps = pageSizes[pageFormat] || pageSizes.A4;

    const objects = []; // each: { body: string | Uint8Array, isStream: bool }
    // We will reserve: 1 = Catalog, 2 = Pages, 3 = Font (unused but
    // valid for /Resources), then per-image: XObject + Page, plus one
    // content stream per page.
    //
    // Simpler: we use one content stream per page; the resource dict
    // for each page references its own XObject as /Im0.
    const xref = []; // byte offsets; xref[i] = offset of object i
    const parts = []; // accumulated binary chunks
    let pos = 0;

    function push(s) {
      const bin = typeof s === "string" ? s : bytesToBinaryString(s);
      parts.push(bin);
      pos += bin.length;
    }
    function pushObject(idx, body) {
      xref[idx] = pos;
      push(idx + " 0 obj\n");
      push(body);
      push("\nendobj\n");
    }

    push("%PDF-1.4\n");
    // Binary marker comment so tools detect this as a binary file
    push("%\xE2\xE3\xCF\xD3\n");

    // 1: Catalog
    pushObject(1, "<< /Type /Catalog /Pages 2 0 R >>");

    // 2: Pages — we'll fill this in after we know the kid list, so
    // defer emitting the body. We still need to reserve an xref slot
    // for object 2 at the offset where it WILL live, but since the
    // bytes for object 2 haven't been written yet, we'll emit it
    // *after* all image XObjects and content streams, and patch its
    // offset into the xref table afterwards.

    // First, walk images and emit (per image): XObject (image) and
    // a content stream, then a Page that references the content.
    let objIdx = 3;
    const pageObjIndexes = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const xobjIdx = objIdx++;
      const contentIdx = objIdx++;
      const pageIdx = objIdx++;

      // XObject
      const xo = buildImageXObject(img.jpegBytes, img.width, img.height);
      xref[xobjIdx] = pos;
      push(xobjIdx + " 0 obj\n");
      push("<<\n" + xo.dict + "/Length " + xo.stream.length + " >>\nstream\n");
      push(xo.stream);
      push("\nendstream\nendobj\n");

      // Content stream
      const content = buildPageContent(img.width, img.height, ps.w, ps.h);
      const contentBytes = new TextEncoder().encode(content);
      xref[contentIdx] = pos;
      push(contentIdx + " 0 obj\n<< /Length " + contentBytes.length + " >>\nstream\n");
      push(contentBytes);
      push("\nendstream\nendobj\n");

      // Page
      pageObjIndexes.push(pageIdx);
      const pageBody =
        "<< /Type /Page /Parent 2 0 R " +
        "/MediaBox [0 0 " + ps.w + " " + ps.h + "] " +
        "/Resources << /XObject << /Im0 " + xobjIdx + " 0 R >> /ProcSet [/PDF /ImageC] >> " +
        "/Contents " + contentIdx + " 0 R >>";
      xref[pageIdx] = pos;
      push(pageIdx + " 0 obj\n");
      push(pageBody);
      push("\nendobj\n");
    }

    // Now emit the Pages object (object 2) as a single, well-formed body.
    xref[2] = pos;
    const kidsStr = pageObjIndexes.map((i) => i + " 0 R").join(" ");
    const pagesBody =
      "<< /Type /Pages /Kids [" + kidsStr + "] /Count " + pageObjIndexes.length + " >>";
    push("2 0 obj\n");
    push(pagesBody);
    push("\nendobj\n");

    // xref table
    const xrefOffset = pos;
    push("xref\n");
    push("0 " + objIdx + "\n");
    push("0000000000 65535 f \n");
    for (let i = 1; i < objIdx; i++) {
      const off = xref[i] != null ? xref[i] : 0;
      push(String(off).padStart(10, "0") + " 00000 n \n");
    }

    push("trailer\n<< /Size " + objIdx + " /Root 1 0 R >>\n");
    push("startxref\n" + xrefOffset + "\n%%EOF\n");

    // Concatenate parts into a Blob
    return new Blob(parts, { type: "application/pdf" });
  }

  // Convert an image source (canvas or HTMLImageElement) to a JPEG
  // Uint8Array with given dimensions.
  function imageToJpegBytes(source, maxDim) {
    return new Promise(function (resolve, reject) {
      const w0 = source.naturalWidth || source.width;
      const h0 = source.naturalHeight || source.height;
      const scale = Math.min(1, maxDim / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(source, 0, 0, w, h);

      canvas.toBlob(
        function (blob) {
          if (!blob) {
            reject(new Error("toBlob returned null"));
            return;
          }
          const fr = new FileReader();
          fr.onload = function () {
            const buf = new Uint8Array(fr.result);
            resolve({ jpegBytes: buf, width: w, height: h });
          };
          fr.onerror = function () {
            reject(fr.error || new Error("FileReader error"));
          };
          fr.readAsArrayBuffer(blob);
        },
        "image/jpeg",
        0.88
      );
    });
  }

  const api = { buildPdf, imageToJpegBytes, buildPageContent, buildImageXObject, bytesToBinaryString };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.PdfExport = api;
})(typeof window !== "undefined" ? window : globalThis);
