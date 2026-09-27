// Prueba rápida de extremo a extremo: crea una sala, conecta dos jugadores y arma un 3x3.
// Uso: npm test
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-'));
const base = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: 'inherit' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed++; };

function client(code, name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); inbox.push(m); waiters.slice().forEach(w => w(m)); });
  const next = (t, pred = () => true, ms = 2000) => new Promise((res, rej) => {
    const hit = inbox.findIndex(m => m.t === t && pred(m));
    if (hit >= 0) return res(inbox.splice(hit, 1)[0]);
    const to = setTimeout(() => rej(new Error('Tiempo agotado esperando ' + t)), ms);
    const w = m => { if (m.t === t && pred(m)) { clearTimeout(to); waiters.splice(waiters.indexOf(w), 1); inbox.splice(inbox.indexOf(m), 1); res(m); } };
    waiters.push(w);
  });
  const opened = new Promise(r => ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room: code, name, color: '#5ec8e5' })); r(); }));
  return { ws, next, opened, send: m => ws.send(JSON.stringify(m)) };
}

(async () => {
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(base + '/health'); break; } catch { await sleep(100); } }
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString('base64');
    const res = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Prueba', public: true, max: 2, n: 3, image: 'data:image/jpeg;base64,' + jpg }) });
    const { code } = await res.json();
    ok(res.status === 201 && /^[A-Z0-9]{5}$/.test(code), 'crea una sala con código ' + code);
    const list = await (await fetch(base + '/api/rooms')).json();
    ok(list.rooms.some(r => r.code === code), 'la sala pública aparece en la lista');

    const A = client(code, 'Ana'), B = client(code, 'Beto');
    const wa = await A.next('welcome'); await B.next('welcome');
    ok(Object.keys(wa.puzzle.groups).length === 9, 'el rompecabezas tiene 9 piezas sueltas');
    const pid = wa.puzzle.id;

    // Ana toma la pieza 0; Beto no puede tomarla al mismo tiempo.
    A.send({ t: 'grab', gid: '0', pid }); await A.next('grab', m => m.gid === '0');
    B.send({ t: 'grab', gid: '0', pid }); await B.next('deny', m => m.gid === '0');
    ok(true, 'una pieza agarrada queda bloqueada para el otro jugador');

    // Ana la suelta cerca de su lugar correcto: se imanta y se fija.
    A.send({ t: 'move', gid: '0', x: 1.01, y: 0.51 }); await B.next('move');
    A.send({ t: 'drop', gid: '0', x: 1.02, y: 0.49 });
    const u = await B.next('update', m => m.gid === '0');
    ok(u.locked && u.set['0'].x === 1 && u.set['0'].y === 0.5, 'la pieza en su lugar queda fija');
    B.send({ t: 'grab', gid: '0', pid }); await B.next('deny', m => m.gid === '0');
    ok(true, 'una pieza fija ya no se puede mover');

    // Una pieza dejada lejos NO se fija.
    A.send({ t: 'grab', gid: '4', pid }); await A.next('grab', m => m.gid === '4');
    A.send({ t: 'drop', gid: '4', x: 0.1, y: 0.1 });
    const u2 = await A.next('update', m => m.gid === '4');
    ok(!u2.locked, 'una pieza fuera de lugar sigue suelta');

    // Unir dos piezas sueltas fuera del marco (1 y 2 son vecinas).
    B.send({ t: 'grab', gid: '1', pid }); await B.next('grab', m => m.gid === '1');
    B.send({ t: 'drop', gid: '1', x: 1.6, y: 0.2 }); await B.next('update', m => m.gid === '1');
    B.send({ t: 'grab', gid: '2', pid }); await B.next('grab', m => m.gid === '2');
    B.send({ t: 'drop', gid: '2', x: 1.605, y: 0.198 });
    const u3 = await B.next('update', m => m.gid === '2');
    ok(u3.merged && Object.values(u3.set)[0].members.length === 2, 'dos piezas vecinas se unen fuera del marco');

    // Ordenar mueve las piezas sueltas.
    A.send({ t: 'arrange' }); const ar = await A.next('update', m => m.arranged);
    ok(Object.keys(ar.set).length >= 5, 'Ordenar acomoda las piezas sueltas');

    // Terminar: soltar cada grupo restante en el marco.
    const groups = { ...wa.puzzle.groups };
    for (const up of [u, u2, u3, ar]) { for (const d of up.del || []) delete groups[d]; Object.assign(groups, up.set); }
    for (const gid of Object.keys(groups)) {
      if (groups[gid].locked) continue;
      A.send({ t: 'grab', gid, pid }); const g = await A.next('grab', m => m.gid === gid).catch(() => null); if (!g) continue;
      A.send({ t: 'drop', gid, x: 1, y: 0.5 }); await A.next('update', m => m.gid === gid);
    }
    const done = await B.next('done', () => true, 3000);
    ok(!!done.doneAt, 'al colocar todo, ambos reciben "completado"');

    B.send({ t: 'chat', text: 'hola' }); const c = await A.next('chat');
    ok(c.msg.text === 'hola' && c.msg.name === 'Beto', 'el chat llega al otro jugador');

    const C = client(code, 'Caro'); const f = await C.next('fatal');
    ok(/llena/.test(f.error), 'una sala de 2 rechaza al tercer jugador');
    [A, B, C].forEach(x => x.ws.close());
  } catch (e) { console.error(e); failed++; }
  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failed ? `\n${failed} prueba(s) fallaron` : '\nTodo bien.');
  process.exit(failed ? 1 : 0);
})();
