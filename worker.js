// SharedWorker: owns the single water world shared by every open window.
// The grid lives in *screen* coordinates; each window is a viewport onto it.
// Cells outside every window are walls, so water only flows between windows
// whose rectangles touch or overlap.

const CELL = 4;                              // screen px per cell
const ORIGIN_X = -2000, ORIGIN_Y = -1500;    // screen px at grid cell (0,0)
const GW = 2000, GH = 1500;                  // grid size in cells (8000x6000 px)
const SPREAD = 4;                            // max sideways cells per tick
const TICK_MS = 1000 / 60;
const TIMEOUT_MS = 3000;                     // drop windows that stop reporting

const EMPTY = 0, WATER = 1;

const grid = new Uint8Array(GW * GH);   // cell contents
const mask = new Uint8Array(GW * GH);   // 1 = inside some window (open)
const stamp = new Uint8Array(GW * GH);  // tick a cell last moved, avoids double moves

const clients = new Map();
let nextId = 1;
let tick = 0;
let box = null; // bounding box of the open area: {x0, y0, x1, y1}

onconnect = (e) => {
  const port = e.ports[0];
  const c = { id: nextId++, port, rect: null, ready: true, lastSeen: performance.now() };
  clients.set(c.id, c);
  port.onmessage = (ev) => handle(c, ev.data);
};

function handle(c, m) {
  c.lastSeen = performance.now();
  switch (m.type) {
    case 'rect': setRect(c, toCells(m)); break;
    case 'hidden': c.rect = null; break;
    case 'ready': c.ready = true; break;
    case 'paint': paint(m); break;
    case 'clear': grid.fill(EMPTY); break;
    case 'bye': drain(c); clients.delete(c.id); break;
  }
}

// Screen-px rect -> cell rect, clamped one cell inside the grid so the
// simulation can read neighbours without bounds checks.
function toCells(m) {
  let x = Math.round((m.left - ORIGIN_X) / CELL);
  let y = Math.round((m.top - ORIGIN_Y) / CELL);
  let w = Math.floor(m.width / CELL);
  let h = Math.floor(m.height / CELL);
  x = Math.max(1, Math.min(x, GW - 2));
  y = Math.max(1, Math.min(y, GH - 2));
  w = Math.max(1, Math.min(w, GW - 1 - x));
  h = Math.max(1, Math.min(h, GH - 1 - y));
  return { x, y, w, h };
}

function setRect(c, r) {
  const old = c.rect;
  c.rect = r;
  if (!old || (old.x === r.x && old.y === r.y && old.w === r.w && old.h === r.h)) return;
  // A pure move carries the window's water along with it; a resize squeezes
  // water from the area it gave up back inside.
  if (old.w === r.w && old.h === r.h) carry(c, old, r);
  else squeeze(c, old, r);
}

const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// The window shrank: push each water cell it no longer covers back in, like a
// wall closing in. The cell enters at the nearest edge and slides inward along
// its row/column to the first gap. If that line is full, the water level rises
// instead (the lowest empty cell takes it). Only if the window is completely
// full does water overflow and get lost.
function squeeze(c, from, to) {
  const x1 = to.x + to.w, y1 = to.y + to.h;
  const level = { x: to.x, y: y1 - 1 }; // scan cursor for the rising level
  for (let y = from.y; y < from.y + from.h; y++) {
    for (let x = from.x; x < from.x + from.w; x++) {
      if (inside(to, x, y)) continue;
      const i = y * GW + x;
      if (!grid[i] || coveredByOther(c, x, y)) continue;
      grid[i] = EMPTY;
      let dx = 0, dy = 0;
      if (y < to.y) dy = 1;
      else if (y >= y1) dy = -1;
      else dx = x < to.x ? 1 : -1;
      const px = Math.min(Math.max(x, to.x), x1 - 1);
      const py = Math.min(Math.max(y, to.y), y1 - 1);
      if (!slide(to, px, py, dx, dy)) raise(to, level);
    }
  }
}

function slide(r, x, y, dx, dy) {
  for (; inside(r, x, y); x += dx, y += dy) {
    const i = y * GW + x;
    if (!grid[i]) { grid[i] = WATER; return true; }
  }
  return false;
}

// Fill the lowest empty cell, resuming the bottom-up scan from `cur`.
function raise(r, cur) {
  for (; cur.y >= r.y; cur.y--, cur.x = r.x) {
    for (; cur.x < r.x + r.w; cur.x++) {
      const i = cur.y * GW + cur.x;
      if (!grid[i]) { grid[i] = WATER; return true; }
    }
  }
  return false;
}

// A closed window's water goes with it (except what another window still shows).
function drain(c) {
  const r = c.rect;
  if (!r) return;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (!coveredByOther(c, x, y)) grid[y * GW + x] = EMPTY;
    }
  }
}

function coveredByOther(self, x, y) {
  for (const o of clients.values()) {
    const r = o.rect;
    if (o === self || !r) continue;
    if (inside(r, x, y)) return true;
  }
  return false;
}

function carry(c, from, to) {
  const buf = new Uint8Array(from.w * from.h);
  for (let y = 0; y < from.h; y++) {
    for (let x = 0; x < from.w; x++) {
      const i = (from.y + y) * GW + from.x + x;
      // Leave water that another window is still showing.
      if (grid[i] && !coveredByOther(c, from.x + x, from.y + y)) {
        buf[y * from.w + x] = grid[i];
        grid[i] = EMPTY;
      }
    }
  }
  for (let y = 0; y < to.h; y++) {
    for (let x = 0; x < to.w; x++) {
      const v = buf[y * to.w + x];
      const j = (to.y + y) * GW + to.x + x;
      if (v && !grid[j]) grid[j] = v;
    }
  }
}

function paint(m) {
  const cx = Math.floor((m.x - ORIGIN_X) / CELL);
  const cy = Math.floor((m.y - ORIGIN_Y) / CELL);
  const r = m.radius;
  const v = m.erase ? EMPTY : WATER;
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 1 || y >= GH - 1) continue;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 1 || x >= GW - 1) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = y * GW + x;
      if (mask[i]) grid[i] = v;
    }
  }
}

function prune() {
  const now = performance.now();
  for (const [id, c] of clients) {
    if (now - c.lastSeen > TIMEOUT_MS) clients.delete(id);
  }
}

function rebuildMask() {
  if (box) {
    for (let y = box.y0; y < box.y1; y++) mask.fill(0, y * GW + box.x0, y * GW + box.x1);
  }
  box = null;
  for (const c of clients.values()) {
    const r = c.rect;
    if (!r) continue;
    for (let y = r.y; y < r.y + r.h; y++) mask.fill(1, y * GW + r.x, y * GW + r.x + r.w);
    if (!box) box = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
    else {
      box.x0 = Math.min(box.x0, r.x);
      box.y0 = Math.min(box.y0, r.y);
      box.x1 = Math.max(box.x1, r.x + r.w);
      box.y1 = Math.max(box.y1, r.y + r.h);
    }
  }
}

const open = (i) => mask[i] && grid[i] === EMPTY;

// Falling-sand water: down, then diagonal, then spread sideways.
// Rows are scanned bottom-up; the x direction alternates each tick to avoid bias.
function step() {
  if (!box) return;
  tick++;
  const t = (tick & 255) || 1;
  const ltr = tick & 1;
  const { x0, y0, x1, y1 } = box;

  const move = (i, j) => { grid[j] = WATER; grid[i] = EMPTY; stamp[j] = t; };

  for (let y = y1 - 1; y >= y0; y--) {
    const row = y * GW;
    for (let k = x0; k < x1; k++) {
      const i = row + (ltr ? k : x0 + x1 - 1 - k);
      if (grid[i] !== WATER || !mask[i] || stamp[i] === t) continue;

      const below = i + GW;
      if (open(below)) { move(i, below); continue; }

      const d = Math.random() < 0.5 ? 1 : -1;
      if (open(below + d)) { move(i, below + d); continue; }
      if (open(below - d)) { move(i, below - d); continue; }

      let dest = spread(i, d);
      if (dest < 0) dest = spread(i, -d);
      if (dest >= 0) move(i, dest);
    }
  }
}

// Slide up to SPREAD cells sideways, stopping early above a gap to fall into.
function spread(i, d) {
  let dest = -1;
  for (let s = 1; s <= SPREAD; s++) {
    const n = i + d * s;
    if (!open(n)) break;
    dest = n;
    if (open(n + GW)) break;
  }
  return dest;
}

// Send each window the cells under its rect. Flow control: only send once
// the window has drawn the previous frame, so hidden windows don't pile up.
function send() {
  for (const c of clients.values()) {
    const r = c.rect;
    if (!r || !c.ready) continue;
    const cells = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) {
      const row = (r.y + y) * GW + r.x;
      cells.set(grid.subarray(row, row + r.w), y * r.w);
    }
    c.ready = false;
    c.port.postMessage({ type: 'frame', w: r.w, h: r.h, cell: CELL, cells }, [cells.buffer]);
  }
}

setInterval(() => {
  prune();
  rebuildMask();
  step();
  send();
}, TICK_MS);
