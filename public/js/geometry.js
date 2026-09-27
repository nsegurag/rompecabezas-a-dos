// Forma de las piezas y "sprites" pre-dibujados. Todo sale de (n, seed),
// así que todos los jugadores ven exactamente las mismas piezas.
export const W = 3, H = 2, FX = 1, FY = 0.5, PAD = 0.36;

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

export function buildGeometry(n, seed) {
  const r = rng(seed), Hh = [], Vv = [];
  const rnd = () => ({ j: (r() - 0.5) * 0.1, k: (0.88 + r() * 0.22) * (r() < 0.5 ? 1 : -1) });
  for (let i = 0; i < n - 1; i++) { Hh.push([]); for (let c = 0; c < n; c++) { const q = rnd(); Hh[i].push(mkEdge((u, v) => [c + u, i + 1 + v], q.j, q.k)); } }
  for (let rr = 0; rr < n; rr++) { Vv.push([]); for (let j = 0; j < n - 1; j++) { const q = rnd(); Vv[rr].push(mkEdge((u, v) => [j + 1 + v, rr + u], q.j, q.k)); } }
  const paths = [];
  for (let rr = 0; rr < n; rr++) for (let c = 0; c < n; c++) {
    const p = new Path2D(); p.moveTo(c, rr);
    if (rr === 0) p.lineTo(c + 1, rr); else addEdge(p, Hh[rr - 1][c], false);
    if (c === n - 1) p.lineTo(c + 1, rr + 1); else addEdge(p, Vv[rr][c], false);
    if (rr === n - 1) p.lineTo(c, rr + 1); else addEdge(p, Hh[rr][c], true);
    if (c === 0) p.lineTo(c, rr); else addEdge(p, Vv[rr][c - 1], true);
    p.closePath(); paths.push(p);
  }
  return { n, paths };
}

export function buildSprites(img, n, geo) {
  const pp = img.naturalWidth / n, sz = Math.ceil((1 + 2 * PAD) * pp), off = sz * 3, out = [];
  for (let i = 0; i < n * n; i++) {
    const r = Math.floor(i / n), c = i % n, path = geo.paths[i];
    const a = document.createElement('canvas'); a.width = a.height = sz;
    const x = a.getContext('2d');
    x.setTransform(pp, 0, 0, pp, -(c - PAD) * pp, -(r - PAD) * pp);
    x.save(); x.clip(path); x.drawImage(img, 0, 0, n, n);
    x.lineWidth = 0.05;
    x.save(); x.translate(0.018, 0.018); x.strokeStyle = 'rgba(255,255,255,.30)'; x.stroke(path); x.restore();
    x.save(); x.translate(-0.018, -0.018); x.strokeStyle = 'rgba(0,0,0,.32)'; x.stroke(path); x.restore();
    x.lineWidth = 0.014; x.strokeStyle = 'rgba(0,0,0,.35)'; x.stroke(path); x.restore();
    const b = document.createElement('canvas'); b.width = b.height = sz;
    const y = b.getContext('2d');
    y.setTransform(pp, 0, 0, pp, -(c - PAD) * pp - off, -(r - PAD) * pp);
    y.shadowColor = 'rgba(0,0,0,.55)'; y.shadowBlur = Math.max(2, 0.09 * pp);
    y.shadowOffsetX = off; y.shadowOffsetY = Math.max(1, 0.035 * pp);
    y.fillStyle = '#000'; y.fill(path);
    out.push({ img: a, sh: b });
  }
  return out;
}

export const isEdge = (i, n) => { const r = Math.floor(i / n), c = i % n; return r === 0 || c === 0 || r === n - 1 || c === n - 1; };
