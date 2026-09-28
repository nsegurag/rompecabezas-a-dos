// Forma de las piezas y "sprites" pre-dibujados. Todo sale de (cols, rows, seed),
// así que todos los jugadores ven exactamente las mismas piezas.
// Las formas se calculan en "coordenadas de cuadrícula": la pieza (r, c) ocupa
// el cuadrado [c, c+1] x [r, r+1]. Al dibujar se escala al tamaño real.
export const W = 3, H = 2, PAD = 0.36;

export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Plantilla de un borde con pestaña (u a lo largo del borde, v hacia afuera).
const TMPL = [
  ['L', 0.34, 0],
  ['C', 0.40, 0, 0.42, -0.05, 0.38, -0.12],
  ['C', 0.33, -0.22, 0.42, -0.30, 0.50, -0.30],
  ['C', 0.58, -0.30, 0.67, -0.22, 0.62, -0.12],
  ['C', 0.58, -0.05, 0.60, 0, 0.66, 0],
  ['L', 1, 0],
];

function mkEdge(map, j, k) {
  const tr = (u, v) => map((u === 0 || u === 1) ? u : u + j, v * k);
  const segs = TMPL.map(s => { const p = []; for (let i = 1; i < s.length; i += 2) p.push(tr(s[i], s[i + 1])); return { t: s[0], p }; });
  const starts = []; let prev = tr(0, 0);
  segs.forEach(s => { starts.push(prev); prev = s.p[s.p.length - 1]; });
  const rev = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    rev.push(s.t === 'L' ? { t: 'L', p: [starts[i]] } : { t: 'C', p: [s.p[1], s.p[0], starts[i]] });
  }
  return { f: segs, r: rev };
}
function addEdge(path, e, reverse) {
  for (const s of (reverse ? e.r : e.f)) {
    if (s.t === 'L') path.lineTo(s.p[0][0], s.p[0][1]);
    else path.bezierCurveTo(s.p[0][0], s.p[0][1], s.p[1][0], s.p[1][1], s.p[2][0], s.p[2][1]);
  }
}

/** Formas de todas las piezas: contorno completo y cada lado por separado. */
export function buildGeometry(cols, rows, seed) {
  const r = rng(seed), Hh = [], Vv = [];
  const rnd = () => ({ j: (r() - 0.5) * 0.1, k: (0.88 + r() * 0.22) * (r() < 0.5 ? 1 : -1) });
  for (let i = 0; i < rows - 1; i++) { Hh.push([]); for (let c = 0; c < cols; c++) { const q = rnd(); Hh[i].push(mkEdge((u, v) => [c + u, i + 1 + v], q.j, q.k)); } }
  for (let rr = 0; rr < rows; rr++) { Vv.push([]); for (let j = 0; j < cols - 1; j++) { const q = rnd(); Vv[rr].push(mkEdge((u, v) => [j + 1 + v, rr + u], q.j, q.k)); } }
  const paths = [], sides = [];
  for (let rr = 0; rr < rows; rr++) for (let c = 0; c < cols; c++) {
    const p = new Path2D(); p.moveTo(c, rr);
    if (rr === 0) p.lineTo(c + 1, rr); else addEdge(p, Hh[rr - 1][c], false);
    if (c === cols - 1) p.lineTo(c + 1, rr + 1); else addEdge(p, Vv[rr][c], false);
    if (rr === rows - 1) p.lineTo(c, rr + 1); else addEdge(p, Hh[rr][c], true);
    if (c === 0) p.lineTo(c, rr); else addEdge(p, Vv[rr][c - 1], true);
    p.closePath(); paths.push(p);
    const t = new Path2D(); t.moveTo(c, rr); if (rr === 0) t.lineTo(c + 1, rr); else addEdge(t, Hh[rr - 1][c], false);
    const ri = new Path2D(); ri.moveTo(c + 1, rr); if (c === cols - 1) ri.lineTo(c + 1, rr + 1); else addEdge(ri, Vv[rr][c], false);
    const b = new Path2D(); b.moveTo(c + 1, rr + 1); if (rr === rows - 1) b.lineTo(c, rr + 1); else addEdge(b, Hh[rr][c], true);
    const l = new Path2D(); l.moveTo(c, rr + 1); if (c === 0) l.lineTo(c, rr); else addEdge(l, Vv[rr][c - 1], true);
    sides.push([t, ri, b, l]);
  }
  return { cols, rows, paths, sides };
}

// Intensidad del relieve de las piezas sueltas.
export const BEVEL = { light: 0.22, dark: 0.24, line: 0.20 };

/**
 * Dibuja cada pieza una vez en su propio canvas (foto recortada + sombra).
 * Con muchas piezas se limita la resolución para no llenar la memoria del celular.
 */
export function buildSprites(img, geo) {
  const { cols, rows } = geo, N = cols * rows;
  const cap = N > 300 ? 64 : N > 150 ? 80 : N > 64 ? 110 : 200;
  const nat = Math.min(img.naturalWidth / cols, img.naturalHeight / rows);
  const pp = Math.max(24, Math.min(cap, nat));
  const sz = Math.ceil((1 + 2 * PAD) * pp), ssz = Math.ceil(sz / 2), out = [];
  const probe = document.createElement('canvas').getContext('2d');
  const pat = probe.createPattern(img, 'no-repeat');
  pat.setTransform(new DOMMatrix().scale(cols / img.naturalWidth, rows / img.naturalHeight));
  for (let i = 0; i < N; i++) {
    const r = Math.floor(i / cols), c = i % cols, path = geo.paths[i];
    const a = document.createElement('canvas'); a.width = a.height = sz;
    const x = a.getContext('2d');
    x.setTransform(pp, 0, 0, pp, -(c - PAD) * pp, -(r - PAD) * pp);
    // Un pelito de foto por fuera del borde tapa la rayita entre piezas unidas.
    x.strokeStyle = pat; x.lineWidth = 2.2 / pp; x.lineJoin = 'round'; x.stroke(path);
    x.save(); x.clip(path); x.drawImage(img, 0, 0, cols, rows); x.restore();
    // Sombra a media resolución (es borrosa de todos modos).
    const b = document.createElement('canvas'); b.width = b.height = ssz;
    const y = b.getContext('2d'), sp = ssz / (1 + 2 * PAD), off = ssz * 3;
    y.setTransform(sp, 0, 0, sp, -(c - PAD) * sp - off, -(r - PAD) * sp);
    y.shadowColor = 'rgba(0,0,0,.5)'; y.shadowBlur = Math.max(1.5, 0.09 * sp);
    y.shadowOffsetX = off; y.shadowOffsetY = Math.max(1, 0.035 * sp);
    y.fillStyle = '#000'; y.fill(path);
    out.push({ img: a, sh: b, ov: new Map(), i, r, c, pp, sz });
  }
  return out;
}

/** Relieve de una pieza solo en los lados indicados (bits: 1 arriba, 2 derecha, 4 abajo, 8 izquierda). */
export function overlay(spr, mask, geo) {
  let cv = spr.ov.get(mask);
  if (cv !== undefined) return cv;
  if (!mask) { spr.ov.set(mask, null); return null; }
  const { pp, sz, r, c, i } = spr;
  cv = document.createElement('canvas'); cv.width = cv.height = sz;
  const x = cv.getContext('2d');
  x.setTransform(pp, 0, 0, pp, -(c - PAD) * pp, -(r - PAD) * pp);
  x.clip(geo.paths[i]);
  const sides = geo.sides[i].filter((_, k) => mask & (1 << k));
  x.lineWidth = 0.05; x.lineCap = 'round';
  x.save(); x.translate(0.016, 0.016); x.strokeStyle = `rgba(255,255,255,${BEVEL.light})`; sides.forEach(s => x.stroke(s)); x.restore();
  x.save(); x.translate(-0.016, -0.016); x.strokeStyle = `rgba(0,0,0,${BEVEL.dark})`; sides.forEach(s => x.stroke(s)); x.restore();
  x.lineWidth = 0.012; x.strokeStyle = `rgba(0,0,0,${BEVEL.line})`; sides.forEach(s => x.stroke(s));
  spr.ov.set(mask, cv);
  return cv;
}

export const isEdge = (i, cols, rows) => { const r = Math.floor(i / cols), c = i % cols; return r === 0 || c === 0 || r === rows - 1 || c === cols - 1; };

/** Máscara de lados expuestos de la pieza i dentro de su grupo. */
export function edgeMask(i, set, cols, rows) {
  if (!set) return 15;
  const r = Math.floor(i / cols), c = i % cols; let mask = 0;
  if (!(r > 0 && set.has(i - cols))) mask |= 1;
  if (!(c < cols - 1 && set.has(i + 1))) mask |= 2;
  if (!(r < rows - 1 && set.has(i + cols))) mask |= 4;
  if (!(c > 0 && set.has(i - 1))) mask |= 8;
  return mask;
}

/** Fondos de mesa: color base, textura y colores del marco. */
export const THEMES = {
  ciruela: { base: '#3a2e44', page: '#241c2a', tex: 'felt', frame: 'rgba(255,255,255,.28)', well: 'rgba(0,0,0,.18)' },
  verde: { base: '#1e5a3c', page: '#12301f', tex: 'felt', frame: 'rgba(255,255,255,.32)', well: 'rgba(0,0,0,.18)' },
  madera: { base: '#8a5a34', page: '#2e1d12', tex: 'wood', frame: 'rgba(255,240,220,.45)', well: 'rgba(40,20,5,.22)' },
  pizarra: { base: '#23272d', page: '#121417', tex: 'felt', frame: 'rgba(255,255,255,.25)', well: 'rgba(0,0,0,.22)' },
  claro: { base: '#e8e2d7', page: '#c9c1b4', tex: 'paper', frame: 'rgba(40,30,20,.35)', well: 'rgba(60,40,20,.08)' },
};
const texCache = new WeakMap();
export function texture(ctx, kind) {
  let per = texCache.get(ctx); if (!per) texCache.set(ctx, per = {});
  if (per[kind]) return per[kind];
  const c = document.createElement('canvas'), x = c.getContext('2d');
  let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  if (kind === 'wood') {
    c.width = 512; c.height = 256;
    for (let y = 0; y < c.height; y++) {
      const t = Math.sin(y * 0.09 + Math.sin(y * 0.013) * 4) * 0.5 + 0.5;
      x.fillStyle = `rgba(${60 + t * 30},${30 + t * 16},${10 + t * 6},${0.18 + t * 0.14})`; x.fillRect(0, y, c.width, 1);
    }
    for (let i = 0; i < 40; i++) { x.strokeStyle = `rgba(40,18,4,${0.05 + r() * 0.1})`; x.lineWidth = 1 + r() * 2; x.beginPath(); const y0 = r() * 256; x.moveTo(0, y0); for (let X = 0; X <= 512; X += 32) x.lineTo(X, y0 + Math.sin(X * 0.02 + i) * 3); x.stroke(); }
    for (let i = 0; i < 2500; i++) { x.fillStyle = r() < 0.5 ? 'rgba(255,230,200,.04)' : 'rgba(30,10,0,.06)'; x.fillRect(r() * 512, r() * 256, 2, 1); }
  } else {
    c.width = c.height = 96;
    const a = kind === 'paper' ? [.25, .05] : [.035, .08];
    for (let i = 0; i < 900; i++) { x.fillStyle = r() < 0.5 ? `rgba(255,255,255,${a[0]})` : `rgba(0,0,0,${a[1]})`; x.fillRect(r() * 96, r() * 96, 1, 1); }
  }
  return (per[kind] = ctx.createPattern(c, 'repeat'));
}

/**
 * Dibuja los grupos de piezas (lo usan la mesa en vivo y el video del armado).
 * pz: {cols, rows, PW, PH}; posOf(gid) -> {x, y}.
 */
export function drawPieces(ctx, pz, geo, sprites, groups, order, posOf, opts = {}) {
  const { cols, rows } = pz, pw = pz.PW / cols, ph = pz.PH / rows;
  const sw = (1 + 2 * PAD) * pw, sh = (1 + 2 * PAD) * ph;
  for (const gid of order) {
    const g = groups[gid]; if (!g) continue;
    const p = posOf(gid), lift = opts.lifted && opts.lifted(gid);
    const dx = lift ? 0.004 : 0, dy = lift ? 0.008 : 0;
    const dim = opts.dim && opts.dim(g);
    if (dim) ctx.globalAlpha = 0.16;
    if (!g.locked) for (const i of g.members) { const r = Math.floor(i / cols), c = i % cols; ctx.drawImage(sprites[i].sh, p.x + (c - PAD) * pw + dx, p.y + (r - PAD) * ph + dy, sw, sh); }
    for (const i of g.members) { const r = Math.floor(i / cols), c = i % cols; ctx.drawImage(sprites[i].img, p.x + (c - PAD) * pw - dx, p.y + (r - PAD) * ph - dy, sw, sh); }
    const set = g.members.length > 1 ? new Set(g.members) : null;
    for (const i of g.members) {
      const ov = overlay(sprites[i], edgeMask(i, set, cols, rows), geo);
      if (ov) { const r = Math.floor(i / cols), c = i % cols; ctx.drawImage(ov, p.x + (c - PAD) * pw - dx, p.y + (r - PAD) * ph - dy, sw, sh); }
    }
    ctx.globalAlpha = 1;
    if (opts.after) opts.after(gid, g, p, dx, dy);
  }
}

/** Dibuja la mesa (fondo, marco y guía opcional). */
export function drawTable(ctx, pz, theme, px, dpr, guideImg) {
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 24 * dpr; ctx.fillStyle = theme.base;
  ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(0, 0, W, H, 0.03); else ctx.rect(0, 0, W, H); ctx.fill(); ctx.restore();
  ctx.save(); ctx.clip(); ctx.scale(px, px); ctx.fillStyle = texture(ctx, theme.tex); ctx.fillRect(0, 0, W / px, H / px); ctx.restore();
  if (!pz) return;
  ctx.fillStyle = theme.well; ctx.fillRect(pz.FX, pz.FY, pz.PW, pz.PH);
  if (guideImg) { ctx.globalAlpha = 0.22; ctx.drawImage(guideImg, pz.FX, pz.FY, pz.PW, pz.PH); ctx.globalAlpha = 1; }
  ctx.setLineDash([6 * px, 5 * px]); ctx.lineWidth = 1.2 * px; ctx.strokeStyle = theme.frame; ctx.strokeRect(pz.FX, pz.FY, pz.PW, pz.PH); ctx.setLineDash([]);
}
