import { createGame } from './game.js';
import { Net } from './net.js';
import { Cropper } from './cropper.js';
import { Call } from './rtc.js';
import { makeTimelapse, timelapseSupported } from './timelapse.js';
import { createMusic } from './music.js';

/* =========================================================================
   Constantes y utilidades
   ========================================================================= */
const COLORS = ['#f2b134', '#5ec8e5', '#ff7a8a', '#8be07a', '#c59bff', '#ff9f45', '#4fd1b5', '#f78fd6'];
const RATIOS = [
  { id: '1:1', v: 1, label: 'Cuadrada' }, { id: '4:3', v: 4 / 3, label: '4:3' }, { id: '3:4', v: 3 / 4, label: '3:4' },
  { id: '16:9', v: 16 / 9, label: '16:9' }, { id: '9:16', v: 9 / 16, label: '9:16' },
];
const PIECES = [
  { v: 16, sub: 'Muy fácil' }, { v: 36, sub: 'Fácil' }, { v: 64, sub: 'Normal' }, { v: 100, sub: 'Normal' },
  { v: 150, sub: 'Difícil' }, { v: 200, sub: 'Difícil' }, { v: 300, sub: 'Experto' }, { v: 500, sub: 'Experto' },
];
const MODES = {
  classic: { label: 'Clásico', icon: 'i-together', desc: 'Arman juntos la misma mesa, sin reloj.' },
  timed: { label: 'Contrarreloj', icon: 'i-clock', desc: 'Juntos contra el tiempo. ¿Lo terminan antes de que se acabe?' },
  race: { label: 'Carrera', icon: 'i-flag', desc: 'Cada quien arma su propia copia. Gana el más rápido.' },
};
const TIMED_LIMITS = [3, 5, 10, 15, 20, 30, 45, 60];
const RACE_LIMITS = [0, 5, 10, 15, 30, 60];
const DEFAULT_REACTIONS = ['🎉', '👀', '🙌', '😂', '❤️'];
const EMOJIS = ['🎉', '👀', '🙌', '😂', '❤️', '🔥', '👏', '😮', '🤔', '😅', '🥳', '😍', '😎', '🤯', '😭', '🙏', '👍', '👎', '💪', '✨', '⭐', '🏆', '🧩', '🍀', '☕', '🍕', '🐢', '🚀', '💡', '🎯', '😴', '🤝', '😇', '🤩', '😬', '🫶', '💯', '👑', '🌈', '🐱', '🐶', '🦊', '🌻', '🍓', '🎶', '📸', '❓', '✅'];
const THEMES = [
  { id: 'ciruela', label: 'Ciruela', bg: '#3a2e44' }, { id: 'verde', label: 'Fieltro verde', bg: '#1e5a3c' },
  { id: 'madera', label: 'Madera', bg: 'linear-gradient(90deg,#8a5a34,#a06b3f 40%,#7c4f2c)' },
  { id: 'pizarra', label: 'Oscuro', bg: '#23272d' }, { id: 'claro', label: 'Claro', bg: '#e8e2d7' },
];
const ROLE_LABEL = { owner: 'Dueño', admin: 'Admin', player: 'Jugador', viewer: 'Espectador' };

const $ = id => document.getElementById(id);
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { } } };
const clean = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '').slice(0, 24);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (id, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); if (cls) s.setAttribute('class', cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.append(u); return s; };
const fmt = ms => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; const p = v => String(v).padStart(2, '0'); return (h ? h + ':' : '') + p(m) + ':' + p(x); };
const initial = n => (n || '?').trim().charAt(0).toUpperCase() || '?';
const grid = (aspect, target) => { const rows = Math.max(2, Math.round(Math.sqrt(target / aspect))); const cols = Math.max(2, Math.round(target / rows)); return { cols, rows }; };
const isMobile = () => window.matchMedia('(max-width: 700px)').matches;
function setPressed(elm, v) { elm.setAttribute('aria-pressed', String(v)); }

let toastT = null;
function toast(m) { if (!m) return; const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
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
const pwKey = code => 'rz_pw_' + code;
function seg(box, items, get, set) {
  box.textContent = '';
  items.forEach(it => {
    const b = el('button'); b.type = 'button'; setPressed(b, it.v === get());
    b.textContent = it.label; if (it.sub) b.append(el('small', null, it.sub));
    b.onclick = () => { set(it.v); [...box.children].forEach(c => setPressed(c, c === b)); };
    box.append(b);
  });
}
// Cerrar modales y paneles con los botones "Cerrar" (data-close) y tocando fuera.
document.addEventListener('click', e => { const c = e.target.closest('[data-close]'); if (c) $(c.dataset.close).hidden = true; });
document.querySelectorAll('.scrim').forEach(s => s.addEventListener('click', e => { if (e.target === s && s.id !== 'mVideo' && s.id !== 'mName') s.hidden = true; }));

/* =========================================================================
   Perfil e identidad
   ========================================================================= */
// Identificador secreto de este navegador: la sala te reconoce como dueño o admin.
let uid = ls.get('rz_uid');
if (!/^[a-f0-9]{32}$/.test(uid || '')) { uid = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''); ls.set('rz_uid', uid); }
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
    const b = el('button', 'swatch'); b.style.background = c; b.type = 'button';
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(c === me.color)); b.setAttribute('aria-label', 'Color ' + c);
    b.onclick = () => { me.color = c; saveMe(); renderSwatches(); };
    box.append(b);
  });
}
renderSwatches();
const music = createMusic();

/* =========================================================================
   Inicio: lista de salas
   ========================================================================= */
let lobbyTimer = null;
async function loadRooms() {
  const box = $('roomList');
  try {
    const { rooms } = await api('/api/rooms');
    box.textContent = '';
    if (!rooms.length) { box.append(el('p', 'empty', 'Todavía no hay salas públicas. Crea la primera.')); return; }
    for (const r of rooms) {
      const b = el('button', 'room'); b.type = 'button';
      const img = el('img'); img.src = r.img; img.alt = ''; img.loading = 'lazy';
      const info = el('div');
      const nm = el('div', 'nm', (r.hasPassword ? '🔒 ' : '') + r.name);
      const meta = el('div', 'meta', `${r.pieces} piezas · ${r.players}/${r.max} jugando${r.done ? ' · terminado' : ''}`);
      const tag = el('span', 'tag', MODES[r.mode] ? MODES[r.mode].label : 'Clásico');
      const bar = el('div', 'bar-prog'); const i = el('i'); i.style.width = r.progress + '%'; bar.append(i);
      info.append(nm, meta, tag, bar); b.append(img, info);
      b.onclick = () => enterRoom(r.code);
      box.append(b);
    }
  } catch (e) { box.textContent = ''; box.append(el('p', 'empty', 'No se pudo cargar la lista de salas. ' + e.message)); }
}
function showLobby() {
  music.disarm(); inGame = false; $('game').hidden = true; $('lobby').hidden = false; document.title = 'Rompecabezas a Dos';
  loadRooms(); clearInterval(lobbyTimer); lobbyTimer = setInterval(loadRooms, 10000);
}
$('btnRefresh').onclick = loadRooms;
$('btnCreate').onclick = () => openWizard('create');
$('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('joinCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 5) { toast('El código tiene 5 letras o números.'); return; }
  enterRoom(code);
});

/* =========================================================================
   Juego
   ========================================================================= */
let inGame = false, unread = 0, ticker = null, currentCode = null, adminBans = [], lastRole = null, dismissed = null;
const net = new Net();
const game = createGame({
  canvas: $('cv'), net,
  getProfile: () => ({ name: me.name, color: me.color, uid, password: currentCode ? ls.get(pwKey(currentCode)) || '' : '' }),
  ui: {
    onRoom(room) {
      $('roomName').textContent = room.name; $('roomCode').textContent = room.code;
      document.title = room.name + ' · Rompecabezas a Dos'; renderRoomSettings();
    },
    onPlayers() {
      renderPlayers(); call.setPlayers(game.players, game.you); renderCall(); renderState(); renderRace();
      const r = game.role;
      if (lastRole && r !== lastRole) toast({ owner: 'Ahora eres el dueño de la sala.', admin: 'Ahora eres administrador de la sala.', viewer: 'Ahora estás como espectador: puedes mirar, pero no mover piezas.', player: 'Ya puedes mover piezas.' }[r]);
      lastRole = r;
    },
    onScores() { renderPlayers(); },
    onHud: renderHud,
    onRace() { renderRace(); renderState(); },
    onPuzzle(pz) {
      renderModeBadge();
      renderState(); renderRace();
    },
    onBoard() { renderWatching(); renderRace(); renderState(); },
    onDone() { sysMsg('¡Rompecabezas completado!'); renderState(); },
    onLoading(v) { $('loading').hidden = !v; },
    onImage(src) { $('photoImg').src = src; $('wzSameImg').src = src; },
    onNewPuzzle(by) { dismissed = null; if (by !== me.name) toast(by ? `${by} empezó una partida nueva.` : 'Partida nueva.'); sysMsg(`${by || 'Alguien'} empezó una partida nueva.`); },
    onToast: toast,
    onStatus(s) {
      $('netDot').classList.toggle('off', s !== 'open');
      $('netDot').title = s === 'open' ? 'Conectado' : 'Reconectando…';
      if (s !== 'open' && inGame) toast('Se perdió la conexión. Reconectando…');
    },
    onChatHistory(list) { $('msgs').textContent = ''; list.forEach(addMsg); unread = 0; badge(); },
    onGroups() { scheduleTray(); },
    onReact(m, pos, pl) { floatEmoji(m.e, pos || { x: window.innerWidth / 2, y: window.innerHeight / 2 }, pl); },
    onExpelled(text) { expelled(text); },
  },
});
net.on('chat', m => { addMsg(m.msg); if ($('chat').hidden && m.msg.id !== game.you) { unread++; badge(); } });
net.on('admin', m => { adminBans = m.bans || []; renderBans(); });
net.on('fatal', m => {
  net.close();
  if (m.code === 'password') { askPassword(m.error); return; }
  toast(m.error); history.replaceState(null, '', '/'); showLobby();
});
function expelled(text) { leaveCall(); game.stop(); clearInterval(ticker); toast(text); history.replaceState(null, '', '/'); showLobby(); }

/* Pantalla de nombre: aparece cada vez que se entra a una sala (con el nombre y color guardados ya puestos). */
function askIdentity(code) {
  return new Promise(resolve => {
    let color = me.color;
    const paint = () => {
      const box = $('nameColors'); box.textContent = '';
      COLORS.forEach(c => {
        const b = el('button', 'swatch'); b.type = 'button'; b.style.background = c;
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(c === color)); b.setAttribute('aria-label', 'Color ' + c);
        b.onclick = () => { color = c; paint(); };
        box.append(b);
      });
    };
    paint();
    $('nameRoom').textContent = `Vas a entrar a la sala ${code}.`;
    $('nameIn').value = ls.get('rz_name') ? me.name : '';
    $('mName').hidden = false; setTimeout(() => { $('nameIn').focus(); $('nameIn').select(); }, 60);
    const done = ok => { $('mName').hidden = true; $('nameForm').onsubmit = null; $('nameCancel').onclick = null; resolve(ok); };
    $('nameForm').onsubmit = e => {
      e.preventDefault();
      const v = clean($('nameIn').value).trim();
      if (!v) { $('nameIn').focus(); return; }
      me.name = v; me.color = color; saveMe();
      $('meName').value = me.name; renderSwatches();
      done(true);
    };
    $('nameCancel').onclick = () => done(false);
  });
}

async function enterRoom(code, opts = {}) {
  try { await api('/api/rooms/' + code); }
  catch (e) { toast(e.message); if (inGame) showLobby(); return; }
  if (!opts.skipName && !(await askIdentity(code))) { if (!inGame) { history.replaceState(null, '', '/'); showLobby(); } return; }
  clearInterval(lobbyTimer);
  currentCode = code;
  if (new URLSearchParams(location.search).get('sala') !== code) history.pushState(null, '', '/?sala=' + code);
  $('lobby').hidden = true; $('game').hidden = false; inGame = true;
  ['chat', 'photo', 'people', 'popReact', 'popTheme', 'popMore', 'menu', 'stateCard', 'countdown', 'racePanel', 'watching', 'clock'].forEach(id => { $(id).hidden = true; });
  adminBans = []; lastRole = null; dismissed = null;
  $('roomCode').textContent = code; $('roomName').textContent = 'Conectando…'; $('players').textContent = ''; $('msgs').textContent = '';
  document.querySelectorAll('[data-act="photo"],[data-act="guide"],[data-act="edges"],[data-act="pan"]').forEach(b => setPressed(b, false));
  game.start(code);
  music.autoplay();
  applyTheme(ls.get('rz_theme') || 'ciruela');
  const trayPref = ls.get('rz_tray');
  setTray(trayPref ? trayPref === '1' : isMobile());
  if (!ls.get('rz_tip')) $('tip').hidden = false;
  clearInterval(ticker); ticker = setInterval(tick, 200);
}
function leaveRoom() { leaveCall(); game.stop(); clearInterval(ticker); history.pushState(null, '', '/'); showLobby(); }
$('btnLeave').onclick = leaveRoom;
$('tipOk').onclick = () => { $('tip').hidden = true; ls.set('rz_tip', '1'); };
$('roomCode').onclick = () => game.room && copy(roomLink(game.room.code));

/* contraseña */
function askPassword(msg) {
  $('passMsg').textContent = msg || 'Escribe la contraseña que te dio el administrador.';
  $('passIn').value = ''; $('mPass').hidden = false; setTimeout(() => $('passIn').focus(), 50);
}
$('passForm').addEventListener('submit', e => {
  e.preventDefault(); const v = $('passIn').value; if (!v) return;
  ls.set(pwKey(currentCode), v); $('mPass').hidden = true; game.start(currentCode);
});
$('passCancel').onclick = () => { $('mPass').hidden = true; game.stop(); history.replaceState(null, '', '/'); showLobby(); };

/* ---------------- permisos locales ---------------- */
const isStaff = () => game.role === 'owner' || game.role === 'admin';
function canControl() {
  if (game.role === 'viewer') return false;
  if (isStaff()) return true;
  return !game.players.some(p => p.role === 'owner' || p.role === 'admin');
}
function canNewGame() {
  if (game.role === 'viewer') return false;
  const perms = game.room && game.room.perms;
  return !(perms && perms.photo === 'admin' && !isStaff());
}

/* ---------------- reloj, HUD y cuenta regresiva ---------------- */
function tick() {
  if (!inGame) return;
  game.hud();
  const race = game.race;
  const cd = $('countdown');
  if (race && race.state === 'countdown') {
    const left = Math.ceil((race.startAt - game.serverNow()) / 1000);
    const txt = left > 0 ? String(Math.min(3, left)) : '¡Ya!';
    if (cd.hidden || cd.dataset.v !== txt) { cd.hidden = false; cd.dataset.v = txt; cd.textContent = ''; cd.append(el('b', null, txt)); }
  } else if (!cd.hidden && !cd.dataset.hiding) {
    if (cd.dataset.v !== '¡Ya!') { cd.dataset.v = '¡Ya!'; cd.textContent = ''; cd.append(el('b', null, '¡Ya!')); }
    cd.dataset.hiding = '1';
    setTimeout(() => { cd.hidden = true; delete cd.dataset.hiding; delete cd.dataset.v; }, 800);
  }
}
function renderHud(h) {
  $('hudPlaced').textContent = `${h.placed} / ${h.total} en su lugar`;
  $('hudProg').textContent = `Unidas ${h.progress}%`;
  $('hudTime').textContent = fmt(h.elapsed);
  const pz = game.puzzle, clock = $('clock');
  if (!pz || pz.mode === 'classic') { clock.hidden = true; return; }
  clock.hidden = false;
  let txt, warn = false;
  if (h.state === 'waiting') txt = pz.limit ? fmt(pz.limit) : '00:00';
  else if (h.remaining != null) { txt = fmt(h.remaining); warn = h.state === 'running' && h.remaining < 30000; }
  else txt = fmt(h.elapsed);
  $('clockText').textContent = txt;
  clock.classList.toggle('warn', warn);
}

function renderModeBadge() {
  const pz = game.puzzle; if (!pz) return;
  const m = MODES[pz.mode] || MODES.classic;
  $('modeBadge').textContent = isMobile() ? `${m.label} · ${pz.cols * pz.rows}` : `${m.label}${pz.limit ? ' · ' + Math.round(pz.limit / 60000) + ' min' : ''} · ${pz.cols * pz.rows} piezas`;
}

/* ---------------- tarjeta de estado de la partida ---------------- */
function stateKey() {
  const pz = game.puzzle, race = game.race; if (!pz || !race) return '';
  return `${pz.id}|${pz.mode}|${race.state}|${pz.doneAt ? 1 : 0}|${game.boardDone ? 1 : 0}|${game.boardKey}`;
}
function card(title, text, buttons = [], extra = null, corner = false) {
  const c = $('stateCard'); c.textContent = ''; c.classList.toggle('corner', corner);
  c.append(el('h2', null, title));
  if (text) c.append(el('p', null, text));
  if (extra) c.append(extra);
  if (buttons.length) {
    const row = el('div', 'btns');
    for (const [label, fn, cls] of buttons) { const b = el('button', 'btn ' + (cls || '')); b.type = 'button'; b.textContent = label; b.onclick = fn; row.append(b); }
    c.append(row);
  }
  c.hidden = false;
}
const hideCard = () => { dismissed = stateKey(); $('stateCard').hidden = true; };
function renderState() {
  const pz = game.puzzle, race = game.race, c = $('stateCard');
  renderLobby();
  if (!pz || !race) { c.hidden = true; return; }
  if (pz.lobby && race.state === 'waiting') { c.hidden = true; return; }
  const key = stateKey();
  if (dismissed === key) { c.hidden = true; return; }
  const total = pz.cols * pz.rows, limitTxt = pz.limit ? fmt(pz.limit) : null;
  const newBtn = canNewGame() ? [['Nueva partida', () => openWizard('new')]] : [];
  const videoBtn = timelapseSupported() ? [['Ver video del armado', () => openVideo()]] : [];
  if (race.state === 'waiting') {
    const players = game.players.filter(p => p.role !== 'viewer');
    const who = el('p', 'muted', `En la sala: ${players.map(p => p.name).join(', ') || 'solo tú'}.`);
    const btns = canControl() ? [[pz.mode === 'race' ? 'Empezar carrera' : 'Empezar', () => game.control('start'), 'primary']] : [];
    const wait = canControl() ? '' : ' Esperando a que el administrador empiece.';
    if (pz.mode === 'race') card('Carrera', `Cada quien arma su propia copia de ${total} piezas. Gana quien termine primero${limitTxt ? `; hay ${limitTxt} de límite` : ''}. Las piezas aparecen al terminar la cuenta regresiva.${wait}`, btns, who);
    else card('Contrarreloj', `Tienen ${limitTxt} para armar juntos las ${total} piezas. El reloj empieza cuando alguien pulse Empezar.${wait}`, btns, who);
    return;
  }
  if (race.state === 'countdown') { c.hidden = true; return; }
  if (race.state === 'timeout') {
    const pct = game.progress.shared ? game.progress.shared.pct : 0;
    const btns = canControl() ? [['Seguir sin límite', () => game.control('continue'), 'primary'], ['Reintentar', () => game.control('restart')]] : [];
    card('¡Se acabó el tiempo!', `Armaron el ${pct}% del rompecabezas.${canControl() ? '' : ' El administrador decide si siguen.'}`, [...btns, ...newBtn, ['Cerrar', hideCard]]);
    return;
  }
  if (pz.mode === 'race' && race.state === 'finished') {
    const list = raceRanking(), ol = el('ol', 'results');
    list.forEach((r, i) => {
      const li = el('li'); li.append(el('span', 'medal', ['🥇', '🥈', '🥉'][i] || String(i + 1)));
      const nm = el('b', null, r.name + (r.pub === game.pub ? ' (tú)' : '')); nm.style.color = r.color; li.append(nm);
      li.append(el('span', 't', r.doneMs != null ? fmt(r.doneMs) : `${r.pct}%`)); ol.append(li);
    });
    const btns = canControl() ? [['Revancha', () => game.control('restart'), 'primary']] : [];
    card('¡Terminó la carrera!', list.length && list[0].doneMs != null ? `Ganó ${list[0].name} con ${fmt(list[0].doneMs)}.` : 'Se acabó el tiempo.', [...btns, ...newBtn, ...videoBtn, ['Cerrar', hideCard]], ol);
    return;
  }
  if (pz.mode === 'race' && race.state === 'running' && game.boardDone && game.boardKey === game.pub) {
    const list = raceRanking(), pos = list.findIndex(r => r.pub === game.pub) + 1;
    card('¡Terminaste!', `Llegaste en el puesto ${pos} con ${fmt(game.boardDone - race.startAt)}. Puedes mirar a los demás en el panel de la carrera.`, [...videoBtn, ['Cerrar', hideCard]], null, true);
    return;
  }
  if (pz.doneAt && pz.mode !== 'race') {
    const ms = pz.doneAt - (race.startAt || pz.createdAt);
    const extra = podium();
    card('¡Completado!', `${pz.mode === 'timed' ? `¡Lo lograron con ${fmt(Math.max(0, pz.limit - ms))} de sobra! ` : ''}Tiempo: ${fmt(ms)}.${teamWinnerText()}`, [...videoBtn, ...newBtn, ['Admirar', hideCard]], extra);
    return;
  }
  c.hidden = true;
}
function podium() {
  const points = s => (s ? s.joins + s.placed : 0);
  const ranked = Object.entries(game.scores || {}).map(([pub, s]) => ({ pub, ...s, pts: points(s) })).filter(s => s.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 3);
  if (ranked.length < 2) return null;
  const pod = el('ol', 'podium');
  const order = ranked.length === 3 ? [1, 0, 2] : [1, 0];
  for (const idx of order) {
    const s = ranked[idx]; const li = el('li', 'p' + (idx + 1));
    const av = el('div', 'av', initial(s.name)); av.style.background = s.color || '#888';
    li.append(av, el('div', 'nm', s.name), el('div', 'pts', `${s.pts} pts`), el('div', 'step', String(idx + 1)));
    pod.append(li);
  }
  return pod;
}

/* ---------------- carrera ---------------- */
function raceRanking() {
  const pr = game.progress || {};
  return Object.entries(pr).map(([pub, p]) => ({ pub, ...p }))
    .sort((a, b) => (a.doneMs == null) - (b.doneMs == null) || (a.doneMs || 0) - (b.doneMs || 0) || b.pct - a.pct);
}
function renderRace() {
  const pz = game.puzzle, panel = $('racePanel');
  if (!pz || pz.mode !== 'race' || !game.race || game.race.state === 'waiting') { panel.hidden = true; return; }
  if (panel.hidden && isMobile()) $('raceToggle').setAttribute('aria-expanded', 'false');
  panel.hidden = false;
  const list = $('raceList'); list.textContent = '';
  const ranking = raceRanking();
  ranking.forEach((r, i) => {
    const li = el('li', 'race-row' + (r.pub === game.pub ? ' me' : '') + (r.doneMs != null ? ' done' : ''));
    li.append(el('span', 'pos', String(i + 1)));
    const mid = el('div'); const nm = el('div', 'nm', r.name || 'Jugador'); const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = r.pct + '%'; fill.style.background = r.color; bar.append(fill); mid.append(nm, bar);
    const val = el('div', 'val'); val.append(el('b', null, r.doneMs != null ? fmt(r.doneMs) : `${r.pct}%`));
    if (r.pub !== game.boardKey && (game.boardDone || game.role === 'viewer' || !game.progress[game.pub] || game.race.state === 'finished')) {
      const w = el('button', 'btn small watch', 'Ver'); w.type = 'button'; w.onclick = () => game.watch(r.pub); val.append(w);
    }
    li.append(mid, val); list.append(li);
  });
  const mine = ranking.findIndex(r => r.pub === game.pub);
  $('raceMine').textContent = mine >= 0 ? `Vas ${mine + 1}º · ${ranking[mine].doneMs != null ? fmt(ranking[mine].doneMs) : ranking[mine].pct + '%'}` : `${ranking.length} jugando`;
  $('raceBack').hidden = !(game.progress[game.pub] && game.boardKey !== game.pub);
}
function renderWatching() {
  const pz = game.puzzle, w = $('watching');
  if (!pz || pz.mode !== 'race' || game.boardKey === game.pub || !game.progress[game.boardKey]) { w.hidden = true; return; }
  w.textContent = `Estás mirando el tablero de ${game.progress[game.boardKey].name || 'otra persona'}`;
  w.hidden = false;
}
$('raceToggle').onclick = () => { const b = $('raceToggle'); b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') !== 'true')); };
$('raceBack').onclick = () => game.watch(null);

/* ---------------- herramientas ---------------- */
const pops = ['popReact', 'popTheme', 'popMore', 'popMusic', 'menu'];
function closePops(except) {
  for (const id of pops) if (id !== except) $(id).hidden = true;
  document.querySelectorAll('[data-act="react"]').forEach(b => b.setAttribute('aria-expanded', String(!$('popReact').hidden)));
  document.querySelectorAll('[data-act="theme"]').forEach(b => b.setAttribute('aria-expanded', String(!$('popTheme').hidden)));
  document.querySelectorAll('[data-act="more"]').forEach(b => b.setAttribute('aria-expanded', String(!$('popMore').hidden)));
  $('btnMenu').setAttribute('aria-expanded', String(!$('menu').hidden));
}
function togglePop(id) { $(id).hidden = !$(id).hidden; closePops(id); }
const pressAll = (act, v) => document.querySelectorAll(`[data-act="${act}"]`).forEach(b => setPressed(b, v));
const ACTIONS = {
  tray: () => { setTray($('tray').hidden); ls.set('rz_tray', $('tray').hidden ? '0' : '1'); },
  arrange: () => game.arrange(),
  edges: () => { pressAll('edges', game.toggleEdges()); scheduleTray(); },
  guide: () => pressAll('guide', game.toggleGuide()),
  photo: () => { const p = $('photo'); p.hidden = !p.hidden; pressAll('photo', !p.hidden); if (!p.hidden) closePanels(); },
  react: () => togglePop('popReact'),
  theme: () => togglePop('popTheme'),
  music: () => togglePop('popMusic'),
  pan: () => pressAll('pan', game.togglePan()),
  more: () => togglePop('popMore'),
};
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
  const act = b.dataset.act;
  if (b.closest('#popMore') && act !== 'theme') $('popMore').hidden = true;
  ACTIONS[act] && ACTIONS[act]();
}));
$('cv').addEventListener('pointerdown', () => { closePops(); });

/* ---------------- música para armar ---------------- */
function renderMusic() {
  const st = music.state, box = $('musicMoods'); box.textContent = '';
  const moods = [...music.moods];
  if (music.trackCount) moods.push({ id: 'pistas', label: 'Pistas grabadas', hint: 'Una mezcla al azar, sin repetir la anterior' });
  for (const m of moods) {
    const b = el('button', 'mood'); b.type = 'button'; b.setAttribute('aria-pressed', String(st.mood === m.id));
    b.append(m.label, el('small', '', m.hint)); b.onclick = () => { music.setMood(m.id); };
    box.append(b);
  }
  $('musicToggle').textContent = st.on ? 'Pausar' : 'Reproducir';
  $('musicVol').value = st.vol; $('musicVolN').textContent = st.vol + '%';
  pressAll('music', st.on && music.playing);
  const now = st.mood === 'pistas' && music.trackNow;
  $('musicNow').hidden = !now; if (now) $('musicNow').textContent = '♪ ' + now.titulo + (now.autor ? ' · ' + now.autor : '');
}
$('musicToggle').onclick = () => music.toggle();
$('musicVol').addEventListener('input', e => music.setVol(+e.target.value));
music.onChange(renderMusic); music.probe(); renderMusic();
$('zIn').onclick = () => game.zoomIn(); $('zOut').onclick = () => game.zoomOut(); $('zFit').onclick = () => game.fit();

/* ---------------- menú ---------------- */
function closePanels() { $('chat').hidden = true; $('people').hidden = true; }
$('btnMenu').onclick = () => togglePop('menu');
const MENU = {
  share: openShare,
  chat: openChat,
  people: openPeople,
  new: () => { if (canNewGame()) openWizard('new'); else toast(game.role === 'viewer' ? 'Estás como espectador.' : 'En esta sala solo los administradores empiezan partidas nuevas.'); },
  video: () => openVideo(),
  full: toggleFull,
  help: () => { $('mHelp').hidden = false; },
  leave: leaveRoom,
};
document.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => { $('menu').hidden = true; closePops(); MENU[b.dataset.m](); }));
async function toggleFull() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { toast('Tu navegador no permite pantalla completa aquí.'); }
}
document.addEventListener('fullscreenchange', () => setTimeout(() => game.resize(), 100));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const id of ['mWizard', 'mShare', 'mEmoji', 'mInstall', 'mCall', 'mHelp', ...pops, 'people', 'chat']) $(id).hidden = true;
  closePops();
});

/* ---------------- fondo de la mesa ---------------- */
function applyTheme(id) {
  game.setTheme(id); ls.set('rz_theme', id);
  [...$('themeRow').children].forEach(b => setPressed(b, b.dataset.id === id));
}
THEMES.forEach(t => {
  const b = el('button', 'theme'); b.type = 'button'; b.dataset.id = t.id;
  const sw = el('i'); sw.style.background = t.bg; b.append(sw, document.createTextNode(t.label));
  b.onclick = () => applyTheme(t.id);
  $('themeRow').append(b);
});

/* ---------------- reacciones ---------------- */
function myReactions() {
  try { const a = JSON.parse(ls.get('rz_reacts') || 'null'); if (Array.isArray(a) && a.length === 5 && a.every(x => typeof x === 'string' && x.length <= 16)) return a; } catch { }
  return DEFAULT_REACTIONS.slice();
}
function renderReactRow() {
  const row = $('reactRow'); row.textContent = '';
  myReactions().forEach((e, i) => {
    const b = el('button', null, e); b.type = 'button'; b.setAttribute('aria-label', 'Reaccionar ' + e);
    b.append(el('kbd', null, String(i + 1)));
    b.onclick = () => game.react(e);
    row.append(b);
  });
}
renderReactRow();
window.addEventListener('keydown', e => {
  if (!inGame || e.target.closest('input,textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = Number(e.key); if (k >= 1 && k <= 5) game.react(myReactions()[k - 1]);
});
function floatEmoji(emoji, pos, pl) {
  const f = el('div', 'float');
  f.style.left = Math.max(30, Math.min(window.innerWidth - 30, pos.x)) + 'px';
  f.style.top = Math.max(60, Math.min(window.innerHeight - 30, pos.y)) + 'px';
  f.append(el('span', 'e', emoji));
  if (pl) { const n = el('span', 'n', pl.name); n.style.background = pl.color; f.append(n); }
  $('fx').append(f); setTimeout(() => f.remove(), 2000);
}
let slotSel = 0, draftReacts = null;
function renderEmojiModal() {
  const slots = $('emojiSlots'); slots.textContent = '';
  draftReacts.forEach((e, i) => { const b = el('button', null, e); b.type = 'button'; setPressed(b, i === slotSel); b.setAttribute('aria-label', `Espacio ${i + 1}`); b.onclick = () => { slotSel = i; renderEmojiModal(); }; slots.append(b); });
}
EMOJIS.forEach(e => {
  const b = el('button', null, e); b.type = 'button';
  b.onclick = () => { draftReacts[slotSel] = e; slotSel = (slotSel + 1) % 5; renderEmojiModal(); };
  $('emojiGrid').append(b);
});
$('reactEdit').onclick = () => { draftReacts = myReactions(); slotSel = 0; renderEmojiModal(); $('mEmoji').hidden = false; closePops(); };
$('emojiReset').onclick = () => { draftReacts = DEFAULT_REACTIONS.slice(); renderEmojiModal(); };
$('emojiDone').onclick = () => { ls.set('rz_reacts', JSON.stringify(draftReacts)); renderReactRow(); $('mEmoji').hidden = true; };

/* ---------------- bandeja de piezas ---------------- */
// Se dibuja por tandas: con 500 piezas no conviene crear todo de golpe.
let trayT = null, trayDragging = false, trayItems = [], trayShown = 0;
const TRAY_CHUNK = 40;
function setTray(on) { $('tray').hidden = !on; pressAll('tray', on); if (on) renderTray(); }
function scheduleTray() { if ($('tray').hidden) return; clearTimeout(trayT); trayT = setTimeout(renderTray, 150); }
function renderTray() {
  if (trayDragging) { scheduleTray(); return; }
  const list = $('trayList');
  // Si cambió la partida (o el tablero que miras), no se reusan los dibujos anteriores.
  const tag = game.puzzle ? game.puzzle.id + '|' + game.boardKey : '';
  if (list.dataset.tag !== tag) { list.textContent = ''; list.dataset.tag = tag; trayShown = 0; }
  trayItems = game.loosePieces();
  $('trayCount').textContent = `${trayItems.length} ${trayItems.length === 1 ? 'pieza sin mover' : 'piezas sin mover'}`;
  const keep = new Map([...list.children].filter(c => c.dataset.gid).map(c => [c.dataset.gid, c]));
  const want = Math.max(TRAY_CHUNK, Math.min(trayShown || TRAY_CHUNK, trayItems.length));
  list.textContent = '';
  if (!trayItems.length) { list.append(el('div', 'tray-empty', game.puzzle ? (game.canPlay || !game.race || game.race.state !== 'waiting' ? 'Ya sacaste todas las piezas de la bandeja.' : 'Las piezas aparecen cuando empiece la partida.') : 'Cargando…')); return; }
  trayShown = 0;
  appendTray(want, keep);
}
function appendTray(count, keep = new Map()) {
  const list = $('trayList');
  const end = Math.min(trayItems.length, trayShown + count);
  for (; trayShown < end; trayShown++) {
    const it = trayItems[trayShown];
    let b = keep.get(it.gid);
    if (!b) {
      const spr = game.sprite(it.i); if (!spr) continue;
      b = el('button', 'tray-item'); b.type = 'button'; b.dataset.gid = it.gid; b.setAttribute('aria-label', 'Pieza');
      const c = el('canvas'); c.width = c.height = 124; c.getContext('2d').drawImage(spr, 0, 0, 124, 124);
      b.append(c); wireTrayItem(b);
    }
    list.append(b);
  }
}
$('trayList').addEventListener('scroll', () => {
  const l = $('trayList');
  if (l.scrollLeft + l.clientWidth > l.scrollWidth - 200 && trayShown < trayItems.length) appendTray(TRAY_CHUNK);
}, { passive: true });
function wireTrayItem(b) {
  let start = null, dragging = false;
  b.addEventListener('pointerdown', e => { start = { x: e.clientX, y: e.clientY, id: e.pointerId, mouse: e.pointerType === 'mouse' }; dragging = false; });
  b.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    if (!dragging) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      // En pantallas táctiles, deslizar a los lados desplaza la bandeja; hacia arriba saca la pieza.
      const go = start.mouse ? Math.hypot(dx, dy) > 6 : (dy < -10 && Math.abs(dy) > Math.abs(dx));
      if (!go) return;
      if (!game.externalStart(b.dataset.gid, e)) { start = null; return; }
      dragging = true; trayDragging = true; b.setPointerCapture(e.pointerId); b.style.opacity = '.3';
    }
    game.externalMove(e);
  });
  const end = e => {
    if (!start || e.pointerId !== start.id) return;
    if (dragging) { game.externalEnd(e); trayDragging = false; scheduleTray(); }
    start = null; dragging = false; b.style.opacity = '';
  };
  b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
}

/* ---------------- jugadores, puntos y administración ---------------- */
const points = s => (s ? s.joins + s.placed : 0);

/* ---------------- sala de espera, equipos y marcador por equipo ---------------- */
const TEAMS = [{ name: 'Ámbar', color: '#f2b134' }, { name: 'Cian', color: '#5ec8e5' }];
const teamsOn = () => !!(game.puzzle && game.puzzle.teams && game.puzzle.teams.on && game.puzzle.mode !== 'race');
/** Puntos por equipo: se cuenta el promedio por jugador, así 1 contra 2 es justo. */
function teamTotals() {
  const sc = game.scores || {}, t = [0, 1].map(() => ({ pts: 0, n: 0 }));
  for (const p of game.players) if (p.role !== 'viewer' && p.team != null) t[p.team].n++;
  for (const [pub, s] of Object.entries(sc)) if (s.team != null) { t[s.team].pts += points(s); const who = game.players.find(p => p.pub === pub); if (!who && !t[s.team].n) t[s.team].n = 1; }
  return t.map((x, i) => ({ ...TEAMS[i], pts: x.pts, n: x.n, avg: x.n ? Math.round((x.pts / x.n) * 10) / 10 : 0 }));
}
function renderLobby() {
  const box = $('waitroom'), pz = game.puzzle, race = game.race;
  const on = !!(pz && race && pz.lobby && race.state === 'waiting');
  box.hidden = !on; if (!on) return;
  const me = game.players.find(p => p.id === game.you), ctl = canControl(), mine = me && me.role !== 'viewer';
  const ps = game.players.filter(p => p.role !== 'viewer'), ready = ps.filter(p => p.ready).length;
  box.textContent = '';
  const card = el('div', 'wr-card');
  const head = el('div', 'wr-head');
  const img = el('img', 'wr-img'); img.src = pz.img; img.alt = 'La imagen del rompecabezas';
  const info = el('div', 'wr-info');
  const mode = { classic: 'Clásico', timed: 'Contrarreloj', race: 'Carrera' }[pz.mode] || pz.mode;
  info.append(el('h2', '', 'Sala de espera'), el('p', 'muted', `${pz.pieces} piezas · ${mode}${pz.limit ? ' · ' + fmt(pz.limit) : ''}`),
    el('p', 'muted', ctl ? 'Tú configuras la partida. Empieza cuando todos pulsen Listo.' : 'Pulsa Listo cuando estés preparado. Empieza cuando todos lo estén.'));
  head.append(img, info); card.append(head);

  if (ctl && pz.mode !== 'race') {
    const row = el('div', 'seg wr-seg'); row.setAttribute('role', 'group');
    for (const [v, label] of [[false, 'Todos juntos'], [true, 'Por equipos']]) {
      const b = el('button', '', label); b.type = 'button'; b.setAttribute('aria-pressed', String(teamsOn() === v));
      b.onclick = () => game.send({ t: 'teams', on: v }); row.append(b);
    }
    card.append(row);
  }
  const person = p => {
    const li = el('li', 'wr-p' + (p.ready ? ' ok' : ''));
    const d = el('span', 'dot'); d.style.background = p.color;
    li.append(d, el('span', 'nm', p.name + (p.id === game.you ? ' (tú)' : '')), p.role === 'owner' ? el('span', 'ic', '👑') : '', el('span', 'st', p.ready ? '✓ Listo' : 'Esperando…'));
    return li;
  };
  if (teamsOn()) {
    const cols = el('div', 'wr-teams');
    TEAMS.forEach((t, i) => {
      const col = el('div', 'wr-team'); col.style.setProperty('--tc', t.color);
      const mem = ps.filter(p => p.team === i), ul = el('ul', 'wr-list');
      mem.forEach(p => ul.append(person(p)));
      if (!mem.length) ul.append(el('li', 'wr-empty', 'Sin jugadores todavía'));
      col.append(el('h3', '', `Equipo ${t.name}`), ul);
      if (mine && me.team !== i) { const b = el('button', 'btn small', 'Unirme a este equipo'); b.type = 'button'; b.onclick = () => game.send({ t: 'team', team: i }); col.append(b); }
      cols.append(col);
    });
    card.append(cols, el('p', 'muted center small-note', 'Se permite 1 contra 2: el marcador cuenta el promedio por jugador.'));
  } else {
    const ul = el('ul', 'wr-list'); ps.forEach(p => ul.append(person(p))); card.append(ul);
  }
  const foot = el('div', 'foot'); foot.append(el('span', 'muted', `${ready} de ${ps.length} listos`));
  const btns = el('div', 'btns');
  if (ctl) { const b = el('button', 'btn', 'Cambiar partida'); b.type = 'button'; b.onclick = () => openWizard('new'); btns.append(b); const s = el('button', 'btn', 'Empezar ya'); s.type = 'button'; s.onclick = () => game.control('start'); btns.append(s); }
  if (mine) { const r = el('button', 'btn primary', me.ready ? 'Ya no estoy listo' : '¡Listo!'); r.type = 'button'; r.onclick = () => game.send({ t: 'ready', v: !me.ready }); btns.append(r); }
  foot.append(btns); card.append(foot); box.append(card);
}
function teamBar() {
  if (!teamsOn() || isMobile()) return null;
  const bar = el('span', 'team-bar');
  for (const t of teamTotals()) { const s = el('span', 'team-pill', `Equipo ${t.name} · ${t.avg}`); s.style.setProperty('--tc', t.color); s.title = `${t.pts} puntos entre ${t.n || 1} jugador(es)`; bar.append(s); }
  return bar;
}
function teamWinnerText() {
  if (!teamsOn()) return '';
  const [a, b] = teamTotals(); if (a.avg === b.avg) return ' Empate entre equipos.';
  const w = a.avg > b.avg ? a : b; return ` Ganó el Equipo ${w.name} (${a.avg} contra ${b.avg} por jugador).`;
}
function renderPlayers() {
  const list = game.players, you = game.you, scores = game.scores || {};
  const box = $('players'); box.textContent = '';
  const sorted = [...list].sort((a, b) => (b.id === you) - (a.id === you));
  const max = isMobile() ? 4 : 5;
  for (const p of sorted.slice(0, max)) {
    const c = el('span', 'chip'); const d = el('span', 'dot'); d.style.background = p.color;
    c.append(d, el('span', 'nm', p.name));
    if (p.role === 'owner') c.append(el('span', 'ic', '👑'));
    if (p.media && p.media.call) c.append(el('span', 'ic', p.media.mic ? '🎙️' : '🔇'));
    const pts = points(scores[p.pub]); if (pts && !isMobile()) c.append(el('span', 'pts', String(pts)));
    if (p.id === you) c.append(el('span', 'you', 'tú'));
    box.append(c);
  }
  if (list.length > max) box.append(el('span', 'chip', `+${list.length - max}`));
  const tb = teamBar(); if (tb) box.append(tb);
  if (list.length < 2 && !isMobile()) box.append(el('span', 'muted', 'Esperando a tu compañero…'));

  const staff = isStaff();
  $('tabRoom').hidden = !staff;
  if (!staff && $('tabRoom').getAttribute('aria-selected') === 'true') selectTab('p');
  $('myRoleNote').textContent = game.role === 'viewer' ? 'Estás como espectador: puedes mirar, chatear y reaccionar, pero no mover piezas.' : staff ? 'Las opciones de administración aparecen bajo cada jugador.' : '';
  const pl = $('plist'); pl.textContent = '';
  const ranked = [...list].sort((a, b) => points(scores[b.pub]) - points(scores[a.pub]) || (b.id === you) - (a.id === you));
  for (const p of ranked) {
    const li = el('li', 'pl'); const top = el('div', 'pl-top');
    const av = el('div', 'av', initial(p.name)); av.style.background = p.color;
    const info = el('div'); const nm = el('div', 'pl-name', p.name + (p.id === you ? ' (tú)' : ''));
    const meta = el('div', 'pl-meta');
    if (p.role !== 'player') meta.append(el('span', 'tag', ROLE_LABEL[p.role]));
    if (p.muted) meta.append(el('span', null, '🔇 silenciado'));
    if (p.media && p.media.call) meta.append(el('span', null, p.media.cam ? '📹 en llamada' : '🎙️ en llamada'));
    const s = scores[p.pub]; meta.append(el('span', null, s ? `${s.joins} encajes · ${s.placed} colocadas` : 'sin puntos aún'));
    info.append(nm, meta);
    const sc = el('div', 'pl-score'); sc.append(el('b', null, String(points(s))), el('span', null, 'puntos'));
    top.append(av, info, sc); li.append(top);
    if (staff && p.id !== you) li.append(adminActions(p));
    pl.append(li);
  }
}
function adminActions(p) {
  const wrap = el('div', 'pl-actions');
  const owner = game.role === 'owner';
  if (!(owner || (p.role !== 'owner' && p.role !== 'admin'))) { wrap.append(el('span', 'muted', 'Solo el dueño puede cambiar a otro admin.')); return wrap; }
  const btn = (label, fn, cls = '') => { const b = el('button', 'btn ' + cls, label); b.type = 'button'; b.onclick = fn; wrap.append(b); return b; };
  const act = (a, extra) => game.admin(a, { target: p.id, ...extra });
  if (owner) { if (p.role === 'admin') btn('Quitar admin', () => act('role', { role: 'player' })); else btn('Hacer admin', () => act('role', { role: 'admin' })); }
  if (p.role === 'viewer') btn('Dejar jugar', () => act('role', { role: 'player' }));
  else if (p.role !== 'admin') btn('Solo mirar', () => act('role', { role: 'viewer' }));
  btn(p.muted ? 'Quitar silencio' : 'Silenciar', () => act('mute', { on: !p.muted }));
  const confirmBtn = (label, question, fn) => {
    const b = btn(label, () => {
      b.hidden = true;
      const c = el('span', 'confirm'); c.append(el('span', null, question));
      const y = el('button', 'btn danger small', 'Sí'); y.type = 'button'; y.onclick = fn;
      const n = el('button', 'btn small', 'No'); n.type = 'button'; n.onclick = () => { c.remove(); b.hidden = false; };
      c.append(y, n); wrap.append(c);
    }, 'danger');
  };
  confirmBtn('Sacar', `¿Sacar a ${p.name}?`, () => act('kick'));
  confirmBtn('Bloquear', `¿Bloquear a ${p.name}? No podrá volver a entrar.`, () => act('ban'));
  if (owner) confirmBtn('Hacer dueño', `¿Darle la sala a ${p.name}? Tú quedarás como admin.`, () => act('transfer'));
  return wrap;
}
function selectTab(which) {
  $('tabPlayers').setAttribute('aria-selected', String(which === 'p')); $('tabRoom').setAttribute('aria-selected', String(which === 'r'));
  $('paneP').hidden = which !== 'p'; $('paneR').hidden = which !== 'r';
  if (which === 'r') renderRoomSettings(true);
}
$('tabPlayers').onclick = () => selectTab('p');
$('tabRoom').onclick = () => selectTab('r');
function openPeople() { closePanels(); $('people').hidden = false; $('photo').hidden = true; pressAll('photo', false); renderPlayers(); }
$('players').onclick = () => { if ($('people').hidden) openPeople(); else $('people').hidden = true; };

let rs = { public: false, max: 4, photo: 'all', arrange: 'all' };
function renderRoomSettings(fromTab) {
  const r = game.room; if (!r) return;
  if (!fromTab && !$('paneR').hidden && document.activeElement && $('paneR').contains(document.activeElement)) return;
  rs = { public: r.public, max: r.max, photo: r.perms.photo, arrange: r.perms.arrange };
  $('rsName').value = r.name;
  seg($('rsVis'), [{ v: false, label: 'Privada' }, { v: true, label: 'Pública' }], () => rs.public, v => { rs.public = v; });
  seg($('rsMax'), [2, 4, 8, 12].map(v => ({ v, label: String(v) })), () => rs.max, v => { rs.max = v; });
  seg($('rsPhoto'), [{ v: 'all', label: 'Todos' }, { v: 'admin', label: 'Solo admins' }], () => rs.photo, v => { rs.photo = v; });
  seg($('rsArrange'), [{ v: 'all', label: 'Todos' }, { v: 'admin', label: 'Solo admins' }], () => rs.arrange, v => { rs.arrange = v; });
  $('rsPwState').textContent = r.hasPassword ? 'La sala tiene contraseña. Quien ya está dentro no sale.' : 'Sin contraseña: entra cualquiera con el código.';
  $('rsPwClear').hidden = !r.hasPassword;
  $('rsDanger').hidden = game.role !== 'owner';
  renderBans();
}
function renderBans() {
  const ul = $('rsBans'); ul.textContent = '';
  if (!adminBans.length) { ul.append(el('li', 'muted', 'Nadie bloqueado.')); return; }
  for (const b of adminBans) {
    const li = el('li'); li.append(el('span', null, b.name));
    const u = el('button', 'btn small', 'Desbloquear'); u.type = 'button'; u.onclick = () => game.admin('unban', { pub: b.pub });
    li.append(u); ul.append(li);
  }
}
$('roomForm').addEventListener('submit', e => {
  e.preventDefault();
  game.admin('settings', { name: $('rsName').value, public: rs.public, max: rs.max, perms: { photo: rs.photo, arrange: rs.arrange } });
  toast('Cambios guardados.');
});
$('rsPwSave').onclick = () => { const v = $('rsPw').value.trim(); if (!v) { toast('Escribe una contraseña.'); return; } game.admin('password', { password: v }); ls.set(pwKey(game.room.code), v); $('rsPw').value = ''; };
$('rsPwClear').onclick = () => game.admin('password', { password: '' });
$('rsDelete').onclick = () => { $('rsDelete').hidden = true; $('rsDeleteConfirm').hidden = false; };
$('rsDeleteNo').onclick = () => { $('rsDelete').hidden = false; $('rsDeleteConfirm').hidden = true; };
$('rsDeleteYes').onclick = () => { game.admin('delete'); $('rsDelete').hidden = false; $('rsDeleteConfirm').hidden = true; };

/* ---------------- chat ---------------- */
function badge() {
  const t = unread > 9 ? '9+' : String(unread);
  $('chatBadge').hidden = unread === 0; $('chatBadge').textContent = t;
  $('menuChatBadge').hidden = unread === 0; $('menuChatBadge').textContent = t;
  $('menuBadge').hidden = !(unread > 0 && isMobile());
}
function addMsg(m) {
  const li = el('li'); const b = el('b', null, m.name); b.style.color = m.color;
  li.append(b, document.createTextNode(m.text)); $('msgs').append(li); $('msgs').scrollTop = $('msgs').scrollHeight;
}
function sysMsg(t) { $('msgs').append(el('li', 'sys', t)); $('msgs').scrollTop = $('msgs').scrollHeight; }
function openChat() { closePanels(); $('chat').hidden = false; $('tip').hidden = true; unread = 0; badge(); $('photo').hidden = true; pressAll('photo', false); if (!isMobile()) $('chatInput').focus(); }
$('btnChat').onclick = () => { if ($('chat').hidden) openChat(); else $('chat').hidden = true; };
$('chatForm').addEventListener('submit', e => { e.preventDefault(); const v = $('chatInput').value.trim(); if (!v) return; if (game.chat(v)) $('chatInput').value = ''; else toast('Sin conexión.'); });

/* ---------------- invitar ---------------- */
function openShare() {
  const r = game.room; if (!r) return;
  $('shareCode').textContent = r.code; $('shareLink').value = roomLink(r.code);
  $('shareInfo').textContent = `${r.public ? 'Sala pública' : 'Sala privada'}${r.hasPassword ? ' con contraseña' : ''} · hasta ${r.max} jugadores.`;
  $('shareNative').hidden = !navigator.share;
  $('mShare').hidden = false;
}
$('btnShare').onclick = openShare;
$('shareCopy').onclick = () => copy($('shareLink').value);
$('shareNative').onclick = () => { const r = game.room; navigator.share({ title: 'Rompecabezas a Dos', text: `¡Armemos un rompecabezas! Código: ${r.code}`, url: roomLink(r.code) }).catch(() => {}); };

/* =========================================================================
   Llamada con voz y cámara
   ========================================================================= */
const remoteStreams = new Map(), peerStates = new Map();
let localStream = null;
const call = new Call(net, {
  onLocal(stream, state) { localStream = stream; renderCall(); },
  onRemote(id, stream) { if (stream) remoteStreams.set(id, stream); else { remoteStreams.delete(id); music.speaking(id, false); } renderCall(); },
  onSpeaking(id, v) { music.speaking(id, v); const t = document.querySelector(`.tile[data-id="${id === 'me' ? 'me' : id}"]`); if (t) t.classList.toggle('speaking', v); },
  onPeerState(id, s) { peerStates.set(id, s); renderCall(); },
  onError: toast,
});
function leaveCall() { music.resetSpeakers(); if (call.inCall) call.leave(); $('call').hidden = true; remoteStreams.clear(); }
function renderCall() {
  const inCall = call.inCall, players = game.players || [];
  const others = players.filter(p => p.id !== game.you && p.media && p.media.call);
  const n = others.length + (inCall ? 1 : 0);
  $('callCount').hidden = n === 0; $('callCount').textContent = String(n);
  $('btnCall').classList.toggle('primary', inCall);
  $('call').hidden = !inCall;
  if (!inCall) { $('tiles').textContent = ''; return; }
  $('callTitle').textContent = `Llamada · ${n}`;
  const st = call.state();
  const mic = $('cMic'), cam = $('cCam');
  mic.classList.toggle('off', !st.mic); mic.firstElementChild.firstElementChild.setAttribute('href', st.mic ? '#i-mic' : '#i-micoff');
  cam.classList.toggle('off', !st.cam); cam.firstElementChild.firstElementChild.setAttribute('href', st.cam ? '#i-cam' : '#i-camoff');
  $('cFlip').hidden = !(st.cam && isMobile());
  $('callHint').hidden = st.mic || st.cam;
  mic.title = st.mic ? 'Silenciar micrófono' : 'Activar micrófono'; cam.title = st.cam ? 'Apagar cámara' : 'Encender cámara';
  mic.setAttribute('aria-label', mic.title); cam.setAttribute('aria-label', cam.title);
  const tiles = $('tiles');
  const wanted = [{ id: 'me', name: me.name + ' (tú)', color: me.color, stream: localStream, cam: st.cam, mic: st.mic, me: true },
    ...others.map(p => ({ id: p.id, name: p.name, color: p.color, stream: remoteStreams.get(p.id) || null, cam: p.media.cam, mic: p.media.mic }))];
  const keep = new Set(wanted.map(w => w.id));
  [...tiles.children].forEach(t => { if (!keep.has(t.dataset.id)) t.remove(); });
  for (const w of wanted) {
    let t = tiles.querySelector(`.tile[data-id="${w.id}"]`);
    if (!t) {
      t = el('div', 'tile' + (w.me ? ' me' : '')); t.dataset.id = w.id;
      // El video va siempre sin sonido; la voz suena por un <audio> aparte (así se oye aunque no haya cámara).
      const v = el('video'); v.autoplay = true; v.playsInline = true; v.muted = true; v.setAttribute('playsinline', '');
      const av = el('div', 'av'); const who = el('div', 'who'); const stt = el('span', 'state-txt');
      t.append(av, v, who, stt);
      if (!w.me) { const a = el('audio'); a.autoplay = true; t.append(a); }
      tiles.append(t);
    }
    const v = t.querySelector('video'), a = t.querySelector('audio'), av = t.querySelector('.av'), who = t.querySelector('.who'), stt = t.querySelector('.state-txt');
    if (w.stream && v.srcObject !== w.stream) { v.srcObject = w.stream; v.play().catch(() => {}); }
    if (a && w.stream && a.srcObject !== w.stream) { a.srcObject = w.stream; a.play().catch(() => { $('callUnmute').hidden = false; }); }
    v.classList.toggle('off', !w.cam);
    av.textContent = initial(w.name); av.style.background = w.color; av.hidden = !!w.cam;
    who.textContent = ''; if (!w.mic) who.append(icon('i-micoff')); who.append(document.createTextNode(w.name));
    const ps = peerStates.get(w.id);
    stt.hidden = w.me || !(ps && ps !== 'connected'); stt.textContent = ps === 'failed' ? 'sin conexión' : 'conectando…';
  }
}
$('callUnmute').onclick = () => { document.querySelectorAll('.tile audio, .tile video').forEach(m => m.play().catch(() => {})); $('callUnmute').hidden = true; };
$('btnCall').onclick = () => {
  if (call.inCall) { $('call').classList.toggle('min'); return; }
  const others = (game.players || []).filter(p => p.id !== game.you && p.media && p.media.call);
  $('callInfo').textContent = others.length ? `${others.map(p => p.name).join(', ')} ${others.length === 1 ? 'está' : 'están'} en la llamada.` : 'Hablen mientras arman.';
  $('callErr').hidden = true; $('mCall').hidden = false;
};
async function joinCall() {
  $('callErr').hidden = true; $('joinCall').disabled = true;
  try { game.unlockAudio(); await call.join(); $('mCall').hidden = true; $('call').classList.remove('min'); renderCall(); }
  catch (e) { $('callErr').textContent = e.message; $('callErr').hidden = false; }
  finally { $('joinCall').disabled = false; }
}
$('joinCall').onclick = joinCall;
$('cMic').onclick = () => call.toggleMic();
$('cCam').onclick = () => call.toggleCam();
$('cFlip').onclick = () => call.flipCam();
$('cLeave').onclick = () => { call.leave(); renderCall(); };
$('callMin').onclick = () => $('call').classList.toggle('min');

/* =========================================================================
   Video del armado
   ========================================================================= */
let videoAbort = null, videoUrl = null;
function openVideo() {
  if (!timelapseSupported()) { toast('Tu navegador no puede grabar video. Prueba con Chrome, Edge o Firefox.'); return; }
  const pz = game.puzzle; if (!pz) return;
  $('videoErr').hidden = true; $('tlProgress').hidden = true; $('tlCanvas').hidden = true; $('tlVideo').hidden = true;
  $('videoDownload').hidden = true; $('videoShare').hidden = true; $('videoGo').hidden = false; $('videoGo').disabled = false;
  const whose = pz.mode === 'race' && game.boardKey !== game.pub && game.progress[game.boardKey] ? ` de ${game.progress[game.boardKey].name}` : '';
  $('videoMsg').textContent = `Se reproduce el armado${whose} en cámara rápida y se graba como video (unos 10 a 25 segundos). Deja esta pantalla abierta mientras se graba.`;
  $('mVideo').hidden = false;
}
$('videoGo').onclick = async () => {
  const key = game.puzzle.mode === 'race' ? (game.boardKey || game.pub) : 'shared';
  $('videoGo').disabled = true; $('videoErr').hidden = true;
  $('tlCanvas').hidden = false; $('tlVideo').hidden = true; $('tlProgress').hidden = false;
  const bar = $('tlProgress').firstElementChild; bar.style.width = '0%';
  videoAbort = new AbortController();
  try {
    const res = await makeTimelapse({ code: game.room.code, key, canvas: $('tlCanvas'), assets: game.assets, themeName: ls.get('rz_theme') || 'ciruela', onProgress: p => { bar.style.width = Math.round(p * 100) + '%'; }, signal: videoAbort.signal });
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(res.blob);
    const v = $('tlVideo'); v.src = videoUrl; v.hidden = false; $('tlCanvas').hidden = true; $('tlProgress').hidden = true;
    const name = `rompecabezas-${(game.room.name || 'armado').toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-').slice(0, 30)}.${res.ext}`;
    const a = $('videoDownload'); a.href = videoUrl; a.download = name; a.hidden = false;
    $('videoGo').hidden = true;
    const file = new File([res.blob], name, { type: res.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      $('videoShare').hidden = false;
      $('videoShare').onclick = () => navigator.share({ files: [file], title: 'Rompecabezas a Dos', text: '¡Miren cómo lo armamos!' }).catch(() => {});
    }
  } catch (e) {
    if (e.message !== 'cancelado') { $('videoErr').textContent = e.message; $('videoErr').hidden = false; }
    $('tlCanvas').hidden = true; $('tlProgress').hidden = true;
  } finally { $('videoGo').disabled = false; videoAbort = null; }
};
$('videoClose').addEventListener('click', () => { if (videoAbort) videoAbort.abort(); const v = $('tlVideo'); v.pause(); });

/* =========================================================================
   Asistente: crear sala / nueva partida
   ========================================================================= */
const cropper = new Cropper($('cropCv'), $('cropZoom'));
/* Galería de imágenes clásicas (opcional: aparece si existe /galeria/galeria.json) */
let gallery = null, galleryTried = false;
const wzSrc = { tab: 'upload', cat: 'todas' };
async function loadGallery() {
  if (galleryTried) return; galleryTried = true;
  try {
    const r = await fetch('/galeria/galeria.json');
    if (r.ok && /json/.test(r.headers.get('content-type') || '')) { const j = await r.json(); if (Array.isArray(j.imagenes) && j.imagenes.length) gallery = j; }
  } catch { }
  if (gallery && !$('mWizard').hidden) renderWizard();
}
function renderGallery() {
  const cats = [{ id: 'todas', nombre: 'Todas' }, ...(gallery.categorias || [])];
  const cbox = $('galCats'); cbox.textContent = '';
  for (const c of cats) { const b = el('button', '', c.nombre); b.type = 'button'; b.setAttribute('aria-pressed', String(wzSrc.cat === c.id)); b.onclick = () => { wzSrc.cat = c.id; renderGallery(); }; cbox.append(b); }
  const grid = $('galGrid'); grid.textContent = '';
  for (const it of gallery.imagenes.filter(i => wzSrc.cat === 'todas' || i.cat === wzSrc.cat)) {
    const b = el('button', 'gal-item'); b.type = 'button';
    b.title = `${it.titulo}${it.autor ? ' · ' + it.autor : ''}${it.licencia ? ' · ' + it.licencia : ''}`;
    const img = el('img'); img.src = it.mini || it.src; img.alt = it.titulo; img.loading = 'lazy';
    b.append(img, el('span', '', it.titulo)); b.onclick = () => pickGallery(it, b);
    grid.append(b);
  }
}
async function pickGallery(it, btn) {
  btn.classList.add('busy');
  try {
    const r = await fetch(it.src); if (!r.ok) throw new Error();
    const blob = await r.blob();
    await loadFile(new File([blob], it.id + '.jpg', { type: blob.type || 'image/jpeg' }));
  } catch { $('wzErr').textContent = 'No se pudo cargar esa imagen. Prueba con otra.'; $('wzErr').hidden = false; }
  finally { btn.classList.remove('busy'); }
}
document.querySelectorAll('#srcTabs [data-src]').forEach(b => b.addEventListener('click', () => { wzSrc.tab = b.dataset.src; renderWizard(); }));
const STEP_LABELS = { photo: 'Foto', game: 'Juego', room: 'Sala' };
const wz = { kind: 'create', steps: [], i: 0, same: false, ratio: '1:1', pieces: 64, mode: 'classic', limit: 10, isPublic: false, max: 4 };
function openWizard(kind) {
  loadGallery();
  wz.kind = kind; wz.i = 0;
  wz.steps = kind === 'create' ? ['photo', 'game', 'room'] : ['photo', 'game'];
  const pz = game.puzzle;
  wz.same = kind === 'new' && !!pz;
  if (wz.same) { wz.ratio = pz.ratio || '1:1'; wz.pieces = pz.pieces || 64; wz.mode = pz.mode; wz.limit = pz.limit ? Math.round(pz.limit / 60000) : 10; }
  $('wzTitle').textContent = kind === 'create' ? 'Crear sala' : 'Nueva partida';
  $('wzSame').hidden = !(kind === 'new' && pz);
  if (kind === 'create') { $('roomNameIn').value = `Sala de ${me.name}`; $('roomPwIn').value = ''; }
  $('wzErr').hidden = true;
  renderWizard(); $('mWizard').hidden = false; closePops();
}
function renderWizard() {
  const step = wz.steps[wz.i];
  const bar = $('wzSteps'); bar.textContent = '';
  wz.steps.forEach((s, i) => { const li = el('li', i === wz.i ? 'on' : i < wz.i ? 'done' : '', `${i + 1}. ${STEP_LABELS[s]}`); bar.append(li); });
  document.querySelectorAll('.wz-step').forEach(s => { s.hidden = s.dataset.step !== step; });
  // Paso foto
  setPressed($('wzSame'), wz.same);
  const picking = !wz.same && !cropper.img, useGal = !!gallery && wzSrc.tab === 'gallery';
  $('srcTabs').hidden = !(gallery && picking); $('gallery').hidden = !(picking && useGal); $('cropGal').hidden = !gallery;
  document.querySelectorAll('#srcTabs [data-src]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.src === (useGal ? 'gallery' : 'upload'))));
  if (picking && useGal) renderGallery();
  $('drop').hidden = wz.same || !!cropper.img || useGal; $('cropBox').hidden = wz.same || !cropper.img;
  if (!wz.same && cropper.img) { renderRatios(); requestAnimationFrame(() => cropper.draw()); }
  // Paso juego
  renderModes(); renderLimits(); renderPieces();
  // Paso sala
  seg($('segVis'), [{ v: false, label: 'Privada', sub: 'Solo con el código' }, { v: true, label: 'Pública', sub: 'Sale en la lista' }], () => wz.isPublic, v => { wz.isPublic = v; });
  seg($('segMax'), [2, 4, 6].map(v => ({ v, label: String(v) })), () => wz.max, v => { wz.max = v; });
  // Pie
  const last = wz.i === wz.steps.length - 1;
  $('wzBack').textContent = wz.i === 0 ? 'Cancelar' : 'Atrás';
  $('wzNext').textContent = last ? (wz.kind === 'create' ? 'Crear sala' : 'Empezar') : 'Siguiente';
  $('wzNext').disabled = step === 'photo' && !wz.same && !cropper.img;
  const aspect = (RATIOS.find(r => r.id === wz.ratio) || RATIOS[0]).v, g = grid(aspect, wz.pieces);
  $('wzSummary').textContent = step === 'photo' ? '' : `${g.cols * g.rows} piezas · ${MODES[wz.mode].label}${wz.mode !== 'classic' && wz.limit ? ' · ' + wz.limit + ' min' : ''}`;
}
function renderRatios() {
  const box = $('ratioChips'); box.textContent = '';
  const nat = cropper.naturalAspect;
  const best = RATIOS.reduce((a, b) => Math.abs(Math.log(b.v / nat)) < Math.abs(Math.log(a.v / nat)) ? b : a);
  for (const r of RATIOS) {
    const b = el('button', null, r.label); b.type = 'button'; setPressed(b, r.id === wz.ratio);
    if (r.id === best.id) b.append(el('small', null, 'Recomendada'));
    b.onclick = () => { wz.ratio = r.id; cropper.setAspect(r.v); renderWizard(); };
    box.append(b);
  }
  cropper.setAspect((RATIOS.find(r => r.id === wz.ratio) || RATIOS[0]).v);
}
function renderModes() {
  const box = $('modeCards'); box.textContent = '';
  for (const [id, m] of Object.entries(MODES)) {
    const b = el('button', 'mode-card'); b.type = 'button'; setPressed(b, wz.mode === id);
    const txt = el('div'); txt.append(el('b', null, m.label), el('span', null, m.desc));
    b.append(icon(m.icon), txt);
    b.onclick = () => { wz.mode = id; if (id === 'timed' && !wz.limit) wz.limit = 10; if (id === 'race' && !RACE_LIMITS.includes(wz.limit)) wz.limit = 0; renderWizard(); };
    box.append(b);
  }
}
function renderLimits() {
  const f = $('limitField');
  if (wz.mode === 'classic') { f.hidden = true; return; }
  f.hidden = false;
  const opts = wz.mode === 'timed' ? TIMED_LIMITS : RACE_LIMITS;
  if (!opts.includes(wz.limit)) wz.limit = wz.mode === 'timed' ? 10 : 0;
  $('limitLabel').textContent = wz.mode === 'timed' ? 'Tiempo para armarlo' : 'Límite de tiempo';
  const box = $('limitChips'); box.textContent = '';
  for (const v of opts) {
    const b = el('button', null, v ? `${v} min` : 'Sin límite'); b.type = 'button'; setPressed(b, v === wz.limit);
    b.onclick = () => { wz.limit = v; renderWizard(); };
    box.append(b);
  }
}
function renderPieces() {
  const box = $('piecesGrid'); box.textContent = '';
  const aspect = (RATIOS.find(r => r.id === wz.ratio) || RATIOS[0]).v;
  for (const p of PIECES) {
    const g = grid(aspect, p.v), n = g.cols * g.rows;
    const b = el('button', null, String(n)); b.type = 'button'; setPressed(b, p.v === wz.pieces);
    b.append(el('small', null, p.sub));
    b.onclick = () => { wz.pieces = p.v; renderWizard(); };
    box.append(b);
  }
  $('piecesNote').textContent = wz.pieces >= 300 ? '· con muchas piezas, mejor en computadora o tablet' : '';
}
$('wzSame').onclick = () => { wz.same = !wz.same; if (wz.same && game.puzzle) wz.ratio = game.puzzle.ratio || '1:1'; renderWizard(); };
async function loadFile(f) {
  if (!f) return;
  try {
    await cropper.load(f);
    wz.same = false;
    const nat = cropper.naturalAspect;
    wz.ratio = RATIOS.reduce((a, b) => Math.abs(Math.log(b.v / nat)) < Math.abs(Math.log(a.v / nat)) ? b : a).id;
    $('wzErr').hidden = true; renderWizard();
  } catch (e) { $('wzErr').textContent = e.message; $('wzErr').hidden = false; }
}
$('file').onchange = e => loadFile(e.target.files[0]);
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
$('cropOther').onclick = () => { $('file').value = ''; $('file').click(); };
$('cropGal').onclick = () => { cropper.reset(); $('file').value = ''; wzSrc.tab = 'gallery'; renderWizard(); };
window.addEventListener('resize', () => { if (!$('mWizard').hidden && cropper.img) cropper.draw(); });
$('wzBack').onclick = () => { if (wz.i === 0) { $('mWizard').hidden = true; return; } wz.i--; renderWizard(); };
$('wzForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (wz.i < wz.steps.length - 1) { wz.i++; $('wzErr').hidden = true; renderWizard(); return; }
  const btn = $('wzNext'), label = btn.textContent; btn.disabled = true; btn.textContent = 'Subiendo…';
  try {
    const opts = { pieces: wz.pieces, mode: wz.mode, limit: wz.mode === 'classic' ? 0 : wz.limit, lobby: true };
    let image = null;
    if (!wz.same) { image = cropper.export(wz.pieces); if (!image) throw new Error('La foto es demasiado pesada. Prueba con otra.'); }
    if (wz.kind === 'create') {
      const password = $('roomPwIn').value.trim();
      const { code } = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ ...opts, ratio: wz.ratio, image, uid, password, name: $('roomNameIn').value, public: wz.isPublic, max: wz.max }) });
      if (password) ls.set(pwKey(code), password);
      $('mWizard').hidden = true; resetPhoto(); await enterRoom(code, { skipName: true });
    } else {
      await api(`/api/rooms/${game.room.code}/puzzle`, { method: 'POST', body: JSON.stringify({ ...opts, ratio: wz.ratio, image, sameImage: wz.same, uid, by: me.name }) });
      $('mWizard').hidden = true; resetPhoto();
    }
  } catch (err) { $('wzErr').textContent = err.message; $('wzErr').hidden = false; }
  finally { btn.textContent = label; btn.disabled = false; }
});
function resetPhoto() { cropper.reset(); $('file').value = ''; }

/* =========================================================================
   App instalable
   ========================================================================= */
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('btnInstall').hidden = false; });
window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; toast('¡Listo! Ya la tienes como app.'); });
if (isIOS && !isStandalone()) $('btnInstall').hidden = false;
$('btnInstall').onclick = async () => {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice.catch(() => null); if (r && r.outcome === 'accepted') $('btnInstall').hidden = true; installEvt = null; }
  else if (isIOS) $('mInstall').hidden = false;
};

/* =========================================================================
   Rutas
   ========================================================================= */
function route() {
  const code = (new URLSearchParams(location.search).get('sala') || '').toUpperCase();
  if (/^[A-Z0-9]{5}$/.test(code)) { if (!inGame || !game.room || game.room.code !== code) enterRoom(code); }
  else { if (inGame) { leaveCall(); game.stop(); } showLobby(); }
}
window.addEventListener('popstate', route);
window.matchMedia('(max-width: 700px)').addEventListener('change', () => { if (inGame) { renderPlayers(); badge(); renderModeBadge(); } });
route();
window.__rz = game;
