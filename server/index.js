'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('./puzzle');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ROOM_TTL_DAYS = Number(process.env.ROOM_TTL_DAYS) || 30;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_CALL = 6;
// Solo para pruebas automáticas: acorta los minutos del reloj (por defecto 1 minuto = 60000 ms).
const MINUTE = Number(process.env.RZ_MINUTE_MS) || 60000;
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const IMG_DIR = path.join(DATA_DIR, 'images');
const MAXES = [2, 4, 8, 12];
const MODES = ['classic', 'timed', 'race'];
const LIMITS = [3, 5, 10, 15, 20, 30, 45, 60];
const COLORS = ['#f2b134', '#5ec8e5', '#ff7a8a', '#8be07a', '#c59bff', '#ff9f45', '#4fd1b5', '#f78fd6'];
fs.mkdirSync(ROOMS_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

/* ------------------------------------------------------------ identidad */
// Cada navegador guarda un identificador secreto (uid). A los demás solo se les
// muestra "pub", una huella derivada que no permite suplantarlo.
const pubOf = uid => (/^[a-f0-9]{32}$/.test(String(uid)) ? crypto.createHash('sha256').update('rz:' + uid).digest('hex').slice(0, 16) : null);
function hashPassword(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') }; }
function checkPassword(r, pw) {
  if (!r.pw) return true;
  if (typeof pw !== 'string' || !pw) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, r.pw.salt, 32), Buffer.from(r.pw.hash, 'hex'));
}
const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '').trim().slice(0, max);

/* ------------------------------------------------------------------ salas */
const rooms = new Map();

function migratePuzzle(pz) {
  // Salas de versiones anteriores (rompecabezas cuadrado de n x n y un solo tablero).
  if (pz.n && !pz.cols) {
    Object.assign(pz, { cols: pz.n, rows: pz.n, ratio: '1:1', aspect: 1, ...P.frame(1), mode: 'classic', limit: 0,
      boards: { shared: { groups: pz.groups, z: pz.z || 0, doneAt: pz.doneAt || null } } });
    delete pz.n; delete pz.groups; delete pz.z;
  }
  pz.scores = pz.scores || {};
  pz.log = pz.log || {};
  pz.race = pz.race || { state: 'running', startAt: pz.createdAt, endAt: null, results: [] };
  return pz;
}
function hydrate(r) {
  r.admins = r.admins || []; r.bans = r.bans || []; r.muted = r.muted || []; r.viewers = r.viewers || [];
  r.perms = { photo: 'all', arrange: 'all', ...(r.perms || {}) };
  r.pw = r.pw || null; r.owner = r.owner || null;
  if (r.puzzle) migratePuzzle(r.puzzle);
  Object.defineProperty(r, 'rt', {
    value: { clients: new Set(), holds: new Map(), chat: [], saveT: null, lastArrange: new Map(), timers: [], progressT: null },
    enumerable: false, writable: true,
  });
  return r;
}
function loadRooms() {
  for (const f of fs.readdirSync(ROOMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const r = hydrate(JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), 'utf8'))); rooms.set(r.code, r); armTimers(r); }
    catch (e) { console.warn('No se pudo leer', f, e.message); }
  }
  console.log(`Salas cargadas: ${rooms.size}`);
}
function save(r, now = false) {
  clearTimeout(r.rt.saveT);
  const write = () => {
    if (!rooms.has(r.code)) return;
    const file = path.join(ROOMS_DIR, r.code + '.json'), tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(r), err => {
      if (err) return console.error('Error guardando', r.code, err.message);
      fs.rename(tmp, file, e => e && console.error('Error guardando', r.code, e.message));
    });
  };
  if (now) write(); else r.rt.saveT = setTimeout(write, 1000);
}
function deleteRoom(r) {
  clearTimeout(r.rt.saveT); r.rt.timers.forEach(clearTimeout);
  rooms.delete(r.code);
  fs.rm(path.join(ROOMS_DIR, r.code + '.json'), { force: true }, () => {});
  if (r.puzzle && r.puzzle.img) fs.rm(path.join(IMG_DIR, r.puzzle.img), { force: true }, () => {});
}
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = ''; const b = crypto.randomBytes(5);
    for (let i = 0; i < 5; i++) s += A[b[i] % A.length];
    if (!rooms.has(s)) return s;
  }
}

function roleOf(r, pub) {
  if (!pub) return 'player';
  if (r.owner === pub) return 'owner';
  if (r.admins.includes(pub)) return 'admin';
  if (r.viewers.includes(pub)) return 'viewer';
  return 'player';
}
const isStaff = (r, pub) => { const ro = roleOf(r, pub); return ro === 'owner' || ro === 'admin'; };
// Iniciar, reiniciar o continuar la partida: los admins, o cualquiera si no hay admins conectados.
function canControl(r, ws) {
  if (roleOf(r, ws.pub) === 'viewer') return false;
  if (isStaff(r, ws.pub)) return true;
  return ![...r.rt.clients].some(c => isStaff(r, c.pub));
}

/* --------------------------------------------------------- rompecabezas */
function saveImage(code, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpErr(400, 'La imagen no es válida.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw httpErr(413, 'La imagen pesa demasiado.');
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8, isPng = buf[0] === 0x89 && buf[1] === 0x50,
        isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  if (!isJpg && !isPng && !isWebp) throw httpErr(400, 'Formato de imagen no soportado.');
  const ext = isJpg ? 'jpg' : isPng ? 'png' : 'webp';
  const name = `${code}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(IMG_DIR, name), buf);
  return name;
}
/** Crea un rompecabezas nuevo a partir de las opciones del asistente. */
function buildPuzzle({ img, ratio, pieces, mode, limit }) {
  if (!P.RATIOS[ratio]) throw httpErr(400, 'Proporción de foto no válida.');
  pieces = Number(pieces);
  if (!P.TARGETS.includes(pieces)) throw httpErr(400, 'Número de piezas no válido.');
  mode = MODES.includes(mode) ? mode : 'classic';
  limit = Number(limit) || 0;
  if (mode === 'timed' && !LIMITS.includes(limit)) limit = 10;
  if (mode === 'race' && limit && !LIMITS.includes(limit)) limit = 0;
  if (mode === 'classic') limit = 0;
  const aspect = P.RATIOS[ratio], { cols, rows } = P.grid(aspect, pieces);
  const pz = {
    id: crypto.randomBytes(4).toString('hex'), img, ratio, aspect, pieces, cols, rows, ...P.frame(aspect),
    seed: crypto.randomInt(1, 2147483647), mode, limit: limit * MINUTE, createdAt: Date.now(), doneAt: null,
    boards: {}, scores: {}, log: {},
    race: mode === 'classic' ? { state: 'running', startAt: Date.now(), endAt: null, results: [] } : { state: 'waiting', startAt: null, endAt: null, results: [] },
  };
  if (mode !== 'race') pz.boards.shared = P.createBoard(P.spec(pz), pz.seed);
  return pz;
}
function ensureBoard(r, ws) {
  const pz = r.puzzle;
  if (pz.mode !== 'race' || roleOf(r, ws.pub) === 'viewer') return;
  if (!pz.boards[ws.pub]) {
    if (pz.race.state === 'finished') return;
    pz.boards[ws.pub] = P.createBoard(P.spec(pz), pz.seed);
  }
  pz.boards[ws.pub].name = ws.name; pz.boards[ws.pub].color = ws.color;
}
function keyFor(r, ws) {
  const pz = r.puzzle;
  if (pz.mode !== 'race') return 'shared';
  if (ws.watch && pz.boards[ws.watch]) return ws.watch;
  if (pz.boards[ws.pub]) return ws.pub;
  const any = Object.keys(pz.boards)[0];
  return any || ws.pub;
}
function puzzleMeta(r) {
  const pz = r.puzzle;
  return { id: pz.id, img: '/img/' + pz.img, ratio: pz.ratio, aspect: pz.aspect, cols: pz.cols, rows: pz.rows, pieces: pz.pieces || pz.cols * pz.rows,
    PW: pz.PW, PH: pz.PH, FX: pz.FX, FY: pz.FY, seed: pz.seed, mode: pz.mode, limit: pz.limit, createdAt: pz.createdAt, doneAt: pz.doneAt, scores: pz.scores };
}
function boardView(r, key) {
  const b = r.puzzle.boards[key];
  const holds = [];
  for (const [hk, h] of r.rt.holds) if (hk.startsWith(key + '|')) holds.push([hk.slice(key.length + 1), h.by]);
  return { key, groups: b ? b.groups : null, doneAt: b ? b.doneAt : null, holds };
}
function raceView(r) { const x = r.puzzle.race; return { state: x.state, startAt: x.startAt, endAt: x.endAt, results: x.results, limit: r.puzzle.limit }; }
function progressOf(r) {
  const pz = r.puzzle, sp = P.spec(pz), out = {};
  for (const [key, b] of Object.entries(pz.boards)) {
    const s = P.stats(b, sp);
    out[key] = { name: b.name || '', color: b.color || '#888', pct: s.progress, placed: s.placed, total: s.total, doneMs: b.doneAt && pz.race.startAt ? b.doneAt - pz.race.startAt : null };
  }
  return out;
}
function roomView(r) { return { code: r.code, name: r.name, public: r.public, max: r.max, hasPassword: !!r.pw, perms: r.perms }; }
function roomSummary(r) {
  const pz = r.puzzle, sp = P.spec(pz);
  const b = pz.boards.shared || Object.values(pz.boards)[0];
  const st = b ? P.stats(b, sp) : { total: pz.cols * pz.rows, progress: 0, placed: 0 };
  return { code: r.code, name: r.name, public: r.public, max: r.max, hasPassword: !!r.pw, players: r.rt.clients.size, mode: pz.mode, ratio: pz.ratio,
    pieces: st.total, progress: st.progress, done: !!pz.doneAt, img: '/img/' + pz.img, lastActive: r.lastActive };
}
function logEvent(r, key, entry) {
  const pz = r.puzzle, list = pz.log[key] || (pz.log[key] = []);
  if (list.length < 20000) list.push([Date.now() - (pz.race.startAt || pz.createdAt), ...entry]);
}

/* -------------------------------------------------- estados de la partida */
function armTimers(r) {
  r.rt.timers.forEach(clearTimeout); r.rt.timers = [];
  const pz = r.puzzle, race = pz.race, now = Date.now();
  if (race.state === 'countdown') r.rt.timers.push(setTimeout(() => goRunning(r), Math.max(0, race.startAt - now)));
  if ((race.state === 'running' || race.state === 'countdown') && pz.limit && pz.mode !== 'classic') {
    r.rt.timers.push(setTimeout(() => timeUp(r), Math.max(0, race.startAt + pz.limit - now)));
  }
}
function pushRace(r) { broadcast(r, { t: 'race', race: raceView(r), progress: progressOf(r), now: Date.now() }); }
function pushProgressSoon(r) {
  if (r.rt.progressT) return;
  r.rt.progressT = setTimeout(() => { r.rt.progressT = null; broadcast(r, { t: 'progress', progress: progressOf(r) }); }, 400);
}
function startGame(r) {
  const pz = r.puzzle;
  if (pz.race.state !== 'waiting') return;
  if (pz.mode === 'race') for (const c of r.rt.clients) { ensureBoard(r, c); if (!c.watch) sendBoard(r, c); }
  pz.race.state = 'countdown'; pz.race.startAt = Date.now() + 3500;
  armTimers(r); pushRace(r); save(r);
}
function goRunning(r) {
  const race = r.puzzle.race;
  if (race.state !== 'countdown') return;
  race.state = 'running'; pushRace(r); save(r);
}
function releaseAll(r) { for (const [hk] of r.rt.holds) { const [key, gid] = hk.split('|'); broadcastBoard(r, key, { t: 'release', gid }); } r.rt.holds.clear(); }
function timeUp(r) {
  const pz = r.puzzle;
  if (pz.race.state !== 'running' && pz.race.state !== 'countdown') return;
  releaseAll(r);
  if (pz.mode === 'race') return finishRace(r);
  pz.race.state = 'timeout'; pz.race.endAt = Date.now();
  pushRace(r); save(r);
}
function finishRace(r) {
  const race = r.puzzle.race;
  if (race.state === 'finished') return;
  releaseAll(r); r.rt.timers.forEach(clearTimeout);
  race.state = 'finished'; race.endAt = Date.now();
  pushRace(r); save(r);
}
function boardDone(r, key, ws) {
  const pz = r.puzzle, b = pz.boards[key], now = Date.now();
  b.doneAt = now;
  if (pz.mode === 'race') {
    pz.race.results.push({ pub: key, name: b.name, color: b.color, ms: now - pz.race.startAt });
    pushRace(r);
    const players = [...r.rt.clients].filter(c => roleOf(r, c.pub) !== 'viewer' && pz.boards[c.pub]);
    if (players.every(c => pz.boards[c.pub].doneAt)) finishRace(r);
  } else {
    pz.doneAt = now;
    if (pz.mode === 'timed') { r.rt.timers.forEach(clearTimeout); pz.race.state = 'finished'; pz.race.endAt = now; }
    broadcast(r, { t: 'done', doneAt: now, scores: pz.scores });
    pushRace(r);
  }
}
/** Nueva partida en la misma sala (foto nueva o la misma). */
function replacePuzzle(r, pz, by) {
  const old = r.puzzle && r.puzzle.img;
  r.puzzle = pz;
  r.rt.holds.clear(); r.rt.timers.forEach(clearTimeout); r.rt.timers = [];
  r.lastActive = Date.now();
  if (old && old !== pz.img) fs.rm(path.join(IMG_DIR, old), { force: true }, () => {});
  for (const c of r.rt.clients) { c.watch = null; ensureBoard(r, c); }
  for (const c of r.rt.clients) {
    send(c, { t: 'puzzle', puzzle: puzzleMeta(r), board: boardView(r, keyFor(r, c)), race: raceView(r), progress: progressOf(r), by, now: Date.now() });
  }
  save(r, true);
}
function samePuzzleOpts(pz, over = {}) {
  return { img: pz.img, ratio: pz.ratio, pieces: pz.pieces || 16, mode: pz.mode, limit: pz.limit / MINUTE, ...over };
}

/* ------------------------------------------------------------------ http */
function httpErr(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpErr(413, 'La imagen pesa demasiado.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(httpErr(400, 'Solicitud no válida.')); } });
    req.on('error', reject);
  });
}
const createHits = new Map();
function rateLimited(ip) {
  const now = Date.now(), list = (createHits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); createHits.set(ip, list);
  return list.length > 30;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
// Galería y música casi nunca cambian: se guardan en el navegador una semana.
const STATIC_CACHE = /^\/(galeria|musica)\/.+\.(jpg|jpeg|png|webp|mp3|ogg|m4a)$/i;
function sendFile(res, file, cache, req) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (cache === 'img' || cache === 'media') { res.writeHead(404); return res.end(); }
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
    }
    const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes',
      'Cache-Control': cache === 'img' ? 'public, max-age=31536000, immutable' : cache === 'media' ? 'public, max-age=604800' : 'no-cache' };
    // Rangos de bytes: Safari los exige para reproducir audio.
    const rg = req && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg && (rg[1] || rg[2])) {
      let a = rg[1] ? Number(rg[1]) : Math.max(0, st.size - Number(rg[2])), b = rg[1] && rg[2] ? Number(rg[2]) : st.size - 1;
      b = Math.min(b, st.size - 1);
      if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
      return fs.createReadStream(file, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS) list.push({ urls: process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
  return list;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (p === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
    if (p === '/api/ice') return json(res, 200, { iceServers: iceServers() });

    if (p === '/api/rooms' && req.method === 'GET') {
      const list = [...rooms.values()].filter(r => r.public).sort((a, b) => (b.rt.clients.size - a.rt.clients.size) || (b.lastActive - a.lastActive)).slice(0, 60).map(roomSummary);
      return json(res, 200, { rooms: list });
    }
    if (p === '/api/rooms' && req.method === 'POST') {
      if (rateLimited(ip)) throw httpErr(429, 'Has creado demasiadas salas. Intenta más tarde.');
      if (rooms.size >= MAX_ROOMS) throw httpErr(503, 'El servidor está lleno. Intenta más tarde.');
      const b = await readJson(req, 9e6);
      const owner = pubOf(b.uid);
      if (!owner) throw httpErr(400, 'Falta el identificador del navegador. Recarga la página.');
      const code = newCode(), pw = cleanText(b.password, 40);
      const opts = { ratio: b.ratio, pieces: b.pieces, mode: b.mode, limit: b.limit };
      buildPuzzle({ ...opts, img: 'x' }); // valida antes de guardar la foto
      const r = hydrate({
        code, name: cleanText(b.name, 40) || 'Sala ' + code, public: !!b.public,
        max: MAXES.includes(Number(b.max)) ? Number(b.max) : 4, owner, pw: pw ? hashPassword(pw) : null,
        createdAt: Date.now(), lastActive: Date.now(), puzzle: buildPuzzle({ ...opts, img: saveImage(code, b.image) }),
      });
      rooms.set(code, r); save(r, true);
      return json(res, 201, { code });
    }
    let m = /^\/api\/rooms\/([A-Z0-9]{5})$/.exec(p);
    if (m && req.method === 'GET') {
      const r = rooms.get(m[1]);
      if (!r) return json(res, 404, { error: 'No existe una sala con ese código.' });
      return json(res, 200, roomSummary(r));
    }
    m = /^\/api\/rooms\/([A-Z0-9]{5})\/puzzle$/.exec(p);
    if (m && req.method === 'POST') {
      const r = rooms.get(m[1]);
      if (!r) throw httpErr(404, 'La sala ya no existe.');
      const b = await readJson(req, 9e6);
      const pub = pubOf(b.uid), role = roleOf(r, pub);
      if (!pub || r.bans.some(x => x.pub === pub)) throw httpErr(403, 'No puedes cambiar la partida de esta sala.');
      if (role === 'viewer' || (r.perms.photo === 'admin' && !isStaff(r, pub))) throw httpErr(403, 'Solo los administradores de la sala pueden empezar otra partida.');
      if (![...r.rt.clients].some(c => c.pub === pub)) throw httpErr(403, 'Entra a la sala para cambiar la partida.');
      let opts;
      if (b.sameImage) opts = samePuzzleOpts(r.puzzle, { pieces: b.pieces, mode: b.mode, limit: b.limit });
      else {
        if (rateLimited(ip)) throw httpErr(429, 'Demasiadas fotos nuevas. Intenta más tarde.');
        opts = { ratio: b.ratio, pieces: b.pieces, mode: b.mode, limit: b.limit };
        buildPuzzle({ ...opts, img: 'x' });
        opts.img = saveImage(r.code, b.image);
      }
      replacePuzzle(r, buildPuzzle(opts), cleanText(b.by, 24));
      return json(res, 200, { ok: true });
    }
    m = /^\/api\/rooms\/([A-Z0-9]{5})\/replay$/.exec(p);
    if (m && req.method === 'GET') {
      const r = rooms.get(m[1]);
      if (!r) throw httpErr(404, 'La sala ya no existe.');
      const pz = r.puzzle, key = url.searchParams.get('key') || 'shared';
      if (!pz.boards[key]) throw httpErr(404, 'No hay un armado para mostrar.');
      const initial = P.createBoard(P.spec(pz), pz.seed).groups;
      return json(res, 200, { ...puzzleMeta(r), room: r.name, key, who: pz.boards[key].name || null,
        initial, events: pz.log[key] || [], startAt: pz.race.startAt || pz.createdAt, doneAt: pz.boards[key].doneAt });
    }
    m = /^\/img\/([A-Za-z0-9-]+\.(jpg|png|webp))$/.exec(p);
    if (m) return sendFile(res, path.join(IMG_DIR, m[1]), 'img');
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Método no permitido.' });

    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p)));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    return sendFile(res, p.endsWith('/') ? path.join(file, 'index.html') : file, STATIC_CACHE.test(p) ? 'media' : 'no-cache', req);
  } catch (e) {
    if (!e.expose) console.error(e);
    json(res, e.status || 500, { error: e.expose ? e.message : 'Error del servidor.' });
  }
});

/* ------------------------------------------------------------ tiempo real */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 128 * 1024 });

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(r, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of r.rt.clients) if (c !== except && c.readyState === 1) c.send(s);
}
function broadcastBoard(r, key, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of r.rt.clients) if (c !== except && c.readyState === 1 && c.board === key) c.send(s);
}
function sendBoard(r, ws) { ws.board = keyFor(r, ws); send(ws, { t: 'board', board: boardView(r, ws.board) }); }
function playersOf(r) {
  return [...r.rt.clients].map(c => ({ id: c.id, pub: c.pub, name: c.name, color: c.color, role: roleOf(r, c.pub), muted: r.muted.includes(c.pub), media: c.media }));
}
function pushPlayers(r) { broadcast(r, { t: 'players', players: playersOf(r) }); }
function pushRoom(r) {
  broadcast(r, { t: 'room', room: roomView(r) });
  for (const c of r.rt.clients) if (isStaff(r, c.pub)) send(c, { t: 'admin', bans: r.bans });
}
function release(r, ws) {
  for (const [hk, h] of r.rt.holds) if (h.by === ws.id) { r.rt.holds.delete(hk); const [key, gid] = hk.split('|'); broadcastBoard(r, key, { t: 'release', gid }); }
}
function leave(ws) {
  const r = ws.room; if (!r) return;
  release(r, ws); r.rt.clients.delete(ws); ws.room = null;
  pushPlayers(r);
  broadcast(r, { t: 'cursor', id: ws.id, x: null, y: null });
  // En una carrera, si solo quedan jugadores que ya terminaron, se cierra.
  const pz = r.puzzle;
  if (pz.mode === 'race' && pz.race.state === 'running') {
    const players = [...r.rt.clients].filter(c => roleOf(r, c.pub) !== 'viewer' && pz.boards[c.pub]);
    if (players.length && players.every(c => pz.boards[c.pub].doneAt)) finishRace(r);
  }
}
function expel(r, target, t, reason) {
  send(target, { t, reason });
  leave(target);
  setTimeout(() => { try { target.close(4001); } catch {} }, 150);
}
function findClient(r, id) { for (const c of r.rt.clients) if (c.id === id) return c; return null; }

function handleAdmin(ws, r, m) {
  const myRole = roleOf(r, ws.pub);
  const staff = myRole === 'owner' || myRole === 'admin', owner = myRole === 'owner';
  const deny = text => send(ws, { t: 'notice', text });
  if (!staff) return deny('Solo los administradores pueden hacer eso.');
  const target = m.target ? findClient(r, String(m.target)) : null;
  const tRole = target ? roleOf(r, target.pub) : null;
  const canTouch = target && target !== ws && (owner || (tRole !== 'owner' && tRole !== 'admin'));

  switch (m.a) {
    case 'kick': case 'ban': {
      if (!canTouch) return deny('No puedes sacar a esa persona.');
      if (m.a === 'ban' && !r.bans.some(b => b.pub === target.pub)) r.bans.push({ pub: target.pub, name: target.name, at: Date.now() });
      if (m.a === 'ban') r.admins = r.admins.filter(p => p !== target.pub);
      for (const c of [...r.rt.clients]) if (c.pub === target.pub) expel(r, c, 'kicked', m.a);
      broadcast(r, { t: 'notice', text: `${target.name} ${m.a === 'ban' ? 'fue bloqueado de' : 'salió de'} la sala.` });
      break;
    }
    case 'unban': r.bans = r.bans.filter(b => b.pub !== m.pub); break;
    case 'mute': {
      if (!canTouch) return deny('No puedes silenciar a esa persona.');
      r.muted = r.muted.filter(p => p !== target.pub);
      if (m.on) r.muted.push(target.pub);
      break;
    }
    case 'role': {
      if (!canTouch) return deny('No puedes cambiar el rol de esa persona.');
      const want = m.role;
      if (want === 'admin' && !owner) return deny('Solo el dueño de la sala nombra administradores.');
      if (!['admin', 'player', 'viewer'].includes(want)) return;
      r.admins = r.admins.filter(p => p !== target.pub);
      r.viewers = r.viewers.filter(p => p !== target.pub);
      if (want === 'admin') r.admins.push(target.pub);
      if (want === 'viewer') release(r, target);
      if (want === 'viewer') r.viewers.push(target.pub);
      else { ensureBoard(r, target); sendBoard(r, target); }
      break;
    }
    case 'transfer': {
      if (!owner || !target || target === ws) return deny('Solo el dueño puede transferir la sala.');
      r.admins = r.admins.filter(p => p !== target.pub); r.viewers = r.viewers.filter(p => p !== target.pub);
      r.admins.push(ws.pub); r.owner = target.pub;
      broadcast(r, { t: 'notice', text: `${target.name} ahora es el dueño de la sala.` });
      break;
    }
    case 'settings': {
      if (typeof m.name === 'string') r.name = cleanText(m.name, 40) || r.name;
      if (typeof m.public === 'boolean') r.public = m.public;
      if (MAXES.includes(Number(m.max))) r.max = Number(m.max);
      if (m.perms) {
        if (['all', 'admin'].includes(m.perms.photo)) r.perms.photo = m.perms.photo;
        if (['all', 'admin'].includes(m.perms.arrange)) r.perms.arrange = m.perms.arrange;
      }
      break;
    }
    case 'password': {
      const pw = cleanText(m.password, 40);
      r.pw = pw ? hashPassword(pw) : null;
      send(ws, { t: 'notice', text: pw ? 'Contraseña guardada.' : 'La sala ya no tiene contraseña.' });
      break;
    }
    case 'delete': {
      if (!owner) return deny('Solo el dueño puede cerrar la sala.');
      for (const c of [...r.rt.clients]) expel(r, c, 'closed', 'delete');
      deleteRoom(r);
      return;
    }
    default: return;
  }
  r.lastActive = Date.now();
  save(r); pushPlayers(r); pushRoom(r);
}

wss.on('connection', ws => {
  ws.id = crypto.randomBytes(6).toString('hex');
  ws.alive = true; ws.room = null; ws.lastCursor = 0; ws.lastChat = 0; ws.reacts = []; ws.rtcCount = 0;
  ws.media = { call: false, mic: false, cam: false };
  ws.on('pong', () => { ws.alive = true; });
  ws.on('close', () => leave(ws));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const r = ws.room;

    if (m.t === 'join') {
      const room = rooms.get(String(m.room || '').toUpperCase());
      if (!room) return send(ws, { t: 'fatal', code: 'missing', error: 'No existe una sala con ese código.' });
      if (ws.room) leave(ws);
      ws.pub = pubOf(m.uid) || ('anon' + ws.id);
      if (!room.owner && pubOf(m.uid)) { room.owner = ws.pub; save(room); } // salas antiguas sin dueño
      if (room.bans.some(b => b.pub === ws.pub)) return send(ws, { t: 'fatal', code: 'banned', error: 'El administrador te bloqueó de esta sala.' });
      const staff = isStaff(room, ws.pub);
      if (!staff && !checkPassword(room, m.password)) {
        return send(ws, { t: 'fatal', code: 'password', error: m.password ? 'Contraseña incorrecta.' : 'Esta sala tiene contraseña.' });
      }
      const others = [...room.rt.clients].filter(c => c.pub !== ws.pub);
      if (!staff && others.length >= room.max) return send(ws, { t: 'fatal', code: 'full', error: `La sala está llena (máximo ${room.max} jugadores).` });
      ws.name = cleanText(m.name, 24) || 'Jugador';
      ws.color = COLORS.includes(m.color) ? m.color : COLORS[0];
      ws.media = { call: false, mic: false, cam: false }; ws.watch = null;
      ws.room = room; room.rt.clients.add(ws); room.lastActive = Date.now();
      ensureBoard(room, ws);
      ws.board = keyFor(room, ws);
      send(ws, { t: 'welcome', you: ws.id, pub: ws.pub, room: roomView(room), puzzle: puzzleMeta(room), board: boardView(room, ws.board),
        race: raceView(room), progress: progressOf(room), players: playersOf(room), chat: room.rt.chat, now: Date.now() });
      if (staff) send(ws, { t: 'admin', bans: room.bans });
      broadcast(room, { t: 'players', players: playersOf(room) }, ws);
      if (room.puzzle.mode === 'race') pushProgressSoon(room);
      return;
    }
    if (!r) return;
    const pz = r.puzzle, sp = P.spec(pz);
    const role = roleOf(r, ws.pub);
    const key = ws.board, board = pz.boards[key];
    const hk = gid => key + '|' + gid;
    const canPlay = () => role !== 'viewer' && pz.race.state === 'running' && board && !board.doneAt && (pz.mode !== 'race' || key === ws.pub);

    switch (m.t) {
      case 'profile':
        ws.name = cleanText(m.name, 24) || ws.name;
        if (COLORS.includes(m.color)) ws.color = m.color;
        if (pz.boards[ws.pub]) { pz.boards[ws.pub].name = ws.name; pz.boards[ws.pub].color = ws.color; }
        pushPlayers(r);
        break;
      case 'grab': {
        const gid = String(m.gid), g = board && board.groups[gid];
        const reason = role === 'viewer' ? 'viewer' : pz.race.state !== 'running' ? pz.race.state : (pz.mode === 'race' && key !== ws.pub) ? 'watching' : null;
        if (reason || !canPlay()) return send(ws, { t: 'deny', gid, reason: reason || 'done' });
        const h = r.rt.holds.get(hk(gid));
        if (m.pid !== pz.id || !g || g.locked || (h && h.by !== ws.id)) return send(ws, { t: 'deny', gid, reason: g && g.locked ? 'locked' : 'held' });
        release(r, ws);
        r.rt.holds.set(hk(gid), { by: ws.id, at: Date.now() });
        broadcastBoard(r, key, { t: 'grab', gid, by: ws.id });
        break;
      }
      case 'move': {
        const gid = String(m.gid), h = r.rt.holds.get(hk(gid));
        if (!h || h.by !== ws.id || !isFinite(m.x) || !isFinite(m.y)) return;
        h.at = Date.now();
        broadcastBoard(r, key, { t: 'move', gid, x: +m.x, y: +m.y, by: ws.id }, ws);
        break;
      }
      case 'drop': {
        const gid = String(m.gid), h = r.rt.holds.get(hk(gid));
        if (!h || h.by !== ws.id) return send(ws, { t: 'release', gid });
        r.rt.holds.delete(hk(gid));
        if (!canPlay()) { broadcastBoard(r, key, { t: 'release', gid }); return; }
        const res = P.drop(board, sp, gid, +m.x, +m.y, k => r.rt.holds.has(hk(k)));
        if (!res) { broadcastBoard(r, key, { t: 'release', gid }); return; }
        r.lastActive = Date.now();
        logEvent(r, key, ['d', res.target, res.x, res.y, res.del, res.locked ? 1 : 0]);
        let score = null;
        if (res.joins || res.placed) {
          const sc = pz.scores[ws.pub] || (pz.scores[ws.pub] = { joins: 0, placed: 0 });
          sc.name = ws.name; sc.color = ws.color; sc.joins += res.joins; sc.placed += res.placed;
          score = { pub: ws.pub, ...sc };
        }
        broadcastBoard(r, key, { t: 'update', set: res.set, del: res.del, gid, by: ws.id, merged: res.merged, locked: res.locked, score });
        if (Object.keys(board.groups).length === 1 && !board.doneAt) boardDone(r, key, ws);
        else if (pz.mode === 'race' || pz.mode === 'timed') pushProgressSoon(r);
        save(r);
        break;
      }
      case 'arrange': {
        if (role === 'viewer' || (r.perms.arrange === 'admin' && !isStaff(r, ws.pub))) return send(ws, { t: 'notice', text: 'Solo los administradores pueden ordenar las piezas en esta sala.' });
        if (!canPlay()) return send(ws, { t: 'notice', text: 'Ahora no se pueden mover piezas.' });
        if (Date.now() - (r.rt.lastArrange.get(key) || 0) < 2000) return;
        r.rt.lastArrange.set(key, Date.now());
        const res = P.arrange(board, sp, k => r.rt.holds.has(hk(k)));
        const pos = {}; for (const [k, g] of Object.entries(res.set)) pos[k] = [g.x, g.y];
        logEvent(r, key, ['a', pos]);
        broadcastBoard(r, key, { t: 'update', set: res.set, del: [], by: ws.id, arranged: true });
        save(r);
        break;
      }
      case 'start': {
        if (!canControl(r, ws)) return send(ws, { t: 'notice', text: 'Solo un administrador puede empezar la partida.' });
        startGame(r);
        break;
      }
      case 'finish': {
        if (!canControl(r, ws)) return send(ws, { t: 'notice', text: 'Solo un administrador puede terminar la carrera.' });
        if (pz.mode === 'race' && pz.race.state === 'running') finishRace(r);
        break;
      }
      case 'continue': { // contrarreloj agotado: seguir sin límite
        if (!canControl(r, ws)) return send(ws, { t: 'notice', text: 'Solo un administrador puede decidir.' });
        if (pz.mode === 'timed' && pz.race.state === 'timeout') { pz.mode = 'classic'; pz.limit = 0; pz.race.state = 'running'; broadcast(r, { t: 'mode', mode: 'classic', limit: 0 }); pushRace(r); save(r); }
        break;
      }
      case 'restart': { // la misma foto, piezas revueltas otra vez
        if (!canControl(r, ws)) return send(ws, { t: 'notice', text: 'Solo un administrador puede reiniciar.' });
        replacePuzzle(r, buildPuzzle(samePuzzleOpts(pz)), ws.name);
        break;
      }
      case 'watch': { // carrera: mirar el tablero de otro jugador (o volver al propio)
        if (pz.mode !== 'race') return;
        const want = m.board ? String(m.board) : null;
        if (want && !pz.boards[want]) return;
        release(r, ws);
        ws.watch = want && want !== ws.pub ? want : null;
        sendBoard(r, ws);
        break;
      }
      case 'cursor': {
        const now = Date.now(); if (now - ws.lastCursor < 30) return; ws.lastCursor = now;
        const x = m.x == null ? null : +m.x, y = m.y == null ? null : +m.y;
        if (x !== null && !isFinite(x)) return;
        broadcastBoard(r, key, { t: 'cursor', id: ws.id, x, y }, ws);
        break;
      }
      case 'react': {
        const now = Date.now(); ws.reacts = ws.reacts.filter(t => now - t < 3000);
        if (ws.reacts.length >= 6) return;
        const e = String(m.e || '');
        if (e.length > 16 || !/\p{Extended_Pictographic}/u.test(e)) return;
        if (!isFinite(m.x) || !isFinite(m.y)) return;
        ws.reacts.push(now);
        broadcast(r, { t: 'react', id: ws.id, e, x: +m.x, y: +m.y, board: key });
        break;
      }
      case 'chat': {
        const now = Date.now(); if (now - ws.lastChat < 400) return; ws.lastChat = now;
        if (r.muted.includes(ws.pub)) return send(ws, { t: 'notice', text: 'Un administrador te silenció en el chat.' });
        const text = cleanText(m.text, 240); if (!text) return;
        const msg = { id: ws.id, name: ws.name, color: ws.color, text, at: now };
        r.rt.chat.push(msg); if (r.rt.chat.length > 60) r.rt.chat.shift();
        broadcast(r, { t: 'chat', msg });
        break;
      }
      case 'media': { // estado de la llamada: dentro/fuera, micrófono, cámara
        const call = !!m.call;
        if (call && !ws.media.call && [...r.rt.clients].filter(c => c.media.call).length >= MAX_CALL) {
          return send(ws, { t: 'notice', text: `La llamada ya tiene ${MAX_CALL} personas, que es el máximo.` });
        }
        if (call && r.muted.includes(ws.pub)) return send(ws, { t: 'notice', text: 'Un administrador te silenció: no puedes entrar a la llamada.' });
        ws.media = { call, mic: call && !!m.mic, cam: call && !!m.cam };
        pushPlayers(r);
        break;
      }
      case 'rtc': { // señalización WebRTC: se reenvía tal cual al destinatario
        if (!ws.media.call) return;
        const to = findClient(r, String(m.to));
        if (!to || !to.media.call || !m.data || typeof m.data !== 'object') return;
        send(to, { t: 'rtc', from: ws.id, data: m.data });
        break;
      }
      case 'admin': handleAdmin(ws, r, m); break;
      case 'ping': send(ws, { t: 'pong', now: Date.now() }); break;
    }
  });
});

// Latidos: cierra conexiones muertas y libera piezas "olvidadas".
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  const now = Date.now();
  for (const r of rooms.values()) for (const [hk, h] of r.rt.holds) if (now - h.at > 45000) {
    r.rt.holds.delete(hk); const [key, gid] = hk.split('|'); broadcastBoard(r, key, { t: 'release', gid });
  }
}, 15000);

// Limpieza: borra salas sin actividad durante ROOM_TTL_DAYS días.
setInterval(() => {
  const limit = Date.now() - ROOM_TTL_DAYS * 864e5;
  for (const r of [...rooms.values()]) if (r.rt.clients.size === 0 && r.lastActive < limit) deleteRoom(r);
  for (const [ip, list] of createHits) if (!list.some(t => Date.now() - t < 3600e3)) createHits.delete(ip);
}, 3600e3);

function shutdown() {
  for (const r of rooms.values()) { clearTimeout(r.rt.saveT); try { fs.writeFileSync(path.join(ROOMS_DIR, r.code + '.json'), JSON.stringify(r)); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loadRooms();
server.listen(PORT, () => console.log(`Rompecabezas a Dos escuchando en http://localhost:${PORT}`));
