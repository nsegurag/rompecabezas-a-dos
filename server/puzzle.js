'use strict';
/*
 * Lógica del rompecabezas del lado del servidor (autoritativa).
 * Coordenadas del "mundo": la mesa mide W x H y el rompecabezas completo mide 1 x 1.
 * El marco (lugar correcto) tiene su esquina superior izquierda en (FX, FY).
 * Cada grupo guarda su "origen": dónde quedaría la esquina (0,0) de la foto
 * completa. Dos grupos encajan cuando sus orígenes coinciden y tienen piezas vecinas.
 */
const W = 3, H = 2, FX = 1, FY = 0.5;

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

function overlapsFrame(cx, cy, cell, m = 0.04) {
  return cx + cell > FX - m && cx < FX + 1 + m && cy + cell > FY - m && cy < FY + 1 + m;
}

function makeLayout(n, seed) {
  const r = rng(seed ^ 0x9e3779b9);
  const cell = 1.42 / n, N = n * n, cells = [];
  for (let cy = 0.03; cy + cell <= H - 0.02; cy += cell)
    for (let cx = 0.03; cx + cell <= W - 0.02; cx += cell)
      if (!overlapsFrame(cx, cy, cell)) cells.push([cx, cy]);
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  const order = [...Array(N).keys()];
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const s = 1 / n, slack = cell - s, lay = new Array(N);
  order.forEach((p, k) => {
    const pr = Math.floor(p / n), pc = p % n;
    let cx, cy;
    if (k < cells.length) [cx, cy] = cells[k];
    else { cx = 0.03 + r() * (W - cell - 0.03); cy = 0.03 + r() * (H - cell - 0.03); }
    const px = cx + slack / 2 + (r() - 0.5) * slack * 0.6;
    const py = cy + slack / 2 + (r() - 0.5) * slack * 0.6;
    lay[p] = [r5(px - pc * s), r5(py - pr * s)];
  });
  return lay;
}

function create(n, seed) {
  const layout = makeLayout(n, seed), groups = {};
  for (let i = 0; i < n * n; i++) groups[String(i)] = { x: layout[i][0], y: layout[i][1], z: 0, members: [i], locked: false };
  return { n, seed, groups, z: 0 };
}

function bbox(members, n) {
  let minC = n, maxC = 0, minR = n, maxR = 0;
  for (const i of members) {
    const r = Math.floor(i / n), c = i % n;
    if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r;
  }
  return { minC, maxC, minR, maxR };
}

function clampPos(members, n, x, y) {
  const b = bbox(members, n);
  return {
    x: Math.max(-b.minC / n - 0.02, Math.min(W - (b.maxC + 1) / n + 0.02, x)),
    y: Math.max(-b.minR / n - 0.02, Math.min(H - (b.maxR + 1) / n + 0.02, y)),
  };
}

function adjacent(set, members, n) {
  for (const b of members) {
    const r = Math.floor(b / n), c = b % n;
    if ((r > 0 && set.has(b - n)) || (r < n - 1 && set.has(b + n)) ||
        (c > 0 && set.has(b - 1)) || (c < n - 1 && set.has(b + 1))) return true;
  }
  return false;
}

/** Suelta un grupo en (x,y). Devuelve {set, del, merged, locked} o null. */
function drop(pz, gid, x, y, isHeld) {
  const g = pz.groups[gid];
  if (!g || g.locked || !isFinite(x) || !isFinite(y)) return null;
  const n = pz.n, tol = 0.3 / n;
  let { x: tx, y: ty } = clampPos(g.members, n, x, y);
  let locked = false;
  // Imán del marco: si el grupo está cerca de su lugar correcto, se coloca y se fija.
  if (Math.abs(tx - FX) < tol * 1.25 && Math.abs(ty - FY) < tol * 1.25) { tx = FX; ty = FY; locked = true; }

  const members = new Set(g.members);
  let target = gid, targetLocked = false, merged = false, changed = true;
  const absorbed = [];
  while (changed) {
    changed = false;
    for (const [k, o] of Object.entries(pz.groups)) {
      if (k === target || absorbed.includes(k) || isHeld(k)) continue;
      if (Math.abs(o.x - tx) < tol && Math.abs(o.y - ty) < tol && adjacent(members, o.members, n)) {
        const takeOver = !targetLocked && (o.locked || o.members.length > members.size);
        if (takeOver) { absorbed.push(target); target = k; targetLocked = !!o.locked; }
        else absorbed.push(k);
        tx = o.x; ty = o.y;
        if (o.locked) locked = true;
        o.members.forEach(m => members.add(m));
        merged = changed = true;
      }
    }
  }
  if (Math.abs(tx - FX) < 1e-9 && Math.abs(ty - FY) < 1e-9) locked = true;

  pz.z += 1;
  const body = { x: r5(tx), y: r5(ty), z: locked ? 0 : pz.z, members: [...members].sort((a, b) => a - b), locked };
  const del = absorbed.filter(a => a !== target);
  for (const a of del) delete pz.groups[a];
  pz.groups[target] = body;
  return { set: { [target]: body }, del, merged, locked };
}

/** Ordena las piezas sueltas alrededor del marco: primero los bordes, más cerca. */
function arrange(pz, isHeld) {
  const n = pz.n, s = 1 / n, cell = 1.28 / n;
  const loose = [], blockers = [];
  for (const [k, g] of Object.entries(pz.groups)) {
    if (g.locked) continue;
    if (g.members.length === 1 && !isHeld(k)) loose.push(k);
    else {
      const b = bbox(g.members, n);
      blockers.push([g.x + (b.minC - 0.4) / n, g.y + (b.minR - 0.4) / n, g.x + (b.maxC + 1.4) / n, g.y + (b.maxR + 1.4) / n]);
    }
  }
  const cells = [];
  for (let cy = 0.02; cy + cell <= H - 0.01; cy += cell)
    for (let cx = 0.02; cx + cell <= W - 0.01; cx += cell) {
      if (overlapsFrame(cx, cy, cell, 0.03)) continue;
      if (blockers.some(([a, b, c, d]) => cx + cell > a && cx < c && cy + cell > b && cy < d)) continue;
      const dx = Math.max(FX - (cx + cell), 0, cx - (FX + 1)), dy = Math.max(FY - (cy + cell), 0, cy - (FY + 1));
      cells.push({ cx, cy, d: Math.hypot(dx, dy) });
    }
  cells.sort((a, b) => a.d - b.d || a.cy - b.cy || a.cx - b.cx);
  const edge = i => { const r = Math.floor(i / n), c = i % n; return r === 0 || c === 0 || r === n - 1 || c === n - 1; };
  loose.sort((a, b) => {
    const ia = pz.groups[a].members[0], ib = pz.groups[b].members[0];
    return (edge(ib) - edge(ia)) || ia - ib;
  });
  const set = {};
  loose.forEach((k, idx) => {
    const cellPos = cells[idx]; if (!cellPos) return;
    const i = pz.groups[k].members[0], r = Math.floor(i / n), c = i % n;
    const g = pz.groups[k];
    g.x = r5(cellPos.cx + (cell - s) / 2 - c * s);
    g.y = r5(cellPos.cy + (cell - s) / 2 - r * s);
    set[k] = g;
  });
  return { set, del: [] };
}

function stats(pz) {
  const N = pz.n * pz.n, ids = Object.keys(pz.groups);
  let placed = 0;
  for (const k of ids) if (pz.groups[k].locked) placed += pz.groups[k].members.length;
  return { total: N, groups: ids.length, placed, progress: N > 1 ? Math.round(((N - ids.length) / (N - 1)) * 100) : 100 };
}

module.exports = { W, H, FX, FY, create, drop, arrange, stats };
