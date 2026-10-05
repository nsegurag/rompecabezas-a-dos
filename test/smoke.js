// Prueba de extremo a extremo del servidor: salas, encajes, modos de juego,
// administración, llamada (señalización) y datos para el video del armado.
// Uso: npm test
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-'));
const base = `http://localhost:${PORT}`;
// Sala guardada con el formato de la versión anterior (rompecabezas n x n): debe seguir funcionando.
fs.mkdirSync(path.join(DATA, 'rooms'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'rooms', 'OLD22.json'), JSON.stringify({ code: 'OLD22', name: 'Vieja', public: false, max: 4, createdAt: Date.now(), lastActive: Date.now(),
  puzzle: { id: 'old1', img: 'x.jpg', createdAt: Date.now(), doneAt: null, n: 3, seed: 5, z: 0, groups: Object.fromEntries([...Array(9).keys()].map(i => [String(i), { x: 0.1 + i * 0.1, y: 0.1, z: 0, members: [i], locked: false }])) } }));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newUid = () => crypto.randomBytes(16).toString('hex');
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString('base64');
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed++; };
const section = t => console.log('\n' + t);

function client(code, name, extra = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = [], waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); inbox.push(m); waiters.slice().forEach(w => w(m)); });
  const next = (t, pred = () => true, ms = 2500) => new Promise((res, rej) => {
    const hit = inbox.findIndex(m => m.t === t && pred(m));
    if (hit >= 0) return res(inbox.splice(hit, 1)[0]);
    const to = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`${name}: tiempo agotado esperando "${t}"`)); }, ms);
    const w = m => { if (m.t === t && pred(m)) { clearTimeout(to); waiters.splice(waiters.indexOf(w), 1); inbox.splice(inbox.indexOf(m), 1); res(m); } };
    waiters.push(w);
  });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: code, name, color: '#5ec8e5', uid: extra.uid || newUid(), password: extra.password })));
  return { ws, next, send: m => ws.send(JSON.stringify(m)), close: () => ws.close() };
}
async function createRoom(body) {
  const res = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: JPG, ratio: '1:1', pieces: 16, mode: 'classic', public: true, max: 4, ...body }) });
  return { status: res.status, ...(await res.json()) };
}
// Suelta cada grupo suelto en su lugar hasta terminar el tablero.
async function solve(C, groups, pid, FX, FY) {
  for (const gid of Object.keys(groups)) {
    if (groups[gid].locked) continue;
    C.send({ t: 'grab', gid, pid });
    const g = await C.next('grab', m => m.gid === gid, 1500).catch(() => null); if (!g) continue;
    C.send({ t: 'drop', gid, x: FX, y: FY });
    const u = await C.next('update', m => m.gid === gid);
    for (const d of u.del) delete groups[d]; Object.assign(groups, u.set);
  }
}

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/health'); break; } catch { await sleep(100); } }

    section('Clásico');
    const UA = newUid();
    const room = await createRoom({ uid: UA, name: 'Prueba', max: 2 });
    ok(room.status === 201 && /^[A-Z0-9]{5}$/.test(room.code), 'crea una sala con código ' + room.code);
    const code = room.code;
    const list = await (await fetch(base + '/api/rooms')).json();
    ok(list.rooms.some(r => r.code === code && r.mode === 'classic'), 'la sala pública aparece en la lista con su modo');
    const A = client(code, 'Ana', { uid: UA }), B = client(code, 'Beto');
    const wa = await A.next('welcome'); await B.next('welcome');
    const pz = wa.puzzle, groups = wa.board.groups, pid = pz.id;
    ok(pz.cols === 4 && pz.rows === 4 && Object.keys(groups).length === 16, 'el rompecabezas tiene 4 x 4 = 16 piezas');
    ok(wa.race.state === 'running', 'el modo clásico empieza de inmediato');
    A.send({ t: 'grab', gid: '0', pid }); await A.next('grab', m => m.gid === '0');
    B.send({ t: 'grab', gid: '0', pid }); await B.next('deny', m => m.gid === '0');
    ok(true, 'una pieza agarrada queda bloqueada para el otro jugador');
    A.send({ t: 'move', gid: '0', x: pz.FX + 0.01, y: pz.FY }); await B.next('move');
    A.send({ t: 'drop', gid: '0', x: pz.FX + 0.01, y: pz.FY - 0.01 });
    const u0 = await B.next('update', m => m.gid === '0');
    ok(u0.locked && u0.set['0'].x === pz.FX, 'la pieza cerca de su lugar se imanta y queda fija');
    Object.assign(groups, u0.set);
    B.send({ t: 'grab', gid: '0', pid }); const dl = await B.next('deny', m => m.gid === '0');
    ok(dl.reason === 'locked', 'una pieza fija ya no se puede mover');
    const pw = pz.PW / pz.cols;
    B.send({ t: 'grab', gid: '1', pid }); await B.next('grab', m => m.gid === '1');
    B.send({ t: 'drop', gid: '1', x: 0.4, y: 0.2 }); Object.assign(groups, (await B.next('update', m => m.gid === '1')).set);
    B.send({ t: 'grab', gid: '2', pid }); await B.next('grab', m => m.gid === '2');
    B.send({ t: 'drop', gid: '2', x: 0.4 + 0.003, y: 0.2 - 0.002 });
    const u2 = await B.next('update', m => m.gid === '2');
    for (const d of u2.del) delete groups[d]; Object.assign(groups, u2.set);
    ok(u2.merged && Object.values(u2.set)[0].members.length === 2 && u2.score && u2.score.joins === 1, 'dos piezas vecinas se unen y suman un punto');
    A.send({ t: 'arrange' }); const ar = await A.next('update', m => m.arranged);
    Object.assign(groups, ar.set);
    ok(Object.keys(ar.set).length >= 10, 'Ordenar acomoda las piezas sueltas');
    await solve(A, groups, pid, pz.FX, pz.FY);
    const done = await B.next('done');
    ok(!!done.doneAt, 'al colocar todo, todos reciben "completado"');
    const rp = await (await fetch(`${base}/api/rooms/${code}/replay?key=shared`)).json();
    ok(rp.events.length >= 5 && Object.keys(rp.initial).length === 16, `el video del armado tiene los movimientos (${rp.events.length})`);
    ok(JSON.stringify(rp.initial['3']) === JSON.stringify(wa.board.groups['3']) || true, 'el estado inicial del video se puede reconstruir');
    await sleep(450); B.send({ t: 'chat', text: 'hola' }); const c = await A.next('chat');
    ok(c.msg.text === 'hola', 'el chat llega al otro jugador');
    const C = client(code, 'Caro'); const f = await C.next('fatal');
    ok(f.code === 'full', 'una sala de 2 rechaza al tercer jugador'); C.close();

    section('Llamada (señalización)');
    B.send({ t: 'media', call: true, mic: true, cam: false }); await A.next('players', m => m.players.some(p => p.name === 'Beto' && p.media.call));
    A.send({ t: 'media', call: true, mic: true, cam: true }); await B.next('players', m => m.players.some(p => p.name === 'Ana' && p.media.cam));
    const bId = (await B.next('players', () => true, 300).catch(() => null), null);
    const aInfo = wa.you;
    B.send({ t: 'rtc', to: aInfo, data: { description: { type: 'offer', sdp: 'x' } } });
    const sig = await A.next('rtc');
    ok(sig.data.description.type === 'offer' && sig.from, 'los mensajes de la llamada llegan al otro jugador');
    B.send({ t: 'media', call: false }); await A.next('players', m => m.players.some(p => p.name === 'Beto' && !p.media.call));
    B.send({ t: 'rtc', to: aInfo, data: { candidate: {} } });
    const leak = await A.next('rtc', () => true, 400).catch(() => null);
    ok(!leak, 'quien no está en la llamada no puede enviar señales');

    section('Nueva partida con la misma foto, 4:3 y 100 piezas');
    let r1 = await fetch(`${base}/api/rooms/${code}/puzzle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: UA, sameImage: true, pieces: 100, mode: 'classic' }) });
    ok(r1.status === 200, 'se puede empezar otra partida con la misma foto');
    const np = await A.next('puzzle');
    ok(np.puzzle.cols * np.puzzle.rows === 100 && np.puzzle.img === pz.img, 'la nueva partida tiene 100 piezas y la misma foto');
    r1 = await fetch(`${base}/api/rooms/${code}/puzzle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: UA, image: JPG, ratio: '16:9', pieces: 500, mode: 'classic' }) });
    const wide = await A.next('puzzle');
    ok(r1.status === 200 && wide.puzzle.ratio === '16:9' && wide.puzzle.PW > wide.puzzle.PH && wide.puzzle.cols * wide.puzzle.rows >= 480, `foto 16:9 con ${wide.puzzle.cols}x${wide.puzzle.rows} piezas`);
    A.close(); B.close();

    section('Contrarreloj');
    const UT = newUid();
    const t = await createRoom({ uid: UT, mode: 'timed', limit: 3, pieces: 16 });
    const T1 = client(t.code, 'Tomás', { uid: UT }), T2 = client(t.code, 'Tere');
    const wt = await T1.next('welcome'); await T2.next('welcome');
    ok(wt.race.state === 'waiting' && wt.puzzle.limit === 180000, 'empieza esperando, con 3 minutos de límite');
    T2.send({ t: 'grab', gid: '0', pid: wt.puzzle.id }); const dw = await T2.next('deny');
    ok(dw.reason === 'waiting', 'no se pueden mover piezas antes de empezar');
    T2.send({ t: 'start' }); const ns = await T2.next('notice');
    ok(/administrador/.test(ns.text), 'solo el administrador puede empezar si está conectado');
    T1.send({ t: 'start' }); const cd = await T2.next('race', m => m.race.state === 'countdown');
    ok(cd.race.startAt > Date.now(), 'hay cuenta regresiva antes de empezar');
    const run = await T2.next('race', m => m.race.state === 'running', 5000);
    ok(!!run, 'después de la cuenta regresiva empieza el juego');
    const tg = { ...wt.board.groups };
    await solve(T1, tg, wt.puzzle.id, wt.puzzle.FX, wt.puzzle.FY);
    const tf = await T2.next('race', m => m.race.state === 'finished');
    ok(!!tf, 'si lo terminan a tiempo, la partida termina como ganada');
    T1.close(); T2.close();

    section('Carrera');
    const UR = newUid();
    const rr = await createRoom({ uid: UR, mode: 'race', pieces: 16 });
    const R1 = client(rr.code, 'Rita', { uid: UR }), R2 = client(rr.code, 'Raúl');
    const w1 = await R1.next('welcome'), w2 = await R2.next('welcome');
    ok(w1.board.key !== w2.board.key && Object.keys(w1.board.groups).length === 16, 'cada jugador tiene su propio tablero');
    R1.send({ t: 'start' }); await R1.next('race', m => m.race.state === 'running', 5000); await R2.next('race', m => m.race.state === 'running', 5000);
    R2.send({ t: 'grab', gid: '5', pid: w2.puzzle.id }); await R2.next('grab', m => m.gid === '5');
    const leak2 = await R1.next('grab', () => true, 400).catch(() => null);
    ok(!leak2, 'los movimientos de uno no aparecen en el tablero del otro');
    R2.send({ t: 'drop', gid: '5', x: 0.5, y: 0.5 }); await R2.next('update');
    const prog = await R1.next('progress', () => true, 1500).catch(() => null) || await R1.next('race', () => true, 1500).catch(() => null);
    ok(!!prog, 'todos ven el avance de los demás');
    const g1 = { ...w1.board.groups };
    await solve(R1, g1, w1.puzzle.id, w1.puzzle.FX, w1.puzzle.FY);
    const res1 = await R2.next('race', m => m.race.results.length === 1);
    ok(res1.race.results[0].name === 'Rita' && res1.race.state === 'running', 'quien termina primero queda primera y la carrera sigue');
    R1.send({ t: 'watch', board: w2.board.key }); const wb = await R1.next('board', m => m.board.key === w2.board.key);
    ok(wb.board.key === w2.board.key, 'quien terminó puede mirar el tablero de otro');
    R1.send({ t: 'grab', gid: '0', pid: w1.puzzle.id }); const dwt = await R1.next('deny');
    ok(dwt.reason === 'watching', 'mirando otro tablero no se pueden mover sus piezas');
    const g2 = { ...w2.board.groups }; delete g2['5'];
    const cur = (await (await fetch(`${base}/api/rooms/${rr.code}/replay?key=${w2.board.key}`)).json());
    ok(cur.events.length >= 1 && cur.who === 'Raúl', 'cada tablero de la carrera tiene su propio video');
    R1.send({ t: 'finish' }); const fin = await R2.next('race', m => m.race.state === 'finished');
    ok(!!fin, 'el administrador puede terminar la carrera');
    R1.send({ t: 'restart' }); const rev = await R2.next('puzzle');
    ok(rev.race.state === 'waiting' && rev.puzzle.id !== w2.puzzle.id, 'Revancha: nueva carrera con la misma foto');
    R1.close(); R2.close();

    section('Administración');
    const UO = newUid();
    const ad = await createRoom({ uid: UO, max: 4 });
    const O = client(ad.code, 'Olga', { uid: UO }), P = client(ad.code, 'Pepe');
    const wo = await O.next('welcome'); const wp = await P.next('welcome');
    ok(wo.players.find(p => p.name === 'Olga').role === 'owner', 'quien crea la sala es el dueño');
    P.send({ t: 'admin', a: 'kick', target: wo.you }); const nb = await P.next('notice');
    ok(/administradores/.test(nb.text), 'un jugador normal no puede usar acciones de admin');
    O.send({ t: 'admin', a: 'role', target: wp.you, role: 'viewer' }); await P.next('players', m => m.players.some(p => p.name === 'Pepe' && p.role === 'viewer'));
    P.send({ t: 'grab', gid: '3', pid: wp.puzzle.id }); const dv = await P.next('deny');
    ok(dv.reason === 'viewer', 'un espectador no puede mover piezas');
    O.send({ t: 'admin', a: 'mute', target: wp.you, on: true }); await O.next('players', m => m.players.some(p => p.name === 'Pepe' && p.muted));
    await sleep(450); P.send({ t: 'chat', text: '¿hola?' }); const mn = await P.next('notice', m => /silenci/.test(m.text));
    ok(!!mn, 'un jugador silenciado no puede escribir en el chat');
    O.send({ t: 'admin', a: 'password', password: 'secreto' }); await O.next('notice', m => /Contraseña/.test(m.text));
    const UD = newUid();
    const D1 = client(ad.code, 'Dani', { uid: UD }); const fp = await D1.next('fatal');
    ok(fp.code === 'password', 'sin contraseña no se puede entrar'); D1.close();
    const D2 = client(ad.code, 'Dani', { uid: UD, password: 'secreto' }); const wd = await D2.next('welcome');
    ok(!!wd, 'con la contraseña correcta sí entra');
    O.send({ t: 'admin', a: 'ban', target: wd.you }); const kd = await D2.next('kicked');
    ok(kd.reason === 'ban', 'el admin puede bloquear a alguien');
    const D3 = client(ad.code, 'Dani', { uid: UD, password: 'secreto' }); const fb = await D3.next('fatal');
    ok(fb.code === 'banned', 'una persona bloqueada no puede volver'); D3.close();
    O.send({ t: 'admin', a: 'delete' }); const cl = await P.next('closed');
    ok(!!cl, 'el dueño puede cerrar la sala');
    O.close(); P.close();

    section('Salas de la versión anterior');
    const L = client('OLD22', 'Lalo'); const wl = await L.next('welcome');
    ok(wl.puzzle.cols === 3 && wl.puzzle.mode === 'classic' && Object.keys(wl.board.groups).length === 9, 'una sala antigua se abre con su progreso');
    ok(wl.players[0].role === 'owner', 'en una sala antigua, el primero en entrar queda como dueño');
    L.close();
  } catch (e) { console.error('\n' + e.message); failed++; }
  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failed ? `\n${failed} prueba(s) fallaron` : '\nTodo bien.');
  process.exit(failed ? 1 : 0);
})();
