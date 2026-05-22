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
const splashScreen = document.getElementById('splashScreen');
const toastEl = document.getElementById('toast');

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
  touchHandled: false,
};

const scanInterval = 500;
const thumbW = 640;

const offCanvas = document.createElement('canvas');
const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

function setStatus(label, mode) {
  statusText.textContent = label;
  statusDot.className = '';
  if (mode) statusDot.classList.add(mode);
}

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2000);
}

async function initWorker() {
  loadingScreen.classList.remove('hidden');
  setStatus('Loading OCR engine…', '');
  try {
    state.worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'loading tesseract core') loaderLabel.textContent = 'Loading Tesseract core…';
        if (m.status === 'initializing tesseract') loaderLabel.textContent = 'Initializing engine…';
        if (m.status === 'loading language traineddata') loaderLabel.textContent = 'Loading English model…';
        if (m.status === 'initialized api') loaderLabel.textContent = 'Almost ready…';
      }
    });
    await state.worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
    loadingScreen.classList.add('hidden');
    setStatus('Ready', 'ready');
    startScan();
  } catch (err) {
    loadingScreen.classList.add('hidden');
    setStatus('OCR engine failed', 'error');
  }
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
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

function resizeOverlay() {
  const vp = document.getElementById('viewport');
  overlayCanvas.width = vp.offsetWidth;
  overlayCanvas.height = vp.offsetHeight;
}

window.addEventListener('resize', () => { resizeOverlay(); redrawBoxes(); });

function preprocessFrame() {
  const vw = feed.videoWidth || thumbW;
  const vh = feed.videoHeight || thumbW * 0.5625;
  offCanvas.width = thumbW;
  offCanvas.height = Math.round(thumbW * (vh / vw));
  offCtx.drawImage(feed, 0, 0, offCanvas.width, offCanvas.height);
  const img = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const c = Math.min(255, Math.max(0, ((g - 128) * 1.5) + 148));
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  offCtx.putImageData(img, 0, 0);
  return offCanvas;
}

async function runOcr() {
  if (state.processing || !state.worker || !feed.videoWidth || !state.scanning) return;
  state.processing = true;
  setStatus('Processing…', 'processing');
  const now = performance.now();
  if (state.lastScanMs) {
    const fps = Math.round(1000 / (now - state.lastScanMs));
    state.fpsHistory.push(fps);
    if (state.fpsHistory.length > 10) state.fpsHistory.shift();
    const avg = Math.round(state.fpsHistory.reduce((a, b) => a + b, 0) / state.fpsHistory.length);
    fpsDisplay.textContent = `${avg}/s`;
  }
  state.lastScanMs = now;
  try {
    const frame = preprocessFrame();
    const result = await state.worker.recognize(frame);
    state.words = extractWords(result, frame.width, frame.height);
    if (state.showOverlay) redrawBoxes();
    setStatus('Scanning', 'scanning');
  } catch (_) {
    setStatus('OCR error', 'error');
  }
  state.processing = false;
}

function extractWords(result, frameW, frameH) {
  const vp = document.getElementById('viewport');
  const scaleX = vp.offsetWidth / frameW;
  const scaleY = vp.offsetHeight / frameH;
  const words = [];
  (result?.data?.lines || []).forEach(line => {
    (line.words || []).forEach(word => {
      const text = word.text?.trim();
      if (!text || text.length < 2 || word.confidence < 40) return;
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

function redrawBoxes() {
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!state.showOverlay) return;
  state.words.forEach(w => {
    const a = Math.min(1, (w.conf - 40) / 60);
    ctx.strokeStyle = `rgba(0,229,255,${0.3 + a * 0.6})`;
    ctx.fillStyle = `rgba(0,229,255,${0.02 + a * 0.06})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(w.x, w.y, w.w, w.h, 3);
    ctx.fill();
    ctx.stroke();
  });
}

function hitWord(x, y) {
  return state.words.find(w => x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h);
}

overlayCanvas.addEventListener('click', e => {
  if (!state.showOverlay || state.touchHandled) { state.touchHandled = false; return; }
  const r = overlayCanvas.getBoundingClientRect();
  const word = hitWord(e.clientX - r.left, e.clientY - r.top);
  if (word) handleWordClick(word, e.shiftKey, word.x, word.y);
});

overlayCanvas.addEventListener('touchend', e => {
  if (!state.showOverlay) return;
  state.touchHandled = true;
  const t = e.changedTouches[0];
  const r = overlayCanvas.getBoundingClientRect();
  const word = hitWord(t.clientX - r.left, t.clientY - r.top);
  if (word) handleWordClick(word, false, word.x, word.y);
}, { passive: true });

function handleWordClick(word, shiftKey, fx, fy) {
  flashAt(word.x, word.y, word.w, word.h);
  if (shiftKey && state.notes.length > 0) {
    const last = state.notes[state.notes.length - 1];
    last.text += ' ' + word.text;
    renderNotes();
    showToast(`+ ${word.text}`);
  } else {
    state.notes.push({ id: ++state.noteIdSeq, text: word.text });
    renderNotes();
    showToast(`Saved: "${word.text}"`);
  }
}

function flashAt(x, y, w, h) {
  const el = document.createElement('div');
  el.className = 'clickFlash';
  Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  document.getElementById('viewport').appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function renderNotes() {
  noteList.innerHTML = '';
  noteHint.style.display = state.notes.length ? 'none' : '';
  state.notes.forEach(note => {
    const item = document.createElement('div');
    item.className = 'noteItem';

    const ta = document.createElement('textarea');
    ta.className = 'noteText';
    ta.value = note.text;
    ta.rows = 1;
    autoGrow(ta);
    ta.addEventListener('input', () => { note.text = ta.value; autoGrow(ta); });

    const del = document.createElement('button');
    del.className = 'noteDelete';
    del.title = 'Delete note';
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    del.addEventListener('click', () => { state.notes = state.notes.filter(n => n.id !== note.id); renderNotes(); });

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

toggleSidebarBtn.addEventListener('click', () => sidebar.classList.contains('open') ? closeSidebar() : openSidebar());
closeSidebarBtn.addEventListener('click', closeSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);

copyAllBtn.addEventListener('click', () => {
  if (!state.notes.length) { showToast('No notes to copy'); return; }
  navigator.clipboard.writeText(state.notes.map(n => n.text).join('\n'))
    .then(() => showToast('Copied to clipboard!'))
    .catch(() => showToast('Copy failed'));
});

clearAllBtn.addEventListener('click', () => {
  if (!state.notes.length) return;
  state.notes = [];
  renderNotes();
  showToast('All notes cleared');
});

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
  fpsDisplay.textContent = '';
  setStatus('Stopped', 'stopped');
}

toggleScanBtn.addEventListener('click', () => state.scanning ? stopScan() : startScan());

toggleOverlayBtn.addEventListener('click', () => {
  state.showOverlay = !state.showOverlay;
  toggleOverlayBtn.classList.toggle('active', state.showOverlay);
  if (!state.showOverlay) ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  else redrawBoxes();
  showToast(state.showOverlay ? 'Overlay on' : 'Overlay off');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(function init() {
  setTimeout(() => {
    splashScreen.classList.add('hide');
    setTimeout(() => { splashScreen.style.display = 'none'; }, 520);
  }, 1600);

  resizeOverlay();
  setStatus('Awaiting camera…', '');
  toggleOverlayBtn.classList.add('active');
  renderNotes();

  if (!navigator.mediaDevices?.getUserMedia) {
    permError.textContent = 'Camera API not supported. Use Chrome, Firefox, or Safari.';
    permError.classList.remove('hidden');
    grantBtn.disabled = true;
    setStatus('Not supported', 'error');
    return;
  }

  navigator.permissions?.query({ name: 'camera' }).then(p => {
    if (p.state === 'granted') { permScreen.classList.add('hidden'); startCamera(); }
  }).catch(() => {});

  loadingScreen.classList.add('hidden');
})();
