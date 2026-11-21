"""Synthetic benchmark: real card textures pasted on real bedsheet texture with
known ground-truth corners, plus negative (no document) and plain-paper cases."""
import json, math, random
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

random.seed(7); np.random.seed(7)
import os
UP = os.environ.get("CARD_DIR", ".") + "/"   # folder holding votercard01.png / votercard02.jpeg

def persp_coeffs(dst, src):
    # PIL wants coeffs mapping OUTPUT (dst) pixel -> INPUT (src) pixel
    A = []; B = []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()

def rectify(img, quad, W, H):
    dst = [(0, 0), (W, 0), (W, H), (0, H)]
    return img.transform((W, H), Image.PERSPECTIVE, persp_coeffs(dst, quad), Image.BICUBIC)

# --- real card textures, rectified with the (visually verified) detected quads
c1 = Image.open(UP + "votercard01.png").convert("RGB")
c2 = Image.open(UP + "votercard02.jpeg").convert("RGB")
card1 = rectify(c1, [(80.5, 317.2), (456.7, 296.8), (513.2, 881.6), (56.1, 890.7)], 440, 590)
card2 = rectify(c2, [(167.8, 535.3), (629.1, 523.1), (676.5, 1295.2), (159.1, 1313.4)], 470, 780)

# --- real bedsheet textures (clean regions only) mirror-tiled to a large canvas
def tile_bg(img, box, W, H):
    t = img.crop(box)
    tw, th = t.size
    big = Image.new("RGB", (tw * 2, th * 2))
    big.paste(t, (0, 0)); big.paste(t.transpose(Image.FLIP_LEFT_RIGHT), (tw, 0))
    big.paste(t.transpose(Image.FLIP_TOP_BOTTOM), (0, th))
    big.paste(t.transpose(Image.ROTATE_180), (tw, th))
    out = Image.new("RGB", (W, H))
    for yy in range(0, H, big.height):
        for xx in range(0, W, big.width):
            out.paste(big, (xx, yy))
    return out

bgs = {
  "bed2": lambda W, H: tile_bg(c2, (0, 0, 900, 440), W, H),
  "bed1": lambda W, H: tile_bg(c1, (0, 0, 636, 270), W, H),
}

def wood(W, H):
    base = np.zeros((H, W, 3), np.float32)
    y = np.arange(H)[:, None]
    grain = 0.5 + 0.5 * np.sin(y * 0.35 + np.cumsum(np.random.randn(H, 1) * 0.15, 0))
    base[..., 0] = 120 + 40 * grain; base[..., 1] = 80 + 28 * grain; base[..., 2] = 45 + 18 * grain
    base += np.random.randn(H, W, 3) * 4
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))

def plain_paper(W, H):
    """Text-like white A4 sheet (synthetic)."""
    im = Image.new("RGB", (W, H), (246, 245, 240))
    d = ImageDraw.Draw(im)
    for r in range(1, 28):
        y = int(H * (0.06 + 0.032 * r))
        x2 = int(W * random.uniform(0.55, 0.92))
        d.rectangle([W * 0.08, y, x2, y + 6], fill=(60, 60, 70))
    return im

def compose(bg, doc, W, H, scale, rot, jit):
    dw, dh = doc.size
    s = scale * W / dw
    dw2, dh2 = dw * s, dh * s
    cx = random.uniform(0.35, 0.65) * W; cy = random.uniform(0.38, 0.62) * H
    pts = [(-dw2/2, -dh2/2), (dw2/2, -dh2/2), (dw2/2, dh2/2), (-dw2/2, dh2/2)]
    a = math.radians(rot); ca, sa = math.cos(a), math.sin(a)
    q = []
    for (x, y) in pts:
        x += random.uniform(-jit, jit) * dw2; y += random.uniform(-jit, jit) * dh2
        q.append((cx + x * ca - y * sa, cy + x * sa + y * ca))
    # margin check
    xs = [p[0] for p in q]; ys = [p[1] for p in q]
    if min(xs) < 0.04 * W or max(xs) > 0.96 * W or min(ys) < 0.04 * H or max(ys) > 0.96 * H:
        return None
    src = [(0, 0), (dw, 0), (dw, dh), (0, dh)]
    warped = doc.transform((W, H), Image.PERSPECTIVE, persp_coeffs(q, src), Image.BICUBIC)
    mask = Image.new("L", (dw, dh), 255).transform((W, H), Image.PERSPECTIVE, persp_coeffs(q, src), Image.BILINEAR)
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))
    out = bg.copy(); out.paste(warped, (0, 0), mask)
    # soft shadow-ish + camera softness + noise
    out = out.filter(ImageFilter.GaussianBlur(0.7))
    arr = np.asarray(out).astype(np.float32) + np.random.randn(H, W, 3) * 2.5
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)), q

cases = []
def add(name, bgname, doc, n, W=700, H=1000, scale=(0.40, 0.62), rot=(-22, 22), jit=0.04):
    k = 0; tries = 0
    while k < n and tries < 50:
        tries += 1
        bg = bgs[bgname](W, H) if bgname in bgs else (wood(W, H) if bgname == "wood" else Image.new("RGB", (W, H), (60, 62, 70)))
        r = compose(bg, doc, W, H, random.uniform(*scale), random.uniform(*rot), jit)
        if r is None: continue
        img, q = r
        fn = f"bench/{name}_{k:02d}.png"
        img.save(fn)
        cases.append({"file": fn, "name": name, "gt": [{"x": p[0], "y": p[1]} for p in q], "w": W, "h": H})
        k += 1

import os; os.makedirs("bench", exist_ok=True)
add("card1_on_bed2", "bed2", card1, 8)
add("card2_on_bed2", "bed2", card2, 8)
add("card1_on_bed1", "bed1", card1, 8, W=636, H=900)
add("card2_on_bed1", "bed1", card2, 8, W=636, H=900)
add("paper_on_wood", "wood", plain_paper(600, 800), 6)
add("paper_on_dark", "dark", plain_paper(600, 800), 6)
add("card1_big_on_bed2", "bed2", card1, 6, scale=(0.62, 0.80), rot=(-15, 15))

# negatives: bedsheet only (no document)
for i in range(6):
    W, H = 700, 1000
    bgname = "bed2" if i % 2 == 0 else "bed1"
    bg = bgs[bgname](W, H)
    fn = f"bench/neg_{i:02d}.png"; bg.save(fn)
    cases.append({"file": fn, "name": "negative", "gt": None, "w": W, "h": H})

json.dump(cases, open("bench/cases.json", "w"), indent=1)
print(len(cases), "cases")
