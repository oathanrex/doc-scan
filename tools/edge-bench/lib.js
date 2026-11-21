// Shared helpers for the Node harness: decode, resize, overlay drawing.
const fs = require("fs");
const { PNG } = require("pngjs");
const jpeg = require("jpeg-js");

function decode(path) {
  const buf = fs.readFileSync(path);
  if (path.toLowerCase().endsWith(".png")) {
    const p = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(p.data), w: p.width, h: p.height };
  }
  const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(j.data), w: j.width, h: j.height };
}

// Area-average downscale (close to what canvas drawImage does when shrinking).
function resize(img, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  const sx = img.w / nw, sy = img.h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy, y1 = Math.min(img.h, (y + 1) * sy);
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx, x1 = Math.min(img.w, (x + 1) * sx);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          const ww = wx * wy;
          const i = (yy * img.w + xx) * 4;
          r += img.data[i] * ww; g += img.data[i + 1] * ww;
          b += img.data[i + 2] * ww; a += img.data[i + 3] * ww;
          wsum += ww;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = a / wsum;
    }
  }
  return { data: out, w: nw, h: nh };
}

function line(img, x0, y0, x1, y1, col, thick = 2) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    for (let dy = -thick; dy <= thick; dy++)
      for (let dx = -thick; dx <= thick; dx++) {
        const px = Math.round(x + dx), py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
        const o = (py * img.w + px) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
      }
  }
}

function dot(img, x, y, col, r = 7) {
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const px = Math.round(x + dx), py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
      const o = (py * img.w + px) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
}

// Draw a quad (in image pixel coords) onto a copy of img and write PNG.
function writeOverlay(img, quad, outPath, col = [0, 255, 0]) {
  const c = { data: new Uint8ClampedArray(img.data), w: img.w, h: img.h };
  if (quad) {
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      line(c, a.x, a.y, b.x, b.y, col, 2);
    }
    quad.forEach((p, i) => dot(c, p.x, p.y, [255, 0, 0], 8));
  }
  const png = new PNG({ width: c.w, height: c.h });
  png.data = Buffer.from(c.data);
  fs.writeFileSync(outPath, PNG.sync.write(png));
}

function writeGray(arr, w, h, outPath, scale = 1) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, arr[i] * scale));
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(outPath, PNG.sync.write(png));
}

module.exports = { decode, resize, writeOverlay, writeGray };
