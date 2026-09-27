import { createGame } from './game.js';
import { Net } from './net.js';
import { Cropper } from './cropper.js';

const COLORS = ['#f2b134', '#5ec8e5', '#ff7a8a', '#8be07a', '#c59bff', '#ff9f45', '#4fd1b5', '#f78fd6'];
const SIZES = [3, 4, 6, 8, 10, 12];
const $ = id => document.getElementById(id);
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { } } };
const clean = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '').slice(0, 24);

/* ---------------- perfil ---------------- */
const me = {
  name: clean(ls.get('rz_name')) || 'Jugador ' + (10 + Math.floor(Math.random() * 89)),
  color: COLORS.includes(ls.get('rz_color')) ? ls.get('rz_color') : COLORS[Math.floor(Math.random() * COLORS.length)],
};
function saveMe() { ls.set('rz_name', me.name); ls.set('rz_color', me.color); if (inGame) game.profile(me); }
$('meName').value = me.name;
$('meName').addEventListener('input', e => { me.name = clean(e.target.value).trim() || 'Jugador'; saveMe(); });
function renderSwatches() {
  const box = $('meColors'); box.textContent = '';
  COLORS.forEach(c => {
    const b = document.createElement('button'); b.className = 'swatch'; b.style.background = c; b.type = 'button';
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(c === me.color)); b.setAttribute('aria-label', 'Color ' + c);
    b.onclick = () => { me.color = c; saveMe(); renderSwatches(); };
    box.append(b);
  });
}
renderSwatches();

/* ---------------- utilidades ---------------- */
let toastT = null;
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800); }
function fmt(ms) { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; const p = v => String(v).padStart(2, '0'); return (h ? h + ':' : '') + p(m) + ':' + p(ss); }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' } });
  let body = {}; try { body = await res.json(); } catch { }
  if (!res.ok) throw new Error(body.error || 'No se pudo completar la acción.');
  return body;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Enlace copiado.'); }
  catch { const i = $('shareLink'); i.value = text; i.select(); toast('Selecciona y copia el enlace.'); }
}
const roomLink = code => `${location.origin}/?sala=${code}`;

/* ---------------- vestíbulo ---------------- */
let lobbyTimer = null;
async function loadRooms() {
  const box = $('roomList');
  try {
    const { rooms } = await api('/api/rooms');
    box.textContent = '';
    if (!rooms.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Todavía no hay salas públicas. Crea la primera.'; box.append(p); return; }
    for (const r of rooms) {
      const b = document.createElement('button'); b.className = 'room'; b.type = 'button';
      const img = document.createElement('img'); img.src = r.img; img.alt = ''; img.loading = 'lazy';
      const info = document.createElement('div');
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = r.name;
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = `${r.pieces} piezas · ${r.players}/${r.max} jugando${r.done ? ' · terminado' : ''}`;
      const bar = document.createElement('div'); bar.className = 'bar-prog'; const i = document.createElement('i'); i.style.width = r.progress + '%'; bar.append(i);
      info.append(nm, meta, bar); b.append(img, info);
      b.onclick = () => enterRoom(r.code);
      box.append(b);
    }
  } catch (e) { box.textContent = ''; const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No se pudo cargar la lista de salas. ' + e.message; box.append(p); }
}
function showLobby() {
  inGame = false; $('game').hidden = true; $('lobby').hidden = false; document.title = 'Rompecabezas a Dos';
  loadRooms(); clearInterval(lobbyTimer); lobbyTimer = setInterval(loadRooms, 10000);
}
$('btnRefresh').onclick = loadRooms;
$('btnCreate').onclick = () => openPhoto('create');
$('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('joinCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 5) { toast('El código tiene 5 letras o números.'); return; }
  enterRoom(code);
});

/* ---------------- juego ---------------- */
let inGame = false, unread = 0, doneDismissedFor = null, hudTimer = null;
const net = new Net();
const game = createGame({
  canvas: $('cv'), net, getProfile: () => ({ name: me.name, color: me.color }),
  ui: {
    onRoom(room) {
      $('roomName').textContent = room.name; $('roomCode').textContent = room.code; document.title = room.name + ' · Rompecabezas a Dos';
    },
    onPlayers(list, you) {
      const box = $('players'); box.textContent = '';
      const sorted = [...list].sort((a, b) => (b.id === you) - (a.id === you));
      for (const p of sorted) {
        const c = document.createElement('span'); c.className = 'chip';
        const d = document.createElement('span'); d.className = 'dot'; d.style.background = p.color;
        const n = document.createElement('span'); n.className = 'nm'; n.textContent = p.name;
        c.append(d, n);
        if (p.id === you) { const y = document.createElement('span'); y.className = 'you'; y.textContent = 'tú'; c.append(y); }
        box.append(c);
      }
      if (list.length < 2) { const h = document.createElement('span'); h.className = 'muted'; h.textContent = 'Esperando a tu compañero…'; box.append(h); }
    },
    onHud(h) {
      $('hudPlaced').textContent = `${h.placed} / ${h.total} en su lugar`;
      $('hudProg').textContent = `Unidas ${h.progress}%`;
      $('hudTime').textContent = fmt(h.ms);
      if (h.done && doneDismissedFor !== game.puzzle.id && $('done').hidden) { $('doneTime').textContent = 'Tiempo · ' + fmt(h.ms); $('done').hidden = false; }
      if (!h.done) $('done').hidden = true;
    },
    onDone(ms) { $('doneTime').textContent = 'Tiempo · ' + fmt(ms); $('done').hidden = false; sysMsg('¡Rompecabezas completado!'); },
    onImage(src) { $('photoImg').src = src; },
    onNewPuzzle(by) { doneDismissedFor = null; $('done').hidden = true; toast(by ? `${by} empezó un rompecabezas nuevo.` : 'Nuevo rompecabezas.'); sysMsg(`${by || 'Alguien'} cambió la foto.`); },
    onToast: toast,
    onStatus(s) {
      $('netDot').classList.toggle('off', s !== 'open');
      $('netDot').title = s === 'open' ? 'Conectado' : 'Reconectando…';
      if (s !== 'open' && inGame) toast('Se perdió la conexión. Reconectando…');
    },
    onChatHistory(list) { $('msgs').textContent = ''; list.forEach(addMsg); unread = 0; badge(); },
  },
});
net.on('chat', m => { addMsg(m.msg); if ($('chat').hidden && m.msg.id !== game.you) { unread++; badge(); } });
net.on('fatal', m => { net.close(); toast(m.error); history.replaceState(null, '', '/'); showLobby(); });

async function enterRoom(code) {
  try { await api('/api/rooms/' + code); }
  catch (e) { toast(e.message); if (inGame) showLobby(); return; }
  clearInterval(lobbyTimer);
  if (new URLSearchParams(location.search).get('sala') !== code) history.pushState(null, '', '/?sala=' + code);
  $('lobby').hidden = true; $('game').hidden = false; inGame = true;
  $('done').hidden = true; $('chat').hidden = true; $('photo').hidden = true; doneDismissedFor = null;
  $('roomCode').textContent = code; $('roomName').textContent = 'Conectando…'; $('players').textContent = '';
  setPressed('tPhoto', false);
  game.start(code);
  if (!ls.get('rz_tip')) $('tip').hidden = false;
  clearInterval(hudTimer); hudTimer = setInterval(() => inGame && game.hud(), 1000);
}
function leaveRoom() { game.stop(); clearInterval(hudTimer); history.pushState(null, '', '/'); showLobby(); }
$('btnLeave').onclick = leaveRoom;
$('tipOk').onclick = () => { $('tip').hidden = true; ls.set('rz_tip', '1'); };
$('roomCode').onclick = () => game.room && copy(roomLink(game.room.code));

function setPressed(id, v) { $(id).setAttribute('aria-pressed', String(v)); }
$('tArrange').onclick = () => game.arrange();
$('tEdges').onclick = () => setPressed('tEdges', game.toggleEdges());
$('tGuide').onclick = () => setPressed('tGuide', game.toggleGuide());
$('tPan').onclick = () => setPressed('tPan', game.togglePan());
$('tPhoto').onclick = () => { const p = $('photo'); p.hidden = !p.hidden; setPressed('tPhoto', !p.hidden); };
$('zIn').onclick = () => game.zoomIn(); $('zOut').onclick = () => game.zoomOut(); $('zFit').onclick = () => game.fit();
$('zFull').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { toast('Tu navegador no permite pantalla completa aquí.'); }
};
document.addEventListener('fullscreenchange', () => setTimeout(() => game.resize(), 100));
$('doneClose').onclick = () => { $('done').hidden = true; doneDismissedFor = game.puzzle && game.puzzle.id; };
$('doneNew').onclick = () => { $('done').hidden = true; openPhoto('new'); };

/* chat */
function badge() { $('chatBadge').hidden = unread === 0; $('chatBadge').textContent = unread > 9 ? '9+' : unread; }
function addMsg(m) {
  const li = document.createElement('li'); const b = document.createElement('b'); b.style.color = m.color; b.textContent = m.name;
  li.append(b, document.createTextNode(m.text)); $('msgs').append(li); $('msgs').scrollTop = $('msgs').scrollHeight;
}
function sysMsg(t) { const li = document.createElement('li'); li.className = 'sys'; li.textContent = t; $('msgs').append(li); $('msgs').scrollTop = $('msgs').scrollHeight; }
$('btnChat').onclick = () => { const c = $('chat'); c.hidden = !c.hidden; if (!c.hidden) { $('tip').hidden = true; unread = 0; badge(); $('chatInput').focus(); $('photo').hidden = true; setPressed('tPhoto', false); } };
$('chatClose').onclick = () => { $('chat').hidden = true; };
$('chatForm').addEventListener('submit', e => { e.preventDefault(); const v = $('chatInput').value.trim(); if (!v) return; if (game.chat(v)) $('chatInput').value = ''; else toast('Sin conexión.'); });

/* compartir */
$('btnShare').onclick = () => {
  const r = game.room; if (!r) return;
  $('shareCode').textContent = r.code; $('shareLink').value = roomLink(r.code);
  $('shareInfo').textContent = `${r.public ? 'Sala pública' : 'Sala privada: solo entra quien tenga el código'} · hasta ${r.max} jugadores.`;
  $('mShare').hidden = false;
};
$('shareCopy').onclick = () => copy($('shareLink').value);
$('shareClose').onclick = () => { $('mShare').hidden = true; };

/* ---------------- modal de foto (crear sala / nueva foto) ---------------- */
const cropper = new Cropper($('cropCv'), $('cropZoom'));
let photoMode = 'create', pieceN = 6, maxP = 2, isPublic = false;
function seg(boxId, items, get, set) {
  const box = $(boxId); box.textContent = '';
  items.forEach(it => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(it.v === get()));
    b.textContent = it.label; if (it.sub) { const s = document.createElement('small'); s.textContent = it.sub; b.append(s); }
    b.onclick = () => { set(it.v); [...box.children].forEach(c => c.setAttribute('aria-pressed', String(c === b))); };
    box.append(b);
  });
}
seg('segN', SIZES.map(n => ({ v: n, label: String(n * n) })), () => pieceN, v => { pieceN = v; });
seg('segMax', [2, 4, 8].map(v => ({ v, label: String(v) })), () => maxP, v => { maxP = v; });
seg('segVis', [{ v: false, label: 'Privada', sub: 'Solo con el código' }, { v: true, label: 'Pública', sub: 'Aparece en la lista' }], () => isPublic, v => { isPublic = v; });

function openPhoto(mode) {
  photoMode = mode;
  document.querySelectorAll('.create-only').forEach(el => { el.hidden = mode !== 'create'; });
  $('mPhotoT').textContent = mode === 'create' ? 'Crear sala' : 'Nueva foto para esta sala';
  $('photoGo').textContent = mode === 'create' ? 'Crear sala' : 'Empezar';
  $('photoWarn').textContent = mode === 'create' ? 'Después podrás invitar con un enlace o un código.' : 'Reemplaza el rompecabezas actual para todos en la sala.';
  if (mode === 'create') $('roomNameIn').value = `Sala de ${me.name}`;
  $('photoErr').hidden = true; $('mPhoto').hidden = false;
  if (cropper.img) requestAnimationFrame(() => cropper.draw());
}
function closePhoto() { $('mPhoto').hidden = true; }
async function loadFile(f) {
  if (!f) return;
  try { await cropper.load(f); $('drop').hidden = true; $('cropBox').hidden = false; $('photoGo').disabled = false; $('photoErr').hidden = true; }
  catch (e) { $('photoErr').textContent = e.message; $('photoErr').hidden = false; }
}
$('file').onchange = e => loadFile(e.target.files[0]);
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
$('cropOther').onclick = () => { $('file').value = ''; $('file').click(); };
$('photoCancel').onclick = closePhoto;
$('mPhoto').addEventListener('click', e => { if (e.target === $('mPhoto')) closePhoto(); });
$('mShare').addEventListener('click', e => { if (e.target === $('mShare')) $('mShare').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePhoto(); $('mShare').hidden = true; } });
window.addEventListener('resize', () => cropper.img && cropper.draw());

$('photoForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!cropper.img) return;
  const image = cropper.export();
  if (!image) { $('photoErr').textContent = 'La foto es demasiado pesada. Prueba con otra.'; $('photoErr').hidden = false; return; }
  const btn = $('photoGo'), label = btn.textContent; btn.disabled = true; btn.textContent = 'Subiendo…';
  try {
    if (photoMode === 'create') {
      const { code } = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: $('roomNameIn').value, public: isPublic, max: maxP, n: pieceN, image }) });
      closePhoto(); resetPhoto(); await enterRoom(code);
    } else {
      await api(`/api/rooms/${game.room.code}/puzzle`, { method: 'POST', body: JSON.stringify({ n: pieceN, image, by: me.name }) });
      closePhoto(); resetPhoto();
    }
  } catch (err) { $('photoErr').textContent = err.message; $('photoErr').hidden = false; }
  finally { btn.textContent = label; btn.disabled = !cropper.img; }
});
function resetPhoto() { cropper.reset(); $('drop').hidden = false; $('cropBox').hidden = true; $('file').value = ''; $('photoGo').disabled = true; }
$('btnNew').onclick = () => openPhoto('new');

/* ---------------- rutas ---------------- */
function route() {
  const code = (new URLSearchParams(location.search).get('sala') || '').toUpperCase();
  if (/^[A-Z0-9]{5}$/.test(code)) { if (!inGame || !game.room || game.room.code !== code) enterRoom(code); }
  else { if (inGame) game.stop(); showLobby(); }
}
window.addEventListener('popstate', route);
window.__rz = game;
route();
