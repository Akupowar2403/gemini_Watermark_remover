const video = document.getElementById('video');
const preview = document.getElementById('preview');
const pctx = preview.getContext('2d', { willReadFrequently: true });
const stage = document.getElementById('stage');
const boxEl = document.getElementById('box');
const statusEl = document.getElementById('status');
const downloadEl = document.getElementById('download');
const runBtn = document.getElementById('run');
const compareBtn = document.getElementById('compare');

let source = null;     // the <video>, or an Image once one is loaded
let isVideo = true;
let srcType = '';
let box = null;        // selection in source pixels
let scale = 1;         // display px per source px
let showFixed = true;
let busy = false;

const accepted = (f) => f.type.startsWith('video/') || f.type.startsWith('image/');

document.getElementById('file').addEventListener('change', (e) => {
  if (e.target.files[0]) load(e.target.files[0]);
});

const drop = document.getElementById('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = [...e.dataTransfer.files].find(accepted);
  if (f) load(f);
});

async function load(file) {
  downloadEl.hidden = true;
  isVideo = file.type.startsWith('video/');
  srcType = file.type;
  const url = URL.createObjectURL(file);

  let w, h;
  if (isVideo) {
    video.src = url;
    await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
    source = video;
    w = video.videoWidth; h = video.videoHeight;
  } else {
    const img = new Image();
    img.src = url;
    await img.decode();
    source = img;
    w = img.naturalWidth; h = img.naturalHeight;
  }

  const maxW = Math.min(880, window.innerWidth - 48);
  scale = Math.min(1, maxW / w);
  preview.width = w;
  preview.height = h;
  preview.style.width = `${w * scale}px`;
  stage.style.width = `${w * scale}px`;

  document.getElementById('editor').hidden = false;
  drop.classList.add('compact');
  runBtn.textContent = isVideo ? 'Remove watermark' : 'Remove & save';

  if (isVideo) await seekTo(video, video.duration / 2);
  await autoDetect();
}

async function autoDetect() {
  statusEl.textContent = 'Looking for a watermark…';
  // let the status paint before the scan blocks the thread
  await new Promise(requestAnimationFrame);
  const r = isVideo ? await detectWatermark(video) : detectInImage(source);
  box = r.box;
  statusEl.textContent = r.found
    ? 'Found it. Drag or resize the box if it is off.'
    : 'Nothing obvious found — showing the usual Gemini position. Drag the box onto the watermark.';
  render();
}

document.getElementById('redetect').addEventListener('click', () => {
  if (!busy) autoDetect();
});

compareBtn.addEventListener('click', () => {
  showFixed = !showFixed;
  compareBtn.textContent = showFixed ? 'Show original' : 'Show result';
  render();
});

// Read a margin of untouched pixels around the box so the fill has context.
// The peel never looks further than `radius` outside the mask, so a few px past
// that is all the region needs — and keeping it tight is what holds the frame rate.
function fixRegion(ctx) {
  const m = 11;
  const rx = Math.max(0, box.x - m), ry = Math.max(0, box.y - m);
  const rw = Math.min(ctx.canvas.width, box.x + box.w + m) - rx;
  const rh = Math.min(ctx.canvas.height, box.y + box.h + m) - ry;

  const img = ctx.getImageData(rx, ry, rw, rh);
  // A diamond inscribed in the box, not the box itself: the sparkle is diamond
  // shaped, and masking its bounding rectangle destroys twice the area for no
  // gain — visibly eating detail in the corners that the fill then has to invent.
  const mask = new Uint8Array(rw * rh);
  const cx = box.x - rx + box.w / 2 - 0.5, cy = box.y - ry + box.h / 2 - 0.5;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const u = (x - cx) / (box.w / 2), v = (y - cy) / (box.h / 2);
      if (Math.abs(u) + Math.abs(v) <= 1) mask[y * rw + x] = 1;
    }
  }
  inpaint(img.data, rw, rh, mask, 5);
  ctx.putImageData(img, rx, ry);
}

function render() {
  pctx.drawImage(source, 0, 0, preview.width, preview.height);
  if (box && showFixed) fixRegion(pctx);
  if (!box) return;
  boxEl.hidden = false;
  boxEl.style.left = `${box.x * scale}px`;
  boxEl.style.top = `${box.y * scale}px`;
  boxEl.style.width = `${box.w * scale}px`;
  boxEl.style.height = `${box.h * scale}px`;
}

// --- dragging / resizing the box -------------------------------------------

boxEl.addEventListener('pointerdown', (e) => {
  if (busy) return;
  e.preventDefault();
  const handle = e.target.dataset.h || 'move';
  const start = { x: e.clientX, y: e.clientY, ...box };
  boxEl.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const dx = (ev.clientX - start.x) / scale;
    const dy = (ev.clientY - start.y) / scale;
    let { x, y, w, h } = start;
    if (handle === 'move') { x += dx; y += dy; }
    else {
      if (handle.includes('w')) { x += dx; w -= dx; }
      if (handle.includes('e')) { w += dx; }
      if (handle.includes('n')) { y += dy; h -= dy; }
      if (handle.includes('s')) { h += dy; }
    }
    w = Math.max(8, w); h = Math.max(8, h);
    box = {
      x: Math.round(Math.min(Math.max(0, x), preview.width - w)),
      y: Math.round(Math.min(Math.max(0, y), preview.height - h)),
      w: Math.round(w), h: Math.round(h),
    };
    render();
  };
  const onUp = () => {
    boxEl.removeEventListener('pointermove', onMove);
    boxEl.removeEventListener('pointerup', onUp);
  };
  boxEl.addEventListener('pointermove', onMove);
  boxEl.addEventListener('pointerup', onUp);
});

// --- processing -------------------------------------------------------------

const MIME = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
].find((t) => MediaRecorder.isTypeSupported(t));

let audioStream = null;

runBtn.addEventListener('click', async () => {
  if (busy || !box) return;
  busy = true;
  runBtn.disabled = true;
  downloadEl.hidden = true;
  boxEl.hidden = true;

  const out = document.createElement('canvas');
  out.width = preview.width;
  out.height = preview.height;
  const octx = out.getContext('2d', { willReadFrequently: true });

  if (!isVideo) {
    octx.drawImage(source, 0, 0);
    fixRegion(octx);
    // PNG unless the original was a JPEG, so a photo is not re-compressed into
    // a file several times its own size just to strip one mark off it
    const type = srcType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((r) => out.toBlob(r, type, 0.95));
    downloadEl.href = URL.createObjectURL(blob);
    downloadEl.download = type === 'image/jpeg' ? 'clean.jpg' : 'clean.png';
    downloadEl.hidden = false;
    statusEl.textContent = `Done — ${(blob.size / 1048576).toFixed(1)} MB, watermark removed.`;
    busy = false;
    runBtn.disabled = false;
    render();
    return;
  }

  // Route the element's audio through WebAudio rather than the speakers, so the
  // recorder gets the original track without the clip playing out loud.
  if (!audioStream) {
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    ac.createMediaElementSource(video).connect(dest);
    audioStream = dest.stream;
  }

  const tracks = [...out.captureStream().getVideoTracks(), ...audioStream.getAudioTracks()];
  const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: MIME, videoBitsPerSecond: 12e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const done = new Promise((r) => (rec.onstop = r));

  await seekTo(video, 0);
  octx.drawImage(video, 0, 0);   // seed the stream so frame 0 is never blank
  fixRegion(octx);
  rec.start();
  video.play();

  const onFrame = () => {
    octx.drawImage(video, 0, 0);
    fixRegion(octx);
    statusEl.textContent = `Processing… ${Math.round((video.currentTime / video.duration) * 100)}%`;
    if (!video.ended) video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);

  await new Promise((r) => video.addEventListener('ended', r, { once: true }));
  rec.stop();
  await done;

  const ext = MIME.startsWith('video/mp4') ? 'mp4' : 'webm';
  downloadEl.href = URL.createObjectURL(new Blob(chunks, { type: MIME }));
  downloadEl.download = `clean.${ext}`;
  downloadEl.hidden = false;
  statusEl.textContent = `Done — ${ext.toUpperCase()}, watermark removed.`;

  busy = false;
  runBtn.disabled = false;
  await seekTo(video, video.duration / 2);
  render();
});
