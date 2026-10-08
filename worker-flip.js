// SharedWorker: FLIP fluid version of the shared water world (worker.js is the
// falling-sand version). Same protocol and screen-space layout: windows are the
// only open space, everything outside them is wall.
//
// Water is particles that carry velocity. Each substep they're transferred onto
// a MAC grid covering the windows' bounding box, the grid velocities are made
// incompressible, and the change is blended back into the particles (FLIP).
// Based on Matthias Müller's "Ten Minute Physics" FLIP tutorial.
//
// Window motion feeds the physics:
//  - resizing moves walls, which shove particles with the edge's velocity
//  - dragging carries the water along, but changes in drag velocity kick the
//    particles the other way (inertia), so the water sloshes

const CELL = 4;                            // screen px per rendered pixel
const ORIGIN_X = -2000, ORIGIN_Y = -1500;  // screen px at render cell (0,0)
const GW = 2000, GH = 1500;                // render grid size in cells

const H = 10;                    // fluid grid spacing (px)
const R = 0.3 * H;               // particle radius (px)
const REST_DENSITY = (H * H) / ((2 * R) ** 2 * 0.866); // particles/cell at hex packing
const FULL = 0.95;               // fraction of REST_DENSITY a completely full window holds
const DRIFT_K =H / (REST_DENSITY * 0.05);             // push out overcompressed cells in ~50ms
const GRAVITY = 3000;            // px/s^2
const DAMPING = 1.0;             // 1/s, lets big sloshes calm down in a few seconds
const SUBSTEPS = 2;
const PRESSURE_ITERS = 30;
const SEPARATE_ITERS = 2;
const FLIP_RATIO = 0.9;
const OVER_RELAX = 1.9;
const MAX_SPEED = 2500;          // px/s
const MAX_WALL_SPEED = 1500;     // px/s
const MAX_PARTICLES = 30000;    // keeps a step within the frame budget
const FOAM_SPEED = 1300;         // px/s, faster particles render as foam
const MOTION_SMOOTH = 0.25;      // EMA factor for window drag velocity
const MOTION_STALE_MS = 50;      // no rect update for this long = window stopped
const TICK_MS = 1000 / 60;
const DT = 1 / 60;
const TIMEOUT_MS = 75000;        // generous: background windows get throttled timers

const FLUID = 0, AIR = 1, SOLID = 2;

// ---- particles (global screen px) ----
const pos = new Float32Array(2 * MAX_PARTICLES);
const vel = new Float32Array(2 * MAX_PARTICLES);
let count = 0;

// ---- fluid grid (rebuilt each tick over the windows' bounding box) ----
let nx = 0, ny = 0, ox = 0, oy = 0, gridCap = 0;
let u, v, du, dv, prevU, prevV, solid, cellType, density;
let lastGrid = null; // {ox, oy, nx, ny} of the last step, for spawn density checks

// ---- spatial hash for particle separation ----
const PS = 2.2 * R, PINV = 1 / PS;
let hashCap = 0, numCell, firstCell;
const cellIds = new Int32Array(MAX_PARTICLES);

// ---- render occupancy ----
let occ = new Uint8Array(0);

const clients = new Map();
let nextId = 1;
let stepMs = 0;

onconnect = (e) => {
  const port = e.ports[0];
  const c = {
    id: nextId++, port, rect: null, px: null, frozen: null,
    ready: true, lastSeen: performance.now(), lastRectTime: 0,
    measVx: 0, measVy: 0, vx: 0, vy: 0,
    edge: { l: 0, r: 0, t: 0, b: 0 },
  };
  clients.set(c.id, c);
  port.onmessage = (ev) => handle(c, ev.data);
};

function handle(c, m) {
  c.lastSeen = performance.now();
  switch (m.type) {
    case 'rect': setRect(c, toCells(m)); break;
    case 'hidden':
      // Freeze this window's water in place until it's visible again.
      if (c.rect) { c.frozen = c.px; c.rect = null; c.px = null; }
      break;
    case 'ready': c.ready = true; break;
    case 'paint': paint(m); break;
    case 'clear': count = 0; break;
    case 'bye': drain(c); clients.delete(c.id); break;
  }
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function toCells(m) {
  let x = Math.round((m.left - ORIGIN_X) / CELL);
  let y = Math.round((m.top - ORIGIN_Y) / CELL);
  let w = Math.floor(m.width / CELL);
  let h = Math.floor(m.height / CELL);
  x = clamp(x, 1, GW - 2);
  y = clamp(y, 1, GH - 2);
  w = clamp(w, 1, GW - 1 - x);
  h = clamp(h, 1, GH - 1 - y);
  return { x, y, w, h };
}

const toPx = (r) => ({
  l: ORIGIN_X + r.x * CELL, t: ORIGIN_Y + r.y * CELL,
  r: ORIGIN_X + (r.x + r.w) * CELL, b: ORIGIN_Y + (r.y + r.h) * CELL,
});

const inside = (p, x, y) => x >= p.l && x < p.r && y >= p.t && y < p.b;

function coveredByOther(self, x, y) {
  for (const o of clients.values()) {
    if (o !== self && o.px && inside(o.px, x, y)) return true;
  }
  return false;
}

function setRect(c, r) {
  const old = c.rect;
  const now = performance.now();
  c.rect = r;
  c.px = toPx(r);
  c.frozen = null;
  if (!old) { c.lastRectTime = now; return; }
  if (old.x === r.x && old.y === r.y && old.w === r.w && old.h === r.h) return;

  const dt = clamp((now - c.lastRectTime) / 1000, 1 / 240, 0.1);
  c.lastRectTime = now;
  const o = toPx(old), p = c.px;
  const wall = (d) => clamp(d / dt, -MAX_WALL_SPEED, MAX_WALL_SPEED);

  if (old.w === r.w && old.h === r.h) {
    // Dragged: the water rides along; the velocity is used for inertia.
    const dx = p.l - o.l, dy = p.t - o.t;
    for (let i = 0; i < count; i++) {
      const x = pos[2 * i], y = pos[2 * i + 1];
      if (inside(o, x, y) && !coveredByOther(c, x, y)) {
        pos[2 * i] = x + dx;
        pos[2 * i + 1] = y + dy;
      }
    }
    c.measVx = dx / dt;
    c.measVy = dy / dt;
  } else {
    // Resized: the edges are moving walls.
    c.edge.l = wall(p.l - o.l);
    c.edge.r = wall(p.r - o.r);
    c.edge.t = wall(p.t - o.t);
    c.edge.b = wall(p.b - o.b);
  }
}

function removeParticle(i) {
  count--;
  pos[2 * i] = pos[2 * count]; pos[2 * i + 1] = pos[2 * count + 1];
  vel[2 * i] = vel[2 * count]; vel[2 * i + 1] = vel[2 * count + 1];
}

function insideActive(x, y) {
  for (const c of clients.values()) if (c.px && inside(c.px, x, y)) return true;
  return false;
}

function densityCell(x, y) {
  if (!lastGrid) return -1;
  const i = Math.floor((x - lastGrid.ox) / H), j = Math.floor((y - lastGrid.oy) / H);
  if (i < 0 || j < 0 || i >= lastGrid.nx || j >= lastGrid.ny) return -1;
  return i * lastGrid.ny + j;
}

function paint(m) {
  const rad = m.radius * CELL;
  if (m.erase) {
    for (let i = count - 1; i >= 0; i--) {
      if ((pos[2 * i] - m.x) ** 2 + (pos[2 * i + 1] - m.y) ** 2 < rad * rad) removeParticle(i);
    }
    return;
  }
  // Spawn into the brush only where the water isn't already packed.
  for (let k = 0; k < 24 && count < MAX_PARTICLES; k++) {
    const x = m.x + (Math.random() * 2 - 1) * rad;
    const y = m.y + (Math.random() * 2 - 1) * rad;
    if ((x - m.x) ** 2 + (y - m.y) ** 2 > rad * rad || !insideActive(x, y)) continue;
    const dc = densityCell(x, y);
    if (dc >= 0 && density[dc] >= REST_DENSITY * 0.8) continue;
    pos[2 * count] = x; pos[2 * count + 1] = y;
    vel[2 * count] = (Math.random() - 0.5) * 40; vel[2 * count + 1] = 150;
    count++;
    if (dc >= 0) density[dc] += 1;
  }
}

// A closed window's water goes with it (except what another window still shows).
function drain(c) {
  const p = c.px || c.frozen;
  if (!p) return;
  for (let i = count - 1; i >= 0; i--) {
    const x = pos[2 * i], y = pos[2 * i + 1];
    if (inside(p, x, y) && !coveredByOther(c, x, y)) removeParticle(i);
  }
}

function prune() {
  const now = performance.now();
  for (const [id, c] of clients) {
    if (now - c.lastSeen > TIMEOUT_MS) { drain(c); clients.delete(id); }
  }
}

// Changes in a window's drag velocity push its water the opposite way.
function windowMotion(active) {
  const now = performance.now();
  for (const c of active) {
    if (now - c.lastRectTime > MOTION_STALE_MS) {
      c.measVx = c.measVy = 0;
      c.edge.l = c.edge.r = c.edge.t = c.edge.b = 0;
    }
    const nvx = c.vx + (c.measVx - c.vx) * MOTION_SMOOTH;
    const nvy = c.vy + (c.measVy - c.vy) * MOTION_SMOOTH;
    const kx = nvx - c.vx, ky = nvy - c.vy;
    c.vx = nvx; c.vy = nvy;
    if (Math.abs(kx) + Math.abs(ky) < 1) continue;
    for (let i = 0; i < count; i++) {
      const x = pos[2 * i], y = pos[2 * i + 1];
      if (inside(c.px, x, y) && !coveredByOther(c, x, y)) {
        vel[2 * i] -= kx;
        vel[2 * i + 1] -= ky;
      }
    }
  }
}

// ---------------------------------------------------------------- simulation

function allocGrid(size) {
  if (size <= gridCap) return;
  gridCap = Math.ceil(size * 1.5);
  u = new Float32Array(gridCap); v = new Float32Array(gridCap);
  du = new Float32Array(gridCap); dv = new Float32Array(gridCap);
  prevU = new Float32Array(gridCap); prevV = new Float32Array(gridCap);
  solid = new Float32Array(gridCap); // 1 = open, 0 = wall (Müller's "s")
  cellType = new Uint8Array(gridCap);
  density = new Float32Array(gridCap);
}

function simulate(active) {
  // Particles inside hidden windows (and no visible one) are frozen: move them
  // to the end of the arrays and only simulate the first `na`.
  const frozen = [];
  for (const c of clients.values()) if (!c.px && c.frozen) frozen.push(c.frozen);
  let na = count;
  if (frozen.length) {
    let a = 0, b = count - 1;
    while (a <= b) {
      const x = pos[2 * a], y = pos[2 * a + 1];
      if (!insideActive(x, y) && frozen.some((p) => inside(p, x, y))) {
        swapParticles(a, b);
        b--;
      } else a++;
    }
    na = a;
  }
  if (!na) { lastGrid = null; return; }

  let L = Infinity, T = Infinity, Rt = -Infinity, B = -Infinity;
  for (const c of active) {
    L = Math.min(L, c.px.l); T = Math.min(T, c.px.t);
    Rt = Math.max(Rt, c.px.r); B = Math.max(B, c.px.b);
  }
  ox = Math.floor(L / H) * H - H;
  oy = Math.floor(T / H) * H - H;
  nx = Math.ceil((Rt - ox) / H) + 1;
  ny = Math.ceil((B - oy) / H) + 1;
  allocGrid(nx * ny);

  // Walls in local coordinates, snapped to grid lines so particles and the
  // pressure solve agree on where the walls are; with each edge's velocity.
  // Snapped outward, so water always reaches the visible window edge (the
  // part past it, under H px, is just hidden).
  const down = (x) => Math.floor(x / H) * H, up = (x) => Math.ceil(x / H) * H;
  const walls = [];
  for (const c of active) {
    const w = {
      l: down(c.px.l - ox), t: down(c.px.t - oy), r: up(c.px.r - ox), b: up(c.px.b - oy),
      el: c.edge.l, er: c.edge.r, et: c.edge.t, eb: c.edge.b,
    };
    if (w.r > w.l && w.b > w.t) walls.push(w);
  }
  if (!walls.length) return;

  solid.fill(0, 0, nx * ny);
  for (const w of walls) {
    const j0 = w.t / H, j1 = w.b / H;
    for (let i = w.l / H; i < w.r / H; i++) solid.fill(1, i * ny + j0, i * ny + j1);
  }
  let openCells = 0;
  for (let i = 0; i < nx * ny; i++) openCells += solid[i];

  for (let i = 0; i < na; i++) { pos[2 * i] -= ox; pos[2 * i + 1] -= oy; }

  const dt = DT / SUBSTEPS;
  for (let s = 0; s < SUBSTEPS; s++) {
    integrate(na, dt);
    if (s === 0) separate(na); // the most expensive part; once per frame is enough
    collide(na, walls);
    particlesToGrid(na);
    solve();
    gridToParticles(na);
  }

  for (let i = 0; i < na; i++) {
    pos[2 * i] += ox; pos[2 * i + 1] += oy;
    const sp = Math.hypot(vel[2 * i], vel[2 * i + 1]);
    if (sp > MAX_SPEED) { vel[2 * i] *= MAX_SPEED / sp; vel[2 * i + 1] *= MAX_SPEED / sp; }
  }
  lastGrid = { ox, oy, nx, ny };
  overflow(na, Math.floor(openCells * REST_DENSITY * FULL));
}

// Water can't compress: if the windows hold more than fits (e.g. one was
// squished smaller than its water), the topmost excess spills out.
function overflow(na, capacity) {
  if (na <= capacity) return;
  const ids = Array.from({ length: na }, (_, i) => i);
  ids.sort((a, b) => pos[2 * a + 1] - pos[2 * b + 1]);
  const spill = ids.slice(0, na - capacity).sort((a, b) => b - a);
  for (const i of spill) removeParticle(i);
}

function swapParticles(a, b) {
  let t;
  t = pos[2 * a]; pos[2 * a] = pos[2 * b]; pos[2 * b] = t;
  t = pos[2 * a + 1]; pos[2 * a + 1] = pos[2 * b + 1]; pos[2 * b + 1] = t;
  t = vel[2 * a]; vel[2 * a] = vel[2 * b]; vel[2 * b] = t;
  t = vel[2 * a + 1]; vel[2 * a + 1] = vel[2 * b + 1]; vel[2 * b + 1] = t;
}

function integrate(na, dt) {
  const keep = 1 - DAMPING * dt;
  for (let i = 0; i < na; i++) {
    vel[2 * i] *= keep;
    vel[2 * i + 1] = vel[2 * i + 1] * keep + GRAVITY * dt;
    pos[2 * i] += vel[2 * i] * dt;
    pos[2 * i + 1] += vel[2 * i + 1] * dt;
  }
}

// Push overlapping particles apart (keeps volume and spreads them evenly).
function separate(na) {
  const pnx = Math.floor((nx * H) * PINV) + 1, pny = Math.floor((ny * H) * PINV) + 1;
  const pc = pnx * pny;
  if (pc + 1 > hashCap) {
    hashCap = Math.ceil((pc + 1) * 1.5);
    numCell = new Int32Array(hashCap);
    firstCell = new Int32Array(hashCap);
  }
  numCell.fill(0, 0, pc);
  for (let i = 0; i < na; i++) {
    const xi = clamp(Math.floor(pos[2 * i] * PINV), 0, pnx - 1);
    const yi = clamp(Math.floor(pos[2 * i + 1] * PINV), 0, pny - 1);
    numCell[xi * pny + yi]++;
  }
  let first = 0;
  for (let c = 0; c < pc; c++) { first += numCell[c]; firstCell[c] = first; }
  firstCell[pc] = first;
  for (let i = 0; i < na; i++) {
    const xi = clamp(Math.floor(pos[2 * i] * PINV), 0, pnx - 1);
    const yi = clamp(Math.floor(pos[2 * i + 1] * PINV), 0, pny - 1);
    cellIds[--firstCell[xi * pny + yi]] = i;
  }

  const minDist = 2 * R, minDist2 = minDist * minDist;
  for (let iter = 0; iter < SEPARATE_ITERS; iter++) {
    for (let i = 0; i < na; i++) {
      const px = pos[2 * i], py = pos[2 * i + 1];
      const pxi = Math.floor(px * PINV), pyi = Math.floor(py * PINV);
      const x0 = Math.max(pxi - 1, 0), y0 = Math.max(pyi - 1, 0);
      const x1 = Math.min(pxi + 1, pnx - 1), y1 = Math.min(pyi + 1, pny - 1);
      for (let xi = x0; xi <= x1; xi++) {
        for (let yi = y0; yi <= y1; yi++) {
          const c = xi * pny + yi;
          for (let j = firstCell[c], end = firstCell[c + 1]; j < end; j++) {
            const id = cellIds[j];
            if (id === i) continue;
            let dx = pos[2 * id] - px, dy = pos[2 * id + 1] - py;
            const d2 = dx * dx + dy * dy;
            if (d2 > minDist2 || d2 === 0) continue;
            const d = Math.sqrt(d2);
            const s = (0.5 * (minDist - d)) / d;
            dx *= s; dy *= s;
            pos[2 * i] -= dx; pos[2 * i + 1] -= dy;
            pos[2 * id] += dx; pos[2 * id + 1] += dy;
          }
        }
      }
    }
  }
}

// Keep particles inside the union of windows. A particle outside every window
// is projected into the nearest one; if a wall pushed it there, it takes on
// that wall's velocity.
function collide(na, walls) {
  const M = 0.5;
  for (let i = 0; i < na; i++) {
    const x = pos[2 * i], y = pos[2 * i + 1];
    let ok = false;
    for (const w of walls) if (inside(w, x, y)) { ok = true; break; }
    if (ok) continue;

    let best = null, bx = 0, by = 0, bd = Infinity;
    for (const w of walls) {
      const cx = clamp(x, w.l + M, w.r - M), cy = clamp(y, w.t + M, w.b - M);
      const d = (cx - x) ** 2 + (cy - y) ** 2;
      if (d < bd) { bd = d; best = w; bx = cx; by = cy; }
    }
    let vx = vel[2 * i], vy = vel[2 * i + 1];
    if (bx > x) vx = Math.max(vx, best.el); else if (bx < x) vx = Math.min(vx, best.er);
    if (by > y) vy = Math.max(vy, best.et); else if (by < y) vy = Math.min(vy, best.eb);
    pos[2 * i] = bx; pos[2 * i + 1] = by;
    vel[2 * i] = vx; vel[2 * i + 1] = vy;
  }
}

// Particles -> grid, in one pass over the particles: mark fluid cells, splat
// both velocity components onto the staggered MAC grid (u on vertical faces,
// v on horizontal faces), and accumulate particle density at cell centers.
function particlesToGrid(na) {
  const n = ny, inv = 1 / H, h2 = 0.5 * H, size = nx * ny;
  const xMax = (nx - 1) * H, yMax = (ny - 1) * H;

  u.fill(0, 0, size); v.fill(0, 0, size);
  du.fill(0, 0, size); dv.fill(0, 0, size);
  density.fill(0, 0, size);
  for (let i = 0; i < size; i++) cellType[i] = solid[i] === 0 ? SOLID : AIR;

  for (let i = 0; i < na; i++) {
    const px = pos[2 * i], py = pos[2 * i + 1];

    const c = clamp(Math.floor(px * inv), 0, nx - 1) * n + clamp(Math.floor(py * inv), 0, ny - 1);
    if (cellType[c] === AIR) cellType[c] = FLUID;

    const cx = clamp(px, H, xMax), cy = clamp(py, H, yMax);

    // u: sampled at (i*H, (j+0.5)*H)
    {
      const x = cx, y = cy - h2;
      const x0 = Math.min(Math.floor(x * inv), nx - 2), tx = (x - x0 * H) * inv, x1 = Math.min(x0 + 1, nx - 2);
      const y0 = Math.min(Math.floor(y * inv), ny - 2), ty = (y - y0 * H) * inv, y1 = Math.min(y0 + 1, ny - 2);
      const sx = 1 - tx, sy = 1 - ty;
      const d0 = sx * sy, d1 = tx * sy, d2 = tx * ty, d3 = sx * ty;
      const n0 = x0 * n + y0, n1 = x1 * n + y0, n2 = x1 * n + y1, n3 = x0 * n + y1;
      const pv = vel[2 * i];
      u[n0] += pv * d0; du[n0] += d0;
      u[n1] += pv * d1; du[n1] += d1;
      u[n2] += pv * d2; du[n2] += d2;
      u[n3] += pv * d3; du[n3] += d3;
    }
    // v: sampled at ((i+0.5)*H, j*H)
    {
      const x = cx - h2, y = cy;
      const x0 = Math.min(Math.floor(x * inv), nx - 2), tx = (x - x0 * H) * inv, x1 = Math.min(x0 + 1, nx - 2);
      const y0 = Math.min(Math.floor(y * inv), ny - 2), ty = (y - y0 * H) * inv, y1 = Math.min(y0 + 1, ny - 2);
      const sx = 1 - tx, sy = 1 - ty;
      const d0 = sx * sy, d1 = tx * sy, d2 = tx * ty, d3 = sx * ty;
      const n0 = x0 * n + y0, n1 = x1 * n + y0, n2 = x1 * n + y1, n3 = x0 * n + y1;
      const pv = vel[2 * i + 1];
      v[n0] += pv * d0; dv[n0] += d0;
      v[n1] += pv * d1; dv[n1] += d1;
      v[n2] += pv * d2; dv[n2] += d2;
      v[n3] += pv * d3; dv[n3] += d3;
    }
    // density: sampled at cell centers
    {
      const x = cx - h2, y = cy - h2;
      const x0 = Math.floor(x * inv), tx = (x - x0 * H) * inv, x1 = Math.min(x0 + 1, nx - 2);
      const y0 = Math.floor(y * inv), ty = (y - y0 * H) * inv, y1 = Math.min(y0 + 1, ny - 2);
      const sx = 1 - tx, sy = 1 - ty;
      if (x0 < nx && y0 < ny) density[x0 * n + y0] += sx * sy;
      if (x1 < nx && y0 < ny) density[x1 * n + y0] += tx * sy;
      if (x1 < nx && y1 < ny) density[x1 * n + y1] += tx * ty;
      if (x0 < nx && y1 < ny) density[x0 * n + y1] += sx * ty;
    }
  }

  for (let i = 0; i < size; i++) if (du[i] > 0) u[i] /= du[i];
  for (let i = 0; i < size; i++) if (dv[i] > 0) v[i] /= dv[i];

  // Faces touching a wall carry no flow.
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * n + j;
      const s = cellType[c] === SOLID;
      if (s || (i > 0 && cellType[c - n] === SOLID)) u[c] = 0;
      if (s || (j > 0 && cellType[c - 1] === SOLID)) v[c] = 0;
    }
  }
}

// Grid -> particles: blend PIC (grid velocity) and FLIP (particle velocity
// plus the grid's change), sampling only faces next to fluid or wall cells.
function gridToParticles(na) {
  const n = ny, inv = 1 / H, h2 = 0.5 * H;
  const xMax = (nx - 1) * H, yMax = (ny - 1) * H;

  for (let i = 0; i < na; i++) {
    const cx = clamp(pos[2 * i], H, xMax), cy = clamp(pos[2 * i + 1], H, yMax);
    for (let comp = 0; comp < 2; comp++) {
      const f = comp === 0 ? u : v, prevF = comp === 0 ? prevU : prevV;
      const off = comp === 0 ? n : 1;
      const x = comp === 0 ? cx : cx - h2, y = comp === 0 ? cy - h2 : cy;
      const x0 = Math.min(Math.floor(x * inv), nx - 2), tx = (x - x0 * H) * inv, x1 = Math.min(x0 + 1, nx - 2);
      const y0 = Math.min(Math.floor(y * inv), ny - 2), ty = (y - y0 * H) * inv, y1 = Math.min(y0 + 1, ny - 2);
      const sx = 1 - tx, sy = 1 - ty;
      const d0 = sx * sy, d1 = tx * sy, d2 = tx * ty, d3 = sx * ty;
      const n0 = x0 * n + y0, n1 = x1 * n + y0, n2 = x1 * n + y1, n3 = x0 * n + y1;

      const v0 = cellType[n0] !== AIR || cellType[n0 - off] !== AIR ? 1 : 0;
      const v1 = cellType[n1] !== AIR || cellType[n1 - off] !== AIR ? 1 : 0;
      const v2 = cellType[n2] !== AIR || cellType[n2 - off] !== AIR ? 1 : 0;
      const v3 = cellType[n3] !== AIR || cellType[n3 - off] !== AIR ? 1 : 0;
      const w = v0 * d0 + v1 * d1 + v2 * d2 + v3 * d3;
      if (w > 0) {
        const pic = (v0 * d0 * f[n0] + v1 * d1 * f[n1] + v2 * d2 * f[n2] + v3 * d3 * f[n3]) / w;
        const corr = (v0 * d0 * (f[n0] - prevF[n0]) + v1 * d1 * (f[n1] - prevF[n1]) +
                      v2 * d2 * (f[n2] - prevF[n2]) + v3 * d3 * (f[n3] - prevF[n3])) / w;
        const flip = vel[2 * i + comp] + corr;
        vel[2 * i + comp] = (1 - FLIP_RATIO) * pic + FLIP_RATIO * flip;
      }
    }
  }
}

// Gauss-Seidel pressure projection with drift correction for packed cells.
// The fluid cells and their per-cell constants (open neighbours, drift) are
// gathered once, so the iterations only touch water.
let fluidCap = 0, fluidIdx, fluidS, fluidDrift;
function solve() {
  const n = ny, size = nx * ny;
  prevU.set(u.subarray(0, size));
  prevV.set(v.subarray(0, size));

  if (size > fluidCap) {
    fluidCap = gridCap;
    fluidIdx = new Int32Array(fluidCap);
    fluidS = new Float32Array(fluidCap);
    fluidDrift = new Float64Array(fluidCap);
  }
  let nf = 0;
  for (let i = 1; i < nx - 1; i++) {
    for (let j = 1; j < ny - 1; j++) {
      const c = i * n + j;
      if (cellType[c] !== FLUID) continue;
      const s = solid[c - n] + solid[c + n] + solid[c - 1] + solid[c + 1];
      if (s === 0) continue;
      const compression = density[c] - REST_DENSITY;
      fluidIdx[nf] = c;
      fluidS[nf] = s;
      fluidDrift[nf] = compression > 0 ? DRIFT_K * compression : 0;
      nf++;
    }
  }

  for (let iter = 0; iter < PRESSURE_ITERS; iter++) {
    for (let k = 0; k < nf; k++) {
      const c = fluidIdx[k];
      const r = c + n, t = c + 1;
      const div = u[r] - u[c] + v[t] - v[c] - fluidDrift[k];
      const p = (-div / fluidS[k]) * OVER_RELAX;
      u[c] -= solid[c - n] * p; u[r] += solid[r] * p;
      v[c] -= solid[c - 1] * p; v[t] += solid[t] * p;
    }
  }
}

// ------------------------------------------------------------------ output

// Splat particles onto the render grid once, then send each window its slice.
// Cell byte: 0 = air; otherwise bits 0-6 = 1 + depth below the water surface
// in render pixels (capped), bit 7 = fast-moving water (foam).
let inWin = new Uint8Array(0);
let depthBuf = new Int16Array(0), rowSum = new Int32Array(0), rowCnt = new Int32Array(0);
const HOLE_RUN = 3;     // air gaps shorter than this don't count as a surface
const DEPTH_BLUR = 5;   // horizontal smoothing radius for depth, render px

// Turn the occupancy grid (0 air / 1 water / 2 foam) into the encoded cell
// bytes, over the whole bounding box so it's continuous across windows.
function shade(bw, bh, x0, y0, active) {
  const size = bw * bh;
  if (inWin.length < size) {
    inWin = new Uint8Array(occ.length);
    depthBuf = new Int16Array(occ.length);
  }
  if (rowSum.length < bw + 1) { rowSum = new Int32Array(bw + 1); rowCnt = new Int32Array(bw + 1); }
  inWin.fill(0, 0, size);
  for (const c of active) {
    const r = c.rect;
    for (let y = r.y - y0; y < r.y - y0 + r.h; y++) inWin.fill(1, y * bw + r.x - x0, y * bw + r.x - x0 + r.w);
  }

  // Close one-pixel gaps between splatted particles.
  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      const k = y * bw + x;
      if (occ[k] || !inWin[k]) continue;
      if ((occ[k - 1] && occ[k + 1]) || (occ[k - bw] && occ[k + bw])) occ[k] = 1;
    }
  }

  // Depth below the surface, per column. A run of HOLE_RUN air pixels resets
  // it; wall (outside every window) neither counts nor resets.
  for (let x = 0; x < bw; x++) {
    let depth = 0, air = HOLE_RUN;
    for (let k = x; k < size; k += bw) {
      if (!inWin[k]) { depthBuf[k] = -1; continue; }
      if (!occ[k]) {
        depthBuf[k] = -1;
        if (++air >= HOLE_RUN) depth = 0; else depth++;
        continue;
      }
      air = 0;
      depthBuf[k] = depth++;
    }
  }

  // Smooth depth sideways (over water pixels only) so cavities and splashes
  // don't leave hard vertical stripes, then encode.
  for (let y = 0; y < bh; y++) {
    const row = y * bw;
    rowSum[0] = 0; rowCnt[0] = 0;
    for (let x = 0; x < bw; x++) {
      const dv = depthBuf[row + x];
      rowSum[x + 1] = rowSum[x] + (dv >= 0 ? dv : 0);
      rowCnt[x + 1] = rowCnt[x] + (dv >= 0 ? 1 : 0);
    }
    for (let x = 0; x < bw; x++) {
      const k = row + x, o = occ[k];
      if (!o || !inWin[k]) { occ[k] = 0; continue; }
      const a = Math.max(0, x - DEPTH_BLUR), b = Math.min(bw, x + DEPTH_BLUR + 1);
      // The surface row itself stays exact so the outline/highlight are crisp.
      const own = depthBuf[k];
      const avg = own < 2 ? own : Math.round((rowSum[b] - rowSum[a]) / (rowCnt[b] - rowCnt[a]));
      occ[k] = (1 + Math.min(Math.max(avg, own < 2 ? 0 : 2), 126)) | (o === 2 ? 128 : 0);
    }
  }
}

function render(active) {
  if (!active.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of active) {
    const r = c.rect;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  const bw = x1 - x0, bh = y1 - y0, size = bw * bh;
  if (occ.length < size) occ = new Uint8Array(Math.ceil(size * 1.5));
  occ.fill(0, 0, size);

  const rr = R / CELL, foam2 = FOAM_SPEED * FOAM_SPEED;
  for (let i = 0; i < count; i++) {
    const gx = (pos[2 * i] - ORIGIN_X) / CELL - x0;
    const gy = (pos[2 * i + 1] - ORIGIN_Y) / CELL - y0;
    const val = vel[2 * i] ** 2 + vel[2 * i + 1] ** 2 > foam2 ? 2 : 1;
    const ax = Math.max(0, Math.floor(gx - rr)), bx = Math.min(bw - 1, Math.floor(gx + rr));
    const ay = Math.max(0, Math.floor(gy - rr)), by = Math.min(bh - 1, Math.floor(gy + rr));
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const k = y * bw + x;
        if (occ[k] < val) occ[k] = val;
      }
    }
  }

  shade(bw, bh, x0, y0, active);

  for (const c of active) {
    const r = c.rect;
    if (!c.ready) continue;
    const cells = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) {
      const row = (r.y - y0 + y) * bw + (r.x - x0);
      cells.set(occ.subarray(row, row + r.w), y * r.w);
    }
    c.ready = false;
    c.port.postMessage(
      { type: 'frame', x: r.x, y: r.y, w: r.w, h: r.h, cell: CELL, cells, stats: { particles: count, ms: stepMs } },
      [cells.buffer],
    );
  }
}

setInterval(() => {
  prune();
  const active = [...clients.values()].filter((c) => c.px);
  const t0 = performance.now();
  windowMotion(active);
  if (active.length) simulate(active);
  stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;
  render(active);
}, TICK_MS);
