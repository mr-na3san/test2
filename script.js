/* ── DOM refs ─────────────────────────────────────────────── */
const feed = document.getElementById('feed');
const overlayCanvas = document.getElementById('overlay');
const ctx = overlayCanvas.getContext('2d');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const fpsDisplay = document.getElementById('fpsDisplay');
const permScreen = document.getElementById('permissionScreen');
const loadingScreen = document.getElementById('loadingScreen');
const loaderLabel = document.getElementById('loaderLabel');
const permError = document.getElementById('permError');
const grantBtn = document.getElementById('grantBtn');
const toggleScanBtn = document.getElementById('toggleScan');
const toggleOverlayBtn = document.getElementById('toggleOverlay');
const toggleSidebarBtn = document.getElementById('toggleSidebar');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const closeSidebarBtn = document.getElementById('closeSidebar');
const noteList = document.getElementById('noteList');
const noteHint = document.getElementById('noteHint');
const copyAllBtn = document.getElementById('copyAll');
const clearAllBtn = document.getElementById('clearAll');

/* ── State ────────────────────────────────────────────────── */
const state = {
  worker: null,
  stream: null,
  scanTimer: null,
  scanning: false,
  processing: false,
  showOverlay: true,
  words: [],
  notes: [],
  noteIdSeq: 0,
  lastScanMs: 0,
  fpsHistory: [],
};

const scanInterval = 500;
const thumbW = 640;
const thumbH = 360;

/* ── Off-screen canvas for frame capture + preprocessing ──── */
const offCanvas = document.createElement('canvas');
offCanvas.width = thumbW;
offCanvas.height = thumbH;
const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

/* ── Status helpers ───────────────────────────────────────── */
function setStatus(label, mode) {
  statusText.textContent = label;
  statusDot.className = '';
  if (mode) statusDot.classList.add(mode);
}

/* ── Toast ────────────────────────────────────────────────── */
let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

/* ── Tesseract worker init ────────────────────────────────── */
async function initWorker() {
  loadingScreen.classList.remove('hidden');
  setStatus('Loading OCR engine…', '');
  try {
    state.worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'loading tesseract core') loaderLabel.textContent = 'Loading Tesseract core…';
        if (m.status === 'initializing tesseract') loaderLabel.textContent = 'Initializing engine…';
        if (m.status === 'loading language traineddata') loaderLabel.textContent = 'Loading English model…';
        if (m.status === 'initialized api') loaderLabel.textContent = 'Ready!';
      }
    });
    await state.worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.AUTO,
    });
    loadingScreen.classList.add('hidden');
    setStatus('Ready', 'ready');
    startScan();
  } catch (err) {
    loadingScreen.classList.add('hidden');
    setStatus('OCR engine failed', 'error');
    console.error('Worker init error:', err);
  }
}

/* ── Camera access ────────────────────────────────────────── */
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    state.stream = stream;
    feed.srcObject = stream;
    await feed.play();
    permScreen.classList.add('hidden');
    resizeOverlay();
    await initWorker();
  } catch (err) {
    permError.textContent = err.name === 'NotAllowedError'
      ? 'Permission denied. Please allow camera access in your browser settings.'
      : `Camera error: ${err.message}`;
    permError.classList.remove('hidden');
    setStatus('Camera error', 'error');
  }
}

grantBtn.addEventListener('click', startCamera);

/* ── Resize overlay to match video ───────────────────────── */
function resizeOverlay() {
  const vp = document.getElementById('viewport');
  overlayCanvas.width = vp.offsetWidth;
  overlayCanvas.height = vp.offsetHeight;
}

window.addEventListener('resize', () => {
  resizeOverlay();
  redrawBoxes();
});

/* ── Frame preprocessing: grayscale + contrast ───────────── */
function preprocessFrame() {
  const vw = feed.videoWidth || thumbW;
  const vh = feed.videoHeight || thumbH;
  offCanvas.width = thumbW;
  offCanvas.height = Math.round(thumbW * (vh / vw));

  offCtx.drawImage(feed, 0, 0, offCanvas.width, offCanvas.height);

  const img = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const contrast = Math.min(255, Math.max(0, ((gray - 128) * 1.5) + 128 + 20));
    d[i] = d[i + 1] = d[i + 2] = contrast;
  }

  offCtx.putImageData(img, 0, 0);
  return offCanvas;
}

/* ── OCR scan cycle ───────────────────────────────────────── */
async function runOcr() {
  if (state.processing || !state.worker || !feed.videoWidth) return;
  if (!state.scanning) return;

  state.processing = true;
  setStatus('Processing…', 'processing');

  const now = performance.now();
  const elapsed = now - state.lastScanMs;
  if (state.lastScanMs) {
    const fps = Math.round(1000 / elapsed);
    state.fpsHistory.push(fps);
    if (state.fpsHistory.length > 10) state.fpsHistory.shift();
    const avg = Math.round(state.fpsHistory.reduce((a, b) => a + b, 0) / state.fpsHistory.length);
    fpsDisplay.textContent = `${avg} scan/s`;
  }
  state.lastScanMs = now;

  try {
    const frame = preprocessFrame();
    const result = await state.worker.recognize(frame);
    state.words = extractWords(result, frame.width, frame.height);
    if (state.showOverlay) redrawBoxes();
    setStatus('Scanning', 'scanning');
  } catch (err) {
    console.warn('OCR error:', err);
    setStatus('OCR error', 'error');
  }

  state.processing = false;
}

/* ── Extract word bounding boxes from Tesseract result ───── */
function extractWords(result, frameW, frameH) {
  const vp = document.getElementById('viewport');
  const scaleX = vp.offsetWidth / frameW;
  const scaleY = vp.offsetHeight / frameH;

  const words = [];
  const lines = result?.data?.lines || [];

  lines.forEach(line => {
    (line.words || []).forEach(word => {
      const text = word.text?.trim();
      if (!text || text.length < 2) return;
      if (word.confidence < 40) return;

      const { x0, y0, x1, y1 } = word.bbox;
      words.push({
        text,
        x: Math.round(x0 * scaleX),
        y: Math.round(y0 * scaleY),
        w: Math.round((x1 - x0) * scaleX),
        h: Math.round((y1 - y0) * scaleY),
        conf: word.confidence,
      });
    });
  });

  return words;
}

/* ── Draw bounding boxes via canvas ──────────────────────── */
function redrawBoxes() {
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!state.showOverlay) return;

  state.words.forEach(w => {
    const alpha = Math.min(1, (w.conf - 40) / 60);
    ctx.strokeStyle = `rgba(0,229,255,${0.35 + alpha * 0.55})`;
    ctx.fillStyle = `rgba(0,229,255,${0.03 + alpha * 0.05})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(w.x, w.y, w.w, w.h, 3);
    ctx.fill();
    ctx.stroke();
  });
}

/* ── Canvas click → word hit test ────────────────────────── */
overlayCanvas.addEventListener('click', e => {
  if (!state.showOverlay) return;
  const rect = overlayCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const word = state.words.find(w => x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h);
  if (word) handleWordClick(word, e.shiftKey, x, y);
});

overlayCanvas.addEventListener('touchend', e => {
  if (!state.showOverlay) return;
  const touch = e.changedTouches[0];
  const rect = overlayCanvas.getBoundingClientRect();
  const x = touch.clientX - rect.left;
  const y = touch.clientY - rect.top;
  const word = state.words.find(w => x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h);
  if (word) handleWordClick(word, e.shiftKey, x, y);
}, { passive: true });

/* ── Word click: add to notes ────────────────────────────── */
function handleWordClick(word, shiftKey, cx, cy) {
  flashAt(word.x, word.y, word.w, word.h);

  if (shiftKey && state.notes.length > 0) {
    const last = state.notes[state.notes.length - 1];
    last.text += ' ' + word.text;
    renderNotes();
    showToast(`Appended: ${word.text}`);
  } else {
    const note = { id: ++state.noteIdSeq, text: word.text };
    state.notes.push(note);
    renderNotes();
    showToast(`Saved: ${word.text}`);
    if (!sidebar.classList.contains('open')) {
      toggleSidebarBtn.classList.add('active');
      setTimeout(() => toggleSidebarBtn.classList.remove('active'), 600);
    }
  }
}

/* ── Flash animation at word box ─────────────────────────── */
function flashAt(x, y, w, h) {
  const el = document.createElement('div');
  el.className = 'clickFlash';
  const vp = document.getElementById('viewport');
  Object.assign(el.style, {
    left: x + 'px',
    top: y + 'px',
    width: w + 'px',
    height: h + 'px',
  });
  vp.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ── Notes rendering ──────────────────────────────────────── */
function renderNotes() {
  noteList.innerHTML = '';
  noteHint.style.display = state.notes.length ? 'none' : '';

  state.notes.forEach(note => {
    const item = document.createElement('div');
    item.className = 'noteItem';
    item.dataset.id = note.id;

    const ta = document.createElement('textarea');
    ta.className = 'noteText';
    ta.value = note.text;
    ta.rows = 1;
    autoGrow(ta);
    ta.addEventListener('input', () => {
      note.text = ta.value;
      autoGrow(ta);
    });

    const del = document.createElement('button');
    del.className = 'noteDelete';
    del.textContent = '✕';
    del.title = 'Delete note';
    del.addEventListener('click', () => deleteNote(note.id));

    item.appendChild(ta);
    item.appendChild(del);
    noteList.appendChild(item);
  });

  noteList.scrollTop = noteList.scrollHeight;
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function deleteNote(id) {
  state.notes = state.notes.filter(n => n.id !== id);
  renderNotes();
}

/* ── Sidebar controls ─────────────────────────────────────── */
function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('show');
  toggleSidebarBtn.classList.add('active');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('show');
  toggleSidebarBtn.classList.remove('active');
}

toggleSidebarBtn.addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});

closeSidebarBtn.addEventListener('click', closeSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);

copyAllBtn.addEventListener('click', () => {
  if (!state.notes.length) { showToast('No notes to copy'); return; }
  const text = state.notes.map(n => n.text).join('\n');
  navigator.clipboard.writeText(text).then(() => showToast('Copied!')).catch(() => showToast('Copy failed'));
});

clearAllBtn.addEventListener('click', () => {
  if (!state.notes.length) return;
  state.notes = [];
  renderNotes();
  showToast('All notes cleared');
});

/* ── Scan controls ────────────────────────────────────────── */
function startScan() {
  if (state.scanning) return;
  state.scanning = true;
  toggleScanBtn.classList.add('active');
  setStatus('Scanning', 'scanning');
  state.scanTimer = setInterval(runOcr, scanInterval);
}

function stopScan() {
  state.scanning = false;
  toggleScanBtn.classList.remove('active');
  clearInterval(state.scanTimer);
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  state.words = [];
  setStatus('Stopped', 'stopped');
  fpsDisplay.textContent = '';
}

toggleScanBtn.addEventListener('click', () => {
  state.scanning ? stopScan() : startScan();
});

/* ── Overlay toggle ───────────────────────────────────────── */
toggleOverlayBtn.addEventListener('click', () => {
  state.showOverlay = !state.showOverlay;
  toggleOverlayBtn.classList.toggle('active', state.showOverlay);
  if (!state.showOverlay) ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  else redrawBoxes();
  showToast(state.showOverlay ? 'Overlay on' : 'Overlay off');
});

/* ── Init ─────────────────────────────────────────────────── */
(function init() {
  resizeOverlay();
  setStatus('Awaiting camera…', '');

  if (!navigator.mediaDevices?.getUserMedia) {
    permError.textContent = 'Your browser does not support camera access. Please use Chrome, Firefox, or Safari.';
    permError.classList.remove('hidden');
    grantBtn.disabled = true;
    setStatus('Browser not supported', 'error');
    return;
  }

  navigator.permissions?.query({ name: 'camera' }).then(perm => {
    if (perm.state === 'granted') {
      permScreen.classList.add('hidden');
      startCamera();
    }
  }).catch(() => {});

  loadingScreen.classList.add('hidden');
  toggleOverlayBtn.classList.add('active');
  renderNotes();
})();
