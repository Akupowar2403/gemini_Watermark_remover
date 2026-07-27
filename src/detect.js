// Finding the watermark without being told where it is.
//
// A watermark is a bright, semi-transparent stamp at a fixed position, so its
// pixels are floored: obs = (1-a)*background + a*white. However dark the video
// gets behind it, that region never goes as dark as its surroundings. Taking the
// per-pixel MINIMUM across sampled frames therefore erases the moving picture and
// leaves the watermark standing alone.
//
// (Temporal variance is the more obvious signal — the stamp is static, so its
// pixels should vary less. It does not survive contact with real clips: on a
// busy background a lightly-alpha'd mark barely suppresses variance at all,
// while genuinely flat areas of the scene look just as static and win instead.)
//
// The search covers the four corners, which is where generators put their mark.

// Where Gemini puts the sparkle, used when detection is inconclusive so there is
// always a sensible starting box. Measured on a 1280x720 clip and a 2816x1536
// still: the centre sits an equal distance in from the right and bottom edges,
// and both that margin and the mark's size scale with the HEIGHT, not the width
// (0.167/0.157 of H and 0.065/0.062 of H respectively). Expressing x as a
// fraction of width instead — the obvious first guess — lands 32px out on a
// 16:9 still, because the same mark is simply further from a wider frame's edge.
const INSET = 0.162;   // centre's distance from either edge, in heights
const SIZE = 0.072;    // box side, in heights, with room around the mark

// Contrast a pixel must clear over its local background to count as watermark.
// The two paths feed different maps in, so they need different bars: the video's
// temporal minimum is already background-suppressed and lands ~28 above local,
// while a still's raw luminance keeps the scene in play and needs a higher one.
const VIDEO = { margin: 12, ratio: 1.5 };
const IMAGE = { margin: 30, ratio: 1.25 };

function presetBox(w, h) {
  const s = Math.round(SIZE * h);
  return {
    x: Math.round(w - INSET * h - s / 2),
    y: Math.round(h - INSET * h - s / 2),
    w: s, h: s,
  };
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    video.addEventListener('seeked', resolve, { once: true });
    video.currentTime = Math.min(Math.max(t, 0), video.duration - 0.001);
  });
}

function cornersOf(W, H) {
  const cw = Math.round(W * 0.3), ch = Math.round(H * 0.3);
  return { cw, ch, at: [
    { x: W - cw, y: H - ch }, { x: 0, y: H - ch },
    { x: W - cw, y: 0 }, { x: 0, y: 0 },
  ] };
}

function readCorner(ctx, c, cw, ch) {
  const d = ctx.getImageData(c.x, c.y, cw, ch).data;
  const out = new Float32Array(cw * ch);
  for (let i = 0; i < out.length; i++) {
    const o = i << 2;
    out[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  }
  return out;
}

// Given one background-suppressed map per corner, pick the most watermark-like
// blob in any of them. Every candidate from every corner competes, rather than
// one-per-corner: a single sprawling blob would otherwise hide the real mark
// sitting beside it.
function bestCandidate(maps, at, cw, ch, H, limits) {
  const n = cw * ch;
  const radius = Math.max(12, Math.round(H * 0.033));
  let best = null;
  at.forEach((c, ci) => {
    const map = maps[ci];
    const local = boxBlur(map, cw, ch, radius);
    const flag = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (map[i] > local[i] + limits.margin && map[i] > local[i] * limits.ratio) flag[i] = 1;
    }
    for (const b of findBlobs(flag, cw, ch)) {
      // reject specks, and anything large enough to be the scene itself
      if (b.count < n * 0.0004 || b.count > n * 0.06) continue;
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
      // A four-point star measures square and fills about a third of its box.
      // This is what separates it from a caption bar, which is the other thing
      // in a corner that reliably stands out from its background.
      const aspect = bw / bh, fill = b.count / (bw * bh);
      if (aspect < 0.65 || aspect > 1.55 || fill < 0.18 || fill > 0.6) continue;

      // Then the shape itself: ask whether the blob fits the diamond we would
      // paint over it. A star hugs that diamond almost exactly, where a lit
      // window or a sign — square or round, and the thing that actually beats
      // the mark on a photograph — spills well outside it.
      let inside = 0;
      const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
      for (const p of b.px) {
        const u = ((p % cw) - mx) / (bw / 2), v = (((p / cw) | 0) - my) / (bh / 2);
        if (Math.abs(u) + Math.abs(v) <= 1.05) inside++;
      }
      if (inside / b.count < 0.85) continue;

      let score = 0;
      for (const p of b.px) score += map[p] - local[p];
      if (!best || score > best.score) {
        best = { score, x: c.x + b.x0, y: c.y + b.y0, w: bw, h: bh };
      }
    }
  });
  return best;
}

// Enough margin to swallow the mark's soft anti-aliased rim, which falls under
// the detection threshold, and no more. Scaled to the mark rather than to the
// frame: a fraction of frame size turns a correctly found 95px mark on a large
// still into a 130px hole, nearly double the area, and every extra pixel is
// scene the fill then has to invent.
function pad(best, W, H) {
  if (!best) return { box: presetBox(W, H), found: false };
  const p = Math.max(2, Math.round(0.05 * Math.max(best.w, best.h)));
  return {
    box: {
      x: Math.max(0, best.x - p),
      y: Math.max(0, best.y - p),
      w: Math.min(W, best.w + 2 * p),
      h: Math.min(H, best.h + 2 * p),
    },
    found: true,
  };
}

async function detectWatermark(video, samples = 10) {
  const W = video.videoWidth, H = video.videoHeight;
  const { cw, ch, at } = cornersOf(W, H);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const maps = at.map(() => new Float32Array(cw * ch).fill(Infinity));
  const resume = video.currentTime;
  for (let k = 0; k < samples; k++) {
    await seekTo(video, ((k + 0.5) / samples) * video.duration);
    ctx.drawImage(video, 0, 0);
    at.forEach((c, ci) => {
      const lum = readCorner(ctx, c, cw, ch), m = maps[ci];
      for (let i = 0; i < m.length; i++) if (lum[i] < m[i]) m[i] = lum[i];
    });
  }
  await seekTo(video, resume);

  return pad(bestCandidate(maps, at, cw, ch, H, VIDEO), W, H);
}

// A still has no temporal signal to strip the scene away, so the map is just
// luminance and the scene competes with the mark. It works anyway because the
// mark on a still is close to opaque, and the shape test carries the rest.
function detectInImage(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const { cw, ch, at } = cornersOf(W, H);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const maps = at.map((c) => readCorner(ctx, c, cw, ch));
  return pad(bestCandidate(maps, at, cw, ch, H, IMAGE), W, H);
}

// Separable, and each pass slides a running total rather than re-adding the
// window at every pixel — the radius scales with image size, so the naive form
// costs 90s on a 2816x1536 still where this costs a fraction of a second.
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0, cnt = 0;
    for (let x = 0; x <= r && x < w; x++) { sum += src[row + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / cnt;
      const add = x + r + 1, drop = x - r;
      if (add < w) { sum += src[row + add]; cnt++; }
      if (drop >= 0) { sum -= src[row + drop]; cnt--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0, cnt = 0;
    for (let y = 0; y <= r && y < h; y++) { sum += tmp[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / cnt;
      const add = y + r + 1, drop = y - r;
      if (add < h) { sum += tmp[add * w + x]; cnt++; }
      if (drop >= 0) { sum -= tmp[drop * w + x]; cnt--; }
    }
  }
  return out;
}

function findBlobs(flag, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let start = 0; start < flag.length; start++) {
    if (!flag[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const px = [];
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      px.push(p);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && flag[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    out.push({ count: px.length, px, x0, y0, x1, y1 });
  }
  return out;
}
