// Window side: report where this window is on screen, draw the cells the
// worker sends back, and turn mouse input into paint commands.

const BRUSH = 3; // cells
const WATER = 0xffe0a040;      // ABGR (little-endian RGBA): rgb(64,160,224)
const SURFACE = 0xfff8d890;    // lighter top layer
const FOAM = 0xfffcf0dc;       // fast-moving water (FLIP only)

// Default is the FLIP particle fluid; ?sim=sand runs the falling-sand automaton.
// Each script is its own SharedWorker, so the two worlds are separate.
const params = new URLSearchParams(location.search);
const SIM = params.get('sim') === 'sand' ? 'sand' : 'flip';
const port = new SharedWorker(SIM === 'flip' ? 'worker-flip.js' : 'worker.js').port;
const stats = document.getElementById('stats');
const canvas = document.getElementById('view');

// The pixel-art WebGL renderer needs the FLIP worker's depth data.
// ?gfx=clear (default) | ocean | basic; basic (or no WebGL2) is the flat 2D one.
const GFX_STYLES = ['clear', 'ocean', 'basic'];
const GFX = GFX_STYLES.includes(params.get('gfx')) ? params.get('gfx') : 'clear';
const water = SIM === 'flip' && GFX !== 'basic' ? createWaterRenderer(canvas, GFX) : null;
const ctx = water ? null : canvas.getContext('2d');
let img = null;
let pending = null;
let lastRect = '';
let pointer = null; // {x, y, erase} in screen px while a button is held

// Offset from the outer window frame (screenX/Y) to the page content. Until
// the mouse has been over the page it's estimated from the frame size; any
// pointer event gives the exact value (screenX - clientX is the content's
// screen position), which stays valid as the window moves.
let frameOffset = null;
function calibrate(e) {
  const first = !frameOffset;
  frameOffset = { x: e.screenX - e.clientX - screenX, y: e.screenY - e.clientY - screenY };
  if (first) showStatus();
}
addEventListener('pointermove', calibrate, { passive: true });
addEventListener('pointerdown', calibrate, { passive: true });

function contentRect() {
  let x, y;
  if (frameOffset) ({ x, y } = frameOffset);
  else {
    x = Math.max(0, (outerWidth - innerWidth) / 2);
    y = Math.max(0, outerHeight - innerHeight - x);
  }
  return { left: screenX + x, top: screenY + y, width: innerWidth, height: innerHeight };
}

let statsText = '';
function showStatus() {
  const edges = frameOffset ? '' : ' · edges estimated, move the mouse over this window';
  stats.textContent = statsText + edges;
}

function sendRect(force) {
  const r = contentRect();
  // Hidden/minimized windows report a 0x0 size; they stop being a viewport
  // (their water freezes in place) until they're visible again.
  if (!r.width || !r.height) {
    lastRect = '';
    port.postMessage({ type: 'hidden' });
    return;
  }
  const key = `${r.left},${r.top},${r.width},${r.height}`;
  if (!force && key === lastRect) return;
  lastRect = key;
  port.postMessage({ type: 'rect', ...r });
}

port.onmessage = (e) => {
  if (e.data.type === 'frame') pending = e.data;
};

function draw(f) {
  if (f.stats) statsText = `${f.stats.particles} particles · ${f.stats.ms.toFixed(1)} ms/step`;
  showStatus();
  if (water) { water.draw(f); return; }

  if (canvas.width !== f.w || canvas.height !== f.h) {
    canvas.width = f.w;
    canvas.height = f.h;
    canvas.style.width = `${f.w * f.cell}px`;
    canvas.style.height = `${f.h * f.cell}px`;
    img = ctx.createImageData(f.w, f.h);
  }
  const px = new Uint32Array(img.data.buffer);
  const cells = f.cells;
  const w = f.w;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    px[k] = !c ? 0 : c >= 128 ? FOAM : k >= w && cells[k - w] ? WATER : SURFACE;
  }
  ctx.putImageData(img, 0, 0);
}

function frame() {
  sendRect(false);
  if (pointer) port.postMessage({ type: 'paint', ...pointer, radius: BRUSH });
  if (pending) {
    draw(pending);
    pending = null;
    port.postMessage({ type: 'ready' });
  }
  requestAnimationFrame(frame);
}

// Heartbeat so the worker knows we're alive even when nothing moves.
setInterval(() => sendRect(true), 250);

function trackPointer(e) {
  if (!e.buttons) { pointer = null; return; }
  pointer = { x: e.screenX, y: e.screenY, erase: (e.buttons & 2) !== 0 };
}
canvas.addEventListener('pointerdown', trackPointer);
canvas.addEventListener('pointermove', trackPointer);
addEventListener('pointerup', () => { pointer = null; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

document.getElementById('spawn').onclick = () => {
  const left = screenX + outerWidth + 8;
  window.open(location.href, '', `popup,width=${outerWidth},height=${outerHeight},left=${left},top=${screenY}`);
};
document.getElementById('clear').onclick = () => port.postMessage({ type: 'clear' });

const mode = document.getElementById('mode');
mode.textContent = SIM === 'flip' ? 'Switch to sand' : 'Switch to FLIP';
mode.href = SIM === 'flip' ? '?sim=sand' : '?sim=flip';

const gfx = document.getElementById('gfx');
gfx.hidden = SIM !== 'flip';
const nextGfx = GFX_STYLES[(GFX_STYLES.indexOf(GFX) + 1) % GFX_STYLES.length];
gfx.textContent = `Graphics: ${GFX} → ${nextGfx}`;
gfx.href = `?gfx=${nextGfx}`;

addEventListener('pagehide', () => port.postMessage({ type: 'bye' }));

showStatus();
sendRect(true);
requestAnimationFrame(frame);
