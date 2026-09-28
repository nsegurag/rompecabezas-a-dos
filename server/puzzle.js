'use strict';
/*
 * Reglas del rompecabezas (el servidor es la autoridad).
 *
 * Mundo: la mesa mide W x H. El rompecabezas completo mide PW x PH y su lugar
 * correcto (el "marco") empieza en (FX, FY), centrado en la mesa.
 * La foto se corta en `cols` x `rows` piezas; la pieza i está en la fila
 * floor(i / cols) y la columna i % cols.
 *
 * Cada grupo guarda su "origen": dónde quedaría la esquina superior izquierda
 * de la foto completa. Dos grupos encajan cuando sus orígenes casi coinciden y
 * tienen piezas vecinas. Si el origen coincide con el del marco, está en su lugar.
 */
const W = 3, H = 2;
const RATIOS = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 };
const TARGETS = [16, 36, 64, 100, 150, 200, 300, 500];

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r5 = v => Math.round(v * 1e5) / 1e5;

/** Elige columnas y filas para que las piezas salgan casi cuadradas. */
function grid(aspect, target) {
  const rows = Math.max(2, Math.round(Math.sqrt(target / aspect)));
  const cols = Math.max(2, Math.round(target / rows));
  return { cols, rows };
}
/** Tamaño y posición del marco en la mesa según la proporción de la foto. */
function frame(aspect) {
  let PW = Math.min(1.6, Math.sqrt(aspect)), PH = PW / aspect;
  if (PH > 1.2) { PH = 1.2; PW = PH * aspect; }
  return { PW: r5(PW), PH: r5(PH), FX: r5((W - PW) / 2), FY: r5((H - PH) / 2) };
}
function spec(pz) {
  return { cols: pz.cols, rows: pz.rows, PW: pz.PW, PH: pz.PH, FX: pz.FX, FY: pz.FY, pw: pz.PW / pz.cols, ph: pz.PH / pz.rows };
}

function overlapsFrame(sp, x, y, w, h, m = 0.04) {
  return x + w > sp.FX - m && x < sp.FX + sp.PW + m && y + h > sp.FY - m && y < sp.FY + sp.PH + m;
}

function makeLayout(sp, seed) {
  const r = rng(seed ^ 0x9e3779b9), N = sp.cols * sp.rows;
  const cell = 1.42 * Math.max(sp.pw, sp.ph), cells = [];
  for (let cy = 0.03; cy + cell <= H - 0.02; cy += cell)
    for (let cx = 0.03; cx + cell <= W - 0.02; cx += cell)
      if (!overlapsFrame(sp, cx, cy, cell, cell)) cells.push([cx, cy]);
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  const order = [...Array(N).keys()];
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const lay = new Array(N);
  order.forEach((p, k) => {
    const pr = Math.floor(p / sp.cols), pc = p % sp.cols;
    let cx, cy;
    if (k < cells.length) [cx, cy] = cells[k];
    else { cx = 0.03 + r() * (W - cell - 0.03); cy = 0.03 + r() * (H - cell - 0.03); }
    const sx = cell - sp.pw, sy = cell - sp.ph;
    const px = cx + sx / 2 + (r() - 0.5) * sx * 0.6, py = cy + sy / 2 + (r() - 0.5) * sy * 0.6;
    lay[p] = [r5(px - pc * sp.pw), r5(py - pr * sp.ph)];
  });
  return lay;
}

/** Tablero nuevo: todas las piezas sueltas y revueltas. */
function createBoard(sp, seed) {
  const layout = makeLayout(sp, seed), groups = {};
  for (let i = 0; i < sp.cols * sp.rows; i++) groups[String(i)] = { x: layout[i][0], y: layout[i][1], z: 0, members: [i], locked: false };
  return { groups, z: 0, doneAt: null };
}

function bbox(members, cols) {
  let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
  for (const i of members) {
    const r = Math.floor(i / cols), c = i % cols;
    if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r;
  }
  return { minC, maxC, minR, maxR };
}
function clampPos(members, sp, x, y) {
  const b = bbox(members, sp.cols);
  return {
    x: Math.max(-b.minC * sp.pw - 0.02, Math.min(W - (b.maxC + 1) * sp.pw + 0.02, x)),
    y: Math.max(-b.minR * sp.ph - 0.02, Math.min(H - (b.maxR + 1) * sp.ph + 0.02, y)),
  };
}
function adjacent(set, members, sp) {
  const { cols, rows } = sp;
  for (const b of members) {
    const r = Math.floor(b / cols), c = b % cols;
    if ((r > 0 && set.has(b - cols)) || (r < rows - 1 && set.has(b + cols)) ||
        (c > 0 && set.has(b - 1)) || (c < cols - 1 && set.has(b + 1))) return true;
  }
  return false;
}

/**
 * Suelta un grupo en (x, y).
 * Devuelve {set, del, target, x, y, merged, locked, joins, placed} o null.
 */
function drop(board, sp, gid, x, y, isHeld) {
  const g = board.groups[gid];
  if (!g || g.locked || !isFinite(x) || !isFinite(y)) return null;
  const tol = 0.3 * Math.min(sp.pw, sp.ph);
  let { x: tx, y: ty } = clampPos(g.members, sp, x, y);
  let locked = false;
  // Imán del marco: cerca de su lugar correcto se coloca exacto y queda fijo.
  if (Math.abs(tx - sp.FX) < tol * 1.25 && Math.abs(ty - sp.FY) < tol * 1.25) { tx = sp.FX; ty = sp.FY; locked = true; }

  const members = new Set(g.members);
  let target = gid, targetLocked = false, merged = false, changed = true, joins = 0, lockedBefore = 0;
  const absorbed = [];
  while (changed) {
    changed = false;
    for (const [k, o] of Object.entries(board.groups)) {
      if (k === target || absorbed.includes(k) || isHeld(k)) continue;
      if (Math.abs(o.x - tx) < tol && Math.abs(o.y - ty) < tol && adjacent(members, o.members, sp)) {
        const takeOver = !targetLocked && (o.locked || o.members.length > members.size);
        if (takeOver) { absorbed.push(target); target = k; targetLocked = !!o.locked; }
        else absorbed.push(k);
        tx = o.x; ty = o.y;
        if (o.locked) { locked = true; lockedBefore += o.members.length; }
        o.members.forEach(m => members.add(m));
        merged = changed = true; joins += 1;
      }
    }
  }
  if (Math.abs(tx - sp.FX) < 1e-9 && Math.abs(ty - sp.FY) < 1e-9) locked = true;

  board.z += 1;
  const body = { x: r5(tx), y: r5(ty), z: locked ? 0 : board.z, members: [...members].sort((a, b) => a - b), locked };
  const del = absorbed.filter(a => a !== target);
  for (const a of del) delete board.groups[a];
  board.groups[target] = body;
  const placed = locked ? members.size - lockedBefore : 0;
  return { set: { [target]: body }, del, target, x: body.x, y: body.y, merged, locked, joins, placed };
}

/** Ordena las piezas sueltas alrededor del marco: primero los bordes, más cerca. */
function arrange(board, sp, isHeld) {
  const cell = 1.28 * Math.max(sp.pw, sp.ph), loose = [], blockers = [];
  for (const [k, g] of Object.entries(board.groups)) {
    if (g.locked) continue;
    if (g.members.length === 1 && !isHeld(k)) loose.push(k);
    else {
      const b = bbox(g.members, sp.cols);
      blockers.push([g.x + (b.minC - 0.4) * sp.pw, g.y + (b.minR - 0.4) * sp.ph, g.x + (b.maxC + 1.4) * sp.pw, g.y + (b.maxR + 1.4) * sp.ph]);
    }
  }
  const cells = [], cx0 = sp.FX + sp.PW / 2, cy0 = sp.FY + sp.PH / 2;
  for (let cy = 0.02; cy + cell <= H - 0.01; cy += cell)
    for (let cx = 0.02; cx + cell <= W - 0.01; cx += cell) {
      if (overlapsFrame(sp, cx, cy, cell, cell, 0.03)) continue;
      if (blockers.some(([a, b, c, d]) => cx + cell > a && cx < c && cy + cell > b && cy < d)) continue;
      const dx = Math.max(sp.FX - (cx + cell), 0, cx - (sp.FX + sp.PW)), dy = Math.max(sp.FY - (cy + cell), 0, cy - (sp.FY + sp.PH));
      cells.push({ cx, cy, d: Math.hypot(dx, dy) + 0.001 * Math.hypot(cx - cx0, cy - cy0) });
    }
  cells.sort((a, b) => a.d - b.d);
  const edge = i => { const r = Math.floor(i / sp.cols), c = i % sp.cols; return r === 0 || c === 0 || r === sp.rows - 1 || c === sp.cols - 1; };
  loose.sort((a, b) => {
    const ia = board.groups[a].members[0], ib = board.groups[b].members[0];
    return (edge(ib) - edge(ia)) || ia - ib;
  });
  const set = {};
  loose.forEach((k, idx) => {
    const cellPos = cells[idx]; if (!cellPos) return;
    const g = board.groups[k], i = g.members[0], r = Math.floor(i / sp.cols), c = i % sp.cols;
    g.x = r5(cellPos.cx + (cell - sp.pw) / 2 - c * sp.pw);
    g.y = r5(cellPos.cy + (cell - sp.ph) / 2 - r * sp.ph);
    set[k] = g;
  });
  return { set, del: [] };
}

function stats(board, sp) {
  const N = sp.cols * sp.rows, ids = Object.keys(board.groups);
  let placed = 0;
  for (const k of ids) if (board.groups[k].locked) placed += board.groups[k].members.length;
  return { total: N, groups: ids.length, placed, progress: N > 1 ? Math.round(((N - ids.length) / (N - 1)) * 100) : 100 };
}

module.exports = { W, H, RATIOS, TARGETS, grid, frame, spec, createBoard, drop, arrange, stats };
