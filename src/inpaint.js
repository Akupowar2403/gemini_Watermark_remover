// Onion-peel inpainting, sized for the small regions a watermark occupies.
// The masked area is filled layer by layer inward from its boundary, each pixel
// a distance-weighted average of the neighbours already known — the same idea as
// OpenCV's INPAINT_TELEA without pulling in 9MB of opencv.js.
//
// This runs on every frame of a video during a realtime recording, so it is
// written to keep to a frame budget: weights come from a table, the working set
// is a flat index list, and nothing scans outside the mask's bounding box.

const WEIGHTS = new Map();

// w(d) = 1/d^3, indexed by offset within the radius window.
function weightTable(radius) {
  let t = WEIGHTS.get(radius);
  if (t) return t;
  const span = 2 * radius + 1;
  t = new Float32Array(span * span);
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      t[(dy + radius) * span + dx + radius] =
        d2 === 0 || d2 > r2 ? 0 : 1 / (d2 * Math.sqrt(d2));
    }
  }
  WEIGHTS.set(radius, t);
  return t;
}

function inpaint(rgba, w, h, mask, radius = 5) {
  const n = w * h;
  const known = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]) count++;
    else known[i] = 1;
  }
  if (!count) return;

  const todo = new Int32Array(count);
  let bx0 = w, by0 = h, bx1 = 0, by1 = 0, t = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    todo[t++] = i;
    const x = i % w, y = (i / w) | 0;
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
  }

  const table = weightTable(radius);
  const span = 2 * radius + 1;
  const front = new Int32Array(count);
  let nTodo = count;

  while (nTodo) {
    let nf = 0;
    for (let k = 0; k < nTodo; k++) {
      const p = todo[k], x = p % w, y = (p / w) | 0;
      if ((x > 0 && known[p - 1]) || (x < w - 1 && known[p + 1]) ||
          (y > 0 && known[p - w]) || (y < h - 1 && known[p + w])) front[nf++] = p;
    }
    if (!nf) break;

    for (let k = 0; k < nf; k++) {
      const p = front[k], px = p % w, py = (p / w) | 0;
      const x0 = Math.max(0, px - radius), x1 = Math.min(w - 1, px + radius);
      const y0 = Math.max(0, py - radius), y1 = Math.min(h - 1, py + radius);
      let r = 0, g = 0, b = 0, tw = 0;
      for (let y = y0; y <= y1; y++) {
        const row = y * w, trow = (y - py + radius) * span - px + radius;
        for (let x = x0; x <= x1; x++) {
          const q = row + x;
          if (!known[q]) continue;
          const wt = table[trow + x];
          if (wt === 0) continue;
          const o = q << 2;
          r += wt * rgba[o]; g += wt * rgba[o + 1]; b += wt * rgba[o + 2];
          tw += wt;
        }
      }
      const o = p << 2;
      rgba[o] = r / tw; rgba[o + 1] = g / tw; rgba[o + 2] = b / tw;
    }

    // the whole layer commits at once, so pixels in a layer never feed off each other
    for (let k = 0; k < nf; k++) known[front[k]] = 1;
    let m = 0;
    for (let k = 0; k < nTodo; k++) {
      const p = todo[k];
      if (!known[p]) todo[m++] = p;
    }
    nTodo = m;
  }

  smoothFilled(rgba, w, h, mask, bx0, by0, bx1, by1, 6);
}

// The peel leaves faint concentric banding; a few box passes over the filled
// pixels only (reading from a snapshot) blend it away.
function smoothFilled(rgba, w, h, mask, bx0, by0, bx1, by1, iterations) {
  const sx0 = Math.max(0, bx0 - 1), sy0 = Math.max(0, by0 - 1);
  const sx1 = Math.min(w - 1, bx1 + 1), sy1 = Math.min(h - 1, by1 + 1);
  const sw = sx1 - sx0 + 1, sh = sy1 - sy0 + 1;
  const snap = new Float32Array(sw * sh * 3);

  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const o = ((y + sy0) * w + x + sx0) << 2, s = (y * sw + x) * 3;
        snap[s] = rgba[o]; snap[s + 1] = rgba[o + 1]; snap[s + 2] = rgba[o + 2];
      }
    }
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        if (!mask[y * w + x]) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy - sy0;
          if (ny < 0 || ny >= sh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx - sx0;
            if (nx < 0 || nx >= sw) continue;
            const s = (ny * sw + nx) * 3;
            r += snap[s]; g += snap[s + 1]; b += snap[s + 2]; c++;
          }
        }
        const o = (y * w + x) << 2;
        rgba[o] = r / c; rgba[o + 1] = g / c; rgba[o + 2] = b / c;
      }
    }
  }
}
