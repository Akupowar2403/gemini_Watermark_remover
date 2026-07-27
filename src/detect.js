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

// Gemini/Veo sparkle, measured on a 1280x720 clip. Used when detection is
// inconclusive so there is always a sensible starting box.
const PRESET = { cx: 0.9031, cy: 0.8375, hw: 0.030, hh: 0.042 };

const BLUR = 24;      // radius the local background level is measured over
const MARGIN = 12;    // how far above that level a pixel must sit, absolute
const RATIO = 1.5;    // ...and relative, so the test holds on bright footage

function presetBox(w, h) {
  return {
    x: Math.round((PRESET.cx - PRESET.hw) * w),
    y: Math.round((PRESET.cy - PRESET.hh) * h),
    w: Math.round(2 * PRESET.hw * w),
    h: Math.round(2 * PRESET.hh * h),
  };
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    video.addEventListener('seeked', resolve, { once: true });
    video.currentTime = Math.min(Math.max(t, 0), video.duration - 0.001);
  });
}

async function detectWatermark(video, samples = 10) {
  const W = video.videoWidth, H = video.videoHeight;
  const cw = Math.round(W * 0.3), ch = Math.round(H * 0.3);
  const corners = [
    { x: W - cw, y: H - ch }, { x: 0, y: H - ch },
    { x: W - cw, y: 0 }, { x: 0, y: 0 },
  ];

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const n = cw * ch;
  const lo = corners.map(() => new Float32Array(n).fill(Infinity));

  const resume = video.currentTime;
  for (let k = 0; k < samples; k++) {
    await seekTo(video, ((k + 0.5) / samples) * video.duration);
    ctx.drawImage(video, 0, 0);
    corners.forEach((c, ci) => {
      const d = ctx.getImageData(c.x, c.y, cw, ch).data;
      const m = lo[ci];
      for (let i = 0; i < n; i++) {
        const o = i << 2;
        const l = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
        if (l < m[i]) m[i] = l;
      }
    });
  }
  await seekTo(video, resume);

  // Every candidate from every corner competes, rather than one-per-corner:
  // a single sprawling blob would otherwise hide the real mark beside it.
  let best = null;
  corners.forEach((c, ci) => {
    const mn = lo[ci];
    const local = boxBlur(mn, cw, ch, BLUR);
    const flag = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (mn[i] > local[i] + MARGIN && mn[i] > local[i] * RATIO) flag[i] = 1;
    }
    for (const b of findBlobs(flag, cw, ch)) {
      // reject specks, and anything large enough to be the scene itself
      if (b.count < n * 0.0004 || b.count > n * 0.06) continue;
      let sum = 0;
      for (const p of b.px) sum += mn[p] - local[p];
      const score = (sum / b.count) * b.count;
      if (!best || score > best.score) {
        best = {
          score,
          x: c.x + b.x0, y: c.y + b.y0,
          w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1,
        };
      }
    }
  });

  if (!best) return { box: presetBox(W, H), found: false };

  const pad = Math.round(Math.max(W, H) * 0.006);
  return {
    box: {
      x: Math.max(0, best.x - pad),
      y: Math.max(0, best.y - pad),
      w: Math.min(W, best.w + 2 * pad),
      h: Math.min(H, best.h + 2 * pad),
    },
    found: true,
  };
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += src[y * w + k]; c++; }
      tmp[y * w + x] = s / c;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; c++; }
      out[y * w + x] = s / c;
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
