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
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const IMG_DIR = path.join(DATA_DIR, 'images');
const SIZES = [3, 4, 6, 8, 10, 12];
const COLORS = ['#f2b134', '#5ec8e5', '#ff7a8a', '#8be07a', '#c59bff', '#ff9f45', '#4fd1b5', '#f78fd6'];
fs.mkdirSync(ROOMS_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

/* ------------------------------------------------------------------ salas */
const rooms = new Map();

function hydrate(r) {
  Object.defineProperty(r, 'rt', {
    value: { clients: new Set(), holds: new Map(), chat: [], saveT: null, lastArrange: 0 },
    enumerable: false, writable: true,
  });
  return r;
}
function loadRooms() {
  for (const f of fs.readdirSync(ROOMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const r = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), 'utf8')); rooms.set(r.code, hydrate(r)); }
    catch (e) { console.warn('No se pudo leer', f, e.message); }
  }
  console.log(`Salas cargadas: ${rooms.size}`);
}
function save(r, now = false) {
  clearTimeout(r.rt.saveT);
  const write = () => {
    const file = path.join(ROOMS_DIR, r.code + '.json'), tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(r), err => {
      if (err) return console.error('Error guardando', r.code, err.message);
      fs.rename(tmp, file, e => e && console.error('Error guardando', r.code, e.message));
    });
  };
  if (now) write(); else r.rt.saveT = setTimeout(write, 800);
}
function deleteRoom(r) {
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
const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '').trim().slice(0, max);

function saveImage(code, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpErr(400, 'La imagen no es válida.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw httpErr(413, 'La imagen pesa demasiado (máximo 3 MB).');
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8, isPng = buf[0] === 0x89 && buf[1] === 0x50,
        isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  if (!isJpg && !isPng && !isWebp) throw httpErr(400, 'Formato de imagen no soportado.');
  const ext = isJpg ? 'jpg' : isPng ? 'png' : 'webp';
  const name = `${code}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(IMG_DIR, name), buf);
  return name;
}
function newPuzzle(code, n, image) {
  n = Number(n);
  if (!SIZES.includes(n)) throw httpErr(400, 'Número de piezas no válido.');
  const img = saveImage(code, image);
  const seed = crypto.randomInt(1, 2147483647);
  return { id: crypto.randomBytes(4).toString('hex'), img, createdAt: Date.now(), doneAt: null, ...P.create(n, seed) };
}
function puzzleView(r) {
  const pz = r.puzzle;
  return { id: pz.id, n: pz.n, seed: pz.seed, img: '/img/' + pz.img, createdAt: pz.createdAt, doneAt: pz.doneAt, groups: pz.groups };
}
function roomSummary(r) {
  const st = P.stats(r.puzzle);
  return { code: r.code, name: r.name, public: r.public, max: r.max, players: r.rt.clients.size,
    pieces: st.total, progress: st.progress, placed: st.placed, done: !!r.puzzle.doneAt, img: '/img/' + r.puzzle.img, lastActive: r.lastActive };
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
  return list.length > 20;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function sendFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (cache === 'img') { res.writeHead(404); return res.end(); }
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': cache === 'img' ? 'public, max-age=31536000, immutable' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (p === '/health') return json(res, 200, { ok: true, rooms: rooms.size });

    if (p === '/api/rooms' && req.method === 'GET') {
      const list = [...rooms.values()].filter(r => r.public).sort((a, b) => (b.rt.clients.size - a.rt.clients.size) || (b.lastActive - a.lastActive)).slice(0, 60).map(roomSummary);
      return json(res, 200, { rooms: list });
    }
    if (p === '/api/rooms' && req.method === 'POST') {
      if (rateLimited(ip)) throw httpErr(429, 'Has creado demasiadas salas. Intenta más tarde.');
      if (rooms.size >= MAX_ROOMS) throw httpErr(503, 'El servidor está lleno. Intenta más tarde.');
      const b = await readJson(req, 5e6);
      const code = newCode();
      const r = hydrate({
        code, name: cleanText(b.name, 40) || 'Sala ' + code, public: !!b.public,
        max: [2, 4, 8].includes(Number(b.max)) ? Number(b.max) : 4,
        createdAt: Date.now(), lastActive: Date.now(), puzzle: newPuzzle(code, b.n, b.image),
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
      if (rateLimited(ip)) throw httpErr(429, 'Demasiados rompecabezas nuevos. Intenta más tarde.');
      const b = await readJson(req, 5e6);
      const old = r.puzzle.img;
      r.puzzle = newPuzzle(r.code, b.n, b.image);
      r.rt.holds.clear(); r.lastActive = Date.now();
      fs.rm(path.join(IMG_DIR, old), { force: true }, () => {});
      save(r, true);
      broadcast(r, { t: 'puzzle', puzzle: puzzleView(r), by: cleanText(b.by, 24) });
      return json(res, 200, { ok: true });
    }
    m = /^\/img\/([A-Za-z0-9-]+\.(jpg|png|webp))$/.exec(p);
    if (m) return sendFile(res, path.join(IMG_DIR, m[1]), 'img');
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Método no permitido.' });

    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p)));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    return sendFile(res, p.endsWith('/') ? path.join(file, 'index.html') : file, 'no-cache');
  } catch (e) {
    if (!e.expose) console.error(e);
    json(res, e.status || 500, { error: e.expose ? e.message : 'Error del servidor.' });
  }
});

/* ------------------------------------------------------------ tiempo real */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(r, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of r.rt.clients) if (c !== except && c.readyState === 1) c.send(s);
}
function playersOf(r) { return [...r.rt.clients].map(c => ({ id: c.id, name: c.name, color: c.color })); }
function release(r, ws) {
  for (const [gid, h] of r.rt.holds) if (h.by === ws.id) { r.rt.holds.delete(gid); broadcast(r, { t: 'release', gid }); }
}
function leave(ws) {
  const r = ws.room; if (!r) return;
  release(r, ws); r.rt.clients.delete(ws); ws.room = null;
  broadcast(r, { t: 'players', players: playersOf(r) });
  broadcast(r, { t: 'cursor', id: ws.id, x: null, y: null });
}

wss.on('connection', ws => {
  ws.id = crypto.randomBytes(6).toString('hex');
  ws.alive = true; ws.room = null; ws.lastCursor = 0; ws.lastChat = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('close', () => leave(ws));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const r = ws.room;

    if (m.t === 'join') {
      const room = rooms.get(String(m.room || '').toUpperCase());
      if (!room) return send(ws, { t: 'fatal', error: 'No existe una sala con ese código.' });
      if (ws.room) leave(ws);
      if (room.rt.clients.size >= room.max) return send(ws, { t: 'fatal', error: `La sala está llena (máximo ${room.max} jugadores).` });
      ws.name = cleanText(m.name, 24) || 'Jugador';
      ws.color = COLORS.includes(m.color) ? m.color : COLORS[0];
      ws.room = room; room.rt.clients.add(ws); room.lastActive = Date.now();
      send(ws, { t: 'welcome', you: ws.id, room: { code: room.code, name: room.name, public: room.public, max: room.max },
        puzzle: puzzleView(room), players: playersOf(room), holds: [...room.rt.holds].map(([gid, h]) => [gid, h.by]), chat: room.rt.chat });
      broadcast(room, { t: 'players', players: playersOf(room) }, ws);
      return;
    }
    if (!r) return;
    const pz = r.puzzle;
    const isHeldByOther = gid => { const h = r.rt.holds.get(gid); return !!h && h.by !== ws.id; };

    switch (m.t) {
      case 'profile':
        ws.name = cleanText(m.name, 24) || ws.name;
        if (COLORS.includes(m.color)) ws.color = m.color;
        broadcast(r, { t: 'players', players: playersOf(r) });
        break;
      case 'grab': {
        const gid = String(m.gid), g = pz.groups[gid];
        if (m.pid !== pz.id || !g || g.locked || isHeldByOther(gid)) return send(ws, { t: 'deny', gid });
        release(r, ws);
        r.rt.holds.set(gid, { by: ws.id, at: Date.now() });
        broadcast(r, { t: 'grab', gid, by: ws.id });
        break;
      }
      case 'move': {
        const gid = String(m.gid), h = r.rt.holds.get(gid);
        if (!h || h.by !== ws.id || !isFinite(m.x) || !isFinite(m.y)) return;
        h.at = Date.now();
        broadcast(r, { t: 'move', gid, x: +m.x, y: +m.y, by: ws.id }, ws);
        break;
      }
      case 'drop': {
        const gid = String(m.gid), h = r.rt.holds.get(gid);
        if (!h || h.by !== ws.id) return send(ws, { t: 'release', gid });
        r.rt.holds.delete(gid);
        const res = P.drop(pz, gid, +m.x, +m.y, k => r.rt.holds.has(k));
        if (!res) { broadcast(r, { t: 'release', gid }); return; }
        r.lastActive = Date.now();
        broadcast(r, { t: 'update', set: res.set, del: res.del, gid, by: ws.id, merged: res.merged, locked: res.locked });
        if (Object.keys(pz.groups).length === 1 && !pz.doneAt) { pz.doneAt = Date.now(); broadcast(r, { t: 'done', doneAt: pz.doneAt }); }
        save(r);
        break;
      }
      case 'arrange': {
        if (Date.now() - r.rt.lastArrange < 2000) return;
        r.rt.lastArrange = Date.now();
        const res = P.arrange(pz, k => r.rt.holds.has(k));
        broadcast(r, { t: 'update', set: res.set, del: [], by: ws.id, arranged: true });
        save(r);
        break;
      }
      case 'cursor': {
        const now = Date.now(); if (now - ws.lastCursor < 30) return; ws.lastCursor = now;
        const x = m.x == null ? null : +m.x, y = m.y == null ? null : +m.y;
        if (x !== null && !isFinite(x)) return;
        broadcast(r, { t: 'cursor', id: ws.id, x, y }, ws);
        break;
      }
      case 'chat': {
        const now = Date.now(); if (now - ws.lastChat < 400) return; ws.lastChat = now;
        const text = cleanText(m.text, 240); if (!text) return;
        const msg = { id: ws.id, name: ws.name, color: ws.color, text, at: now };
        r.rt.chat.push(msg); if (r.rt.chat.length > 60) r.rt.chat.shift();
        broadcast(r, { t: 'chat', msg });
        break;
      }
      case 'ping': send(ws, { t: 'pong' }); break;
    }
  });
});

// Latidos: cierra conexiones muertas y libera piezas "olvidadas".
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  const now = Date.now();
  for (const r of rooms.values()) for (const [gid, h] of r.rt.holds) if (now - h.at > 45000) { r.rt.holds.delete(gid); broadcast(r, { t: 'release', gid }); }
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
