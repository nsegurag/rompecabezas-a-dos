import { W, H, PAD, THEMES, buildGeometry, buildSprites, isEdge, drawPieces, drawTable } from './geometry.js';

/**
 * Mesa de juego: dibujo en canvas, controles y sincronización con el servidor.
 * El servidor decide dónde queda cada grupo al soltarlo (encajes y piezas fijas),
 * así que los jugadores nunca se pisan los cambios.
 */
export function createGame({ canvas: cv, net, getProfile, ui }) {
  const ctx = cv.getContext('2d');
  const hitCtx = document.createElement('canvas').getContext('2d');
  const st = {
    you: null, pub: null, role: 'player', room: null, pz: null, key: null, groups: {}, holds: {}, remote: {}, pending: {},
    players: [], cursors: {}, geo: null, sprites: null, image: null, guide: false, edges: false, panMode: false,
    hover: null, flashes: {}, scores: {}, lastWorld: null, race: null, progress: {}, clockOffset: 0,
  };
  let view = { s: 200, tx: 0, ty: 0 }, fitS = 200, cw = 0, ch = 0, dpr = 1, userZoomed = false;
  let dirty = true, running = false, drag = null, pendingGrab = null, pan = null, pinch = null, spaceDown = false;
  const ptrs = new Map();
  let particles = [], lastCursorSent = 0, moveQueued = false;
  let theme = THEMES.ciruela;

  /* ---------------- sonido ---------------- */
  let audio = null;
  function unlockAudio() { if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { } } }
  function tone(f1, f2, dur, vol = 0.12, type = 'triangle') {
    try {
      if (!audio) return;
      const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + dur * 0.8);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch { }
  }
  function tick(high) { tone(high ? 1320 : 880, high ? 660 : 420, 0.1); try { navigator.vibrate && navigator.vibrate(high ? [12, 40, 12] : 10); } catch { } }

  /* ---------------- vista ---------------- */
  function resize() {
    const r = cv.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1); cw = r.width; ch = r.height;
    if (!cw || !ch) return;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    fitS = Math.min((cw - 24) / W, (ch - 24) / H);
    if (!userZoomed) fit(); dirty = true;
  }
  // En pantallas angostas y verticales (celular) se enfoca el marco: las piezas
  // se sacan de la bandeja. "Ver toda la mesa" muestra todo.
  function fit(whole) {
    const pz = st.pz, narrow = cw < 760 && ch > cw * 1.05;
    if (pz && narrow && whole !== true) {
      const s = Math.min((cw - 24) / (pz.PW * 1.08), (ch * 0.72) / (pz.PH * 1.08));
      view.s = Math.max(fitS, s);
      view.tx = cw / 2 - (pz.FX + pz.PW / 2) * view.s; view.ty = ch * 0.42 - (pz.FY + pz.PH / 2) * view.s; clampView();
    } else { view.s = fitS; view.tx = (cw - W * fitS) / 2; view.ty = (ch - H * fitS) / 2; }
    userZoomed = false; dirty = true;
  }
  function clampView() {
    const m = 60;
    view.tx = Math.min(cw - m, Math.max(m - W * view.s, view.tx));
    view.ty = Math.min(ch - m, Math.max(m - H * view.s, view.ty));
  }
  function maxZoom() { const pz = st.pz; const n = pz ? Math.max(pz.cols, pz.rows) : 6; return fitS * Math.max(6, n * 0.9); }
  function zoomAt(sx, sy, f) {
    const ns = Math.max(fitS * 0.6, Math.min(maxZoom(), view.s * f));
    const wx = (sx - view.tx) / view.s, wy = (sy - view.ty) / view.s;
    view.s = ns; view.tx = sx - wx * ns; view.ty = sy - wy * ns; clampView(); userZoomed = true; dirty = true;
  }
  function toWorld(e) { const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top; return { sx, sy, x: (sx - view.tx) / view.s, y: (sy - view.ty) / view.s }; }
  function toScreen(x, y) { const r = cv.getBoundingClientRect(); return { x: r.left + x * view.s + view.tx, y: r.top + y * view.s + view.ty }; }

  /* ---------------- estado ---------------- */
  const player = id => st.players.find(p => p.id === id);
  const now = () => Date.now() + st.clockOffset;
  const pieceW = () => st.pz.PW / st.pz.cols, pieceH = () => st.pz.PH / st.pz.rows;
  const myBoard = () => !st.pz || st.pz.mode !== 'race' || st.key === st.pub;
  function canPlay() {
    if (!st.pz || st.role === 'viewer' || !st.race) return false;
    return st.race.state === 'running' && myBoard() && !st.boardDone;
  }
  function whyNot() {
    if (st.role === 'viewer') return 'Estás como espectador: no puedes mover piezas.';
    if (!myBoard()) return 'Estás mirando el tablero de otra persona.';
    if (st.boardDone) return '¡Ya terminaste este rompecabezas!';
    const s = st.race && st.race.state;
    if (s === 'waiting') return 'La partida todavía no empieza.';
    if (s === 'countdown') return '¡Ya casi! Espera la cuenta regresiva.';
    if (s === 'timeout') return 'Se acabó el tiempo.';
    if (s === 'finished') return 'La partida terminó.';
    return 'Ahora no se pueden mover piezas.';
  }
  function posOf(gid) {
    const g = st.groups[gid];
    if (drag && drag.gid === gid) return { x: drag.x, y: drag.y };
    const rm = st.remote[gid]; if (rm && st.holds[gid] && st.holds[gid] !== st.you) return rm;
    const pd = st.pending[gid]; if (pd && performance.now() - pd.t < 4000) return pd;
    return { x: g.x, y: g.y };
  }
  function drawOrder() {
    const rank = id => {
      const g = st.groups[id];
      if (drag && drag.gid === id) return 4;
      if (st.holds[id] && st.holds[id] !== st.you) return 3;
      if (st.pending[id]) return 2;
      return g.locked ? 0 : 1;
    };
    return Object.keys(st.groups).sort((a, b) => rank(a) - rank(b) || st.groups[a].z - st.groups[b].z || st.groups[a].members.length - st.groups[b].members.length);
  }
  const hiddenByFilter = g => st.edges && !g.locked && g.members.length === 1 && !isEdge(g.members[0], st.pz.cols, st.pz.rows);
  function stats() {
    if (!st.pz) return null;
    const N = st.pz.cols * st.pz.rows, ids = Object.keys(st.groups);
    let placed = 0; for (const k of ids) if (st.groups[k].locked) placed += st.groups[k].members.length;
    return { total: N, placed, progress: ids.length ? Math.round(((N - ids.length) / Math.max(1, N - 1)) * 100) : 0 };
  }
  function pushHud() {
    const s = stats(); if (!s) return;
    const race = st.race || {}, pz = st.pz, t = now();
    let elapsed = 0, remaining = null;
    const start = race.startAt || pz.createdAt;
    const end = st.boardDone || race.endAt || pz.doneAt;
    if (race.state === 'running' || race.state === 'timeout' || race.state === 'finished') elapsed = (end || t) - start;
    if (pz.limit && pz.mode !== 'classic' && start && race.state !== 'waiting') remaining = Math.max(0, start + pz.limit - (end || t));
    ui.onHud({ ...s, elapsed, remaining, state: race.state, mode: pz.mode, done: !!(st.boardDone || pz.doneAt) });
  }

  function setBoard(b) {
    st.key = b.key; st.groups = b.groups || {}; st.boardDone = b.doneAt || null;
    st.holds = {}; st.remote = {}; st.pending = {}; st.cursors = {};
    for (const [gid, by] of b.holds || []) st.holds[gid] = by;
    drag = null; pendingGrab = null; dirty = true;
    pushHud(); ui.onGroups(); ui.onBoard(st.key);
  }
  function setPuzzle(p, board) {
    const same = st.pz && st.pz.id === p.id;
    st.pz = { ...p };
    st.scores = p.scores || {};
    if (!same) {
      st.sprites = null; st.image = null; st.geo = buildGeometry(p.cols, p.rows, p.seed); particles = [];
      const im = new Image(); const id = p.id;
      im.onload = () => {
        if (!st.pz || st.pz.id !== id) return;
        st.image = im;
        // Con 500 piezas preparar los sprites tarda un momento: primero se muestra el aviso.
        ui.onLoading(true);
        setTimeout(() => { if (!st.pz || st.pz.id !== id) return; st.sprites = buildSprites(im, st.geo); ui.onLoading(false); dirty = true; ui.onImage(im.src); ui.onGroups(); }, 30);
      };
      im.onerror = () => ui.onToast('No se pudo cargar la foto del rompecabezas.');
      im.src = p.img;
      userZoomed = false; resize();
    }
    if (board) setBoard(board);
    ui.onPuzzle(st.pz); ui.onScores(st.scores);
  }
  function setRace(race, progress, serverNow) {
    if (serverNow) st.clockOffset = serverNow - Date.now();
    const prev = st.race && st.race.state;
    st.race = race; if (progress) st.progress = progress;
    if (race.state === 'countdown' && prev !== 'countdown') countdownSounds(race.startAt);
    if (race.state === 'running' && prev === 'countdown') tone(660, 1320, 0.25, 0.14);
    pushHud(); ui.onRace(st.race, st.progress); dirty = true;
  }
  function countdownSounds(startAt) {
    for (const k of [3, 2, 1]) { const at = startAt - k * 1000 - now(); if (at > -200) setTimeout(() => tone(520, 520, 0.12, 0.1, 'sine'), Math.max(0, at)); }
  }
  function myRole() { const me = st.players.find(p => p.id === st.you); return me ? me.role : st.role; }

  /* ---------------- mensajes del servidor ---------------- */
  net.on('welcome', m => {
    st.you = m.you; st.pub = m.pub; st.room = m.room; st.players = m.players; st.role = myRole();
    setRace(m.race, m.progress, m.now);
    setPuzzle(m.puzzle, m.board);
    ui.onRoom(m.room); ui.onPlayers(st.players, st.you); ui.onChatHistory(m.chat || []);
  });
  net.on('puzzle', m => { setRace(m.race, m.progress, m.now); setPuzzle(m.puzzle, m.board); ui.onNewPuzzle(m.by); });
  net.on('board', m => setBoard(m.board));
  net.on('race', m => setRace(m.race, m.progress, m.now));
  net.on('progress', m => { st.progress = m.progress; ui.onRace(st.race, st.progress); });
  net.on('mode', m => { if (st.pz) { st.pz.mode = m.mode; st.pz.limit = m.limit; ui.onPuzzle(st.pz); pushHud(); } });
  net.on('room', m => { st.room = m.room; ui.onRoom(m.room); });
  net.on('notice', m => ui.onToast(m.text));
  net.on('kicked', m => ui.onExpelled(m.reason === 'ban' ? 'El administrador te bloqueó de esta sala.' : 'El administrador te sacó de la sala.'));
  net.on('closed', () => ui.onExpelled('El dueño cerró la sala.'));
  net.on('react', m => { ui.onReact(m, m.board === st.key ? toScreen(m.x, m.y) : null, player(m.id)); });
  net.on('players', m => {
    st.players = m.players; st.role = myRole();
    if (st.role === 'viewer' && drag) drag = null;
    for (const id of Object.keys(st.cursors)) if (!player(id)) delete st.cursors[id];
    ui.onPlayers(st.players, st.you); dirty = true;
  });
  net.on('grab', m => {
    st.holds[m.gid] = m.by;
    if (m.by !== st.you && drag && drag.gid === m.gid) { drag = null; ui.onToast('Alguien tomó esa pieza primero.'); }
    dirty = true;
  });
  net.on('deny', m => {
    if (drag && drag.gid === m.gid) drag = null;
    if (st.holds[m.gid] === st.you) delete st.holds[m.gid];
    const g = st.groups[m.gid];
    ui.onToast(m.reason === 'locked' || (g && g.locked) ? 'Esa pieza ya está en su lugar.' : m.reason === 'held' ? 'Otra persona está moviendo esa pieza.' : whyNot());
    dirty = true;
  });
  net.on('move', m => { st.remote[m.gid] = { x: m.x, y: m.y }; dirty = true; });
  net.on('release', m => { delete st.holds[m.gid]; delete st.remote[m.gid]; delete st.pending[m.gid]; dirty = true; });
  net.on('update', m => {
    for (const gid of m.del || []) { delete st.groups[gid]; delete st.holds[gid]; delete st.remote[gid]; delete st.pending[gid]; }
    for (const [gid, g] of Object.entries(m.set || {})) { st.groups[gid] = g; delete st.remote[gid]; delete st.pending[gid]; if (m.gid === gid || m.arranged) delete st.holds[gid]; if (m.locked && m.gid) st.flashes[gid] = performance.now(); }
    if (m.gid) { delete st.holds[m.gid]; delete st.pending[m.gid]; delete st.remote[m.gid]; }
    if (m.by === st.you && (m.merged || m.locked)) tick(m.locked);
    if (m.score) { const { pub, ...sc } = m.score; st.scores[pub] = sc; ui.onScores(st.scores); }
    if (Object.keys(st.groups).length === 1 && st.pz && st.pz.mode === 'race' && !st.boardDone) { st.boardDone = now(); if (st.key === st.pub) burst(); }
    dirty = true; pushHud(); ui.onGroups();
  });
  net.on('done', m => { if (st.pz) { st.pz.doneAt = m.doneAt; st.boardDone = m.doneAt; if (m.scores) st.scores = m.scores; pushHud(); burst(); ui.onDone(m.doneAt - (st.race && st.race.startAt || st.pz.createdAt), st.scores); } });
  net.on('cursor', m => { if (m.x == null) delete st.cursors[m.id]; else st.cursors[m.id] = { x: m.x, y: m.y }; dirty = true; });
  net.on('status', s => { if (s === 'closed') { drag = null; pendingGrab = null; } ui.onStatus(s); });

  /* ---------------- dibujo ---------------- */
  function draw() {
    dirty = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
    const px = 1 / view.s, pz = st.pz;
    drawTable(ctx, pz, theme, px, dpr, st.guide && st.image);
    // En la carrera las piezas se muestran cuando empieza (así nadie estudia la foto antes).
    const hidePieces = pz && pz.mode === 'race' && st.race && (st.race.state === 'waiting' || st.race.state === 'countdown');
    if (pz && st.sprites && !hidePieces) {
      const t = performance.now(), pw = pieceW(), ph = pieceH();
      drawPieces(ctx, pz, st.geo, st.sprites, st.groups, drawOrder(), posOf, {
        lifted: gid => (drag && drag.gid === gid) || (st.holds[gid] && st.holds[gid] !== st.you),
        dim: hiddenByFilter,
        after: (gid, g, p, dx, dy) => {
          const holder = st.holds[gid] && st.holds[gid] !== st.you ? player(st.holds[gid]) : null;
          const fl = st.flashes[gid]; const flashA = fl ? Math.max(0, 1 - (t - fl) / 900) : 0;
          if (!flashA && fl) delete st.flashes[gid];
          const outline = holder ? holder.color : (flashA ? `rgba(242,177,52,${flashA})` : (st.hover === gid && !drag ? 'rgba(255,255,255,.6)' : null));
          if (!outline) return;
          ctx.save(); ctx.translate(p.x - dx, p.y - dy); ctx.scale(pw, ph);
          ctx.lineWidth = (holder ? 3 : flashA ? 4 : 1.5) * px / Math.min(pw, ph); ctx.strokeStyle = outline;
          for (const i of g.members) ctx.stroke(st.geo.paths[i]);
          ctx.restore();
          if (flashA) dirty = true;
        },
      });
    }
    // Terminado: se muestra la foto limpia, sin líneas de corte.
    if (pz && st.image && Object.keys(st.groups).length === 1 && Object.values(st.groups)[0].locked) {
      ctx.drawImage(st.image, pz.FX, pz.FY, pz.PW, pz.PH);
      ctx.lineWidth = 2 * px; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.strokeRect(pz.FX, pz.FY, pz.PW, pz.PH);
    }
    // Cursores de los demás
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '700 12px "Atkinson Hyperlegible", system-ui, sans-serif';
    for (const [id, c] of Object.entries(st.cursors)) {
      const pl = player(id); if (!pl || id === st.you) continue;
      const sx = c.x * view.s + view.tx, sy = c.y * view.s + view.ty;
      ctx.fillStyle = pl.color; ctx.strokeStyle = '#1a1320'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 4, sy + 15); ctx.lineTo(sx + 7.5, sy + 9.5); ctx.lineTo(sx + 14, sy + 9); ctx.closePath(); ctx.fill(); ctx.stroke();
      const tw = ctx.measureText(pl.name).width;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(sx + 12, sy + 14, tw + 12, 20, 6); else ctx.rect(sx + 12, sy + 14, tw + 12, 20); ctx.fill();
      ctx.fillStyle = '#1a1320'; ctx.fillText(pl.name, sx + 18, sy + 28);
    }
    if (particles.length) {
      for (const q of particles) {
        q.vy += 0.18; q.x += q.vx; q.y += q.vy; q.a += q.va; q.life -= 1;
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.a); ctx.fillStyle = q.c; ctx.fillRect(-4, -2.5, 8, 5); ctx.restore();
      }
      particles = particles.filter(q => q.life > 0 && q.y < ch + 20);
      dirty = true;
    }
  }
  function burst() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cols = ['#f2b134', '#5ec8e5', '#ff7a8a', '#8be07a', '#c59bff', '#ffffff'];
    for (let i = 0; i < 160; i++) particles.push({ x: cw / 2 + (Math.random() - 0.5) * 200, y: ch * 0.35, vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 10 - 3, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4, c: cols[i % cols.length], life: 150 + Math.random() * 60 });
    tone(523, 1046, 0.35, 0.12); setTimeout(() => tone(659, 1318, 0.35, 0.1), 140); setTimeout(() => tone(784, 1568, 0.5, 0.1), 280);
    dirty = true;
  }
  function loop() {
    if (!running) return;
    if (moveQueued && drag) net.send({ t: 'move', gid: drag.gid, x: +drag.x.toFixed(5), y: +drag.y.toFixed(5) });
    moveQueued = false;
    if (dirty) draw();
    requestAnimationFrame(loop);
  }

  /* ---------------- detección de piezas ---------------- */
  function hitExact(wx, wy) {
    const { cols } = st.pz, pw = pieceW(), ph = pieceH(), ord = drawOrder();
    for (let k = ord.length - 1; k >= 0; k--) {
      const gid = ord[k], g = st.groups[gid];
      if (hiddenByFilter(g)) continue;
      const p = posOf(gid), gx = (wx - p.x) / pw, gy = (wy - p.y) / ph;
      for (let m = g.members.length - 1; m >= 0; m--) {
        const i = g.members[m], r = Math.floor(i / cols), c = i % cols;
        if (gx < c - PAD || gx > c + 1 + PAD || gy < r - PAD || gy > r + 1 + PAD) continue;
        if (hitCtx.isPointInPath(st.geo.paths[i], gx, gy)) return gid;
      }
    }
    return null;
  }
  // Tolerante: si el clic cae justo fuera del borde, busca la pieza más cercana.
  function hitTest(wx, wy, touch) {
    if (!st.pz || !st.geo || !st.sprites) return null;
    let gid = hitExact(wx, wy);
    if (gid) return gid;
    const rad = (touch ? 14 : 8) / view.s;
    for (const f of [0.5, 1]) for (let a = 0; a < 8; a++) {
      gid = hitExact(wx + Math.cos(a * Math.PI / 4) * rad * f, wy + Math.sin(a * Math.PI / 4) * rad * f);
      if (gid) return gid;
    }
    return null;
  }

  /* ---------------- controles ---------------- */
  function setCursor() {
    cv.style.cursor = pan || drag ? 'grabbing' : (st.panMode || spaceDown) ? 'grab' : st.hover ? 'pointer' : 'default';
  }
  function startPinch() {
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2, s: view.s, tx: view.tx, ty: view.ty };
  }
  function startDrag(pg) {
    const g = st.groups[pg.gid]; if (!g || g.locked) return;
    if (!net.send({ t: 'grab', gid: pg.gid, pid: st.pz.id })) { ui.onToast('Sin conexión. Reconectando…'); return; }
    const p = posOf(pg.gid);
    drag = { gid: pg.gid, dx: pg.dx, dy: pg.dy, x: p.x, y: p.y, id: pg.id };
    st.holds[pg.gid] = st.you; st.hover = null;
  }
  function moveDrag(w) {
    const g = st.groups[drag.gid]; if (!g) { drag = null; return; }
    const { cols } = st.pz, pw = pieceW(), ph = pieceH();
    let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1;
    for (const i of g.members) { const r = Math.floor(i / cols), c = i % cols; minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
    drag.x = Math.max(-minC * pw - 0.02, Math.min(W - (maxC + 1) * pw + 0.02, w.x - drag.dx));
    drag.y = Math.max(-minR * ph - 0.02, Math.min(H - (maxR + 1) * ph + 0.02, w.y - drag.dy));
    moveQueued = true; dirty = true;
  }
  function finishDrag() {
    const d = drag; drag = null;
    if (net.send({ t: 'drop', gid: d.gid, x: +d.x.toFixed(5), y: +d.y.toFixed(5) })) st.pending[d.gid] = { x: d.x, y: d.y, t: performance.now() };
    else { delete st.holds[d.gid]; ui.onToast('Sin conexión: la pieza volvió a su lugar.'); }
    dirty = true;
  }

  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    unlockAudio();
    if (!st.pz) return;
    cv.setPointerCapture(e.pointerId);
    const w = toWorld(e); ptrs.set(e.pointerId, w);
    if (ptrs.size >= 2) { pendingGrab = null; if (!drag) { pan = null; startPinch(); } return; }
    const wantsPan = e.button === 1 || e.button === 2 || spaceDown || st.panMode;
    if (wantsPan) { pan = { sx: w.sx, sy: w.sy, tx: view.tx, ty: view.ty, id: e.pointerId }; setCursor(); return; }
    if (e.button !== 0) return;
    const gid = hitTest(w.x, w.y, e.pointerType !== 'mouse');
    if (!gid) return; // clic en la mesa vacía: no pasa nada
    const g = st.groups[gid];
    if (g.locked) { st.flashes[gid] = performance.now(); dirty = true; return; }
    if (!canPlay()) { ui.onToast(whyNot()); return; }
    if (st.holds[gid] && st.holds[gid] !== st.you) { const pl = player(st.holds[gid]); ui.onToast(`${pl ? pl.name : 'Alguien'} está moviendo esa pieza.`); return; }
    const p = posOf(gid);
    pendingGrab = { gid, id: e.pointerId, sx: w.sx, sy: w.sy, dx: w.x - p.x, dy: w.y - p.y };
  });
  cv.addEventListener('pointermove', e => {
    const w = toWorld(e);
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, w);
    const t = performance.now();
    st.lastWorld = { x: w.x, y: w.y, t };
    if (t - lastCursorSent > 40) { lastCursorSent = t; net.send({ t: 'cursor', x: +w.x.toFixed(4), y: +w.y.toFixed(4) }); }
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
      const ns = Math.max(fitS * 0.6, Math.min(maxZoom(), pinch.s * d / pinch.d));
      const wx = (pinch.mx - pinch.tx) / pinch.s, wy = (pinch.my - pinch.ty) / pinch.s;
      view.s = ns; view.tx = mx - wx * ns; view.ty = my - wy * ns; clampView(); userZoomed = true; dirty = true; return;
    }
    if (pendingGrab && e.pointerId === pendingGrab.id) {
      if (Math.hypot(w.sx - pendingGrab.sx, w.sy - pendingGrab.sy) > 3) { const pg = pendingGrab; pendingGrab = null; startDrag(pg); setCursor(); }
      else return;
    }
    if (drag && e.pointerId === drag.id) { moveDrag(w); return; }
    if (pan && e.pointerId === pan.id) { view.tx = pan.tx + (w.sx - pan.sx); view.ty = pan.ty + (w.sy - pan.sy); clampView(); userZoomed = true; dirty = true; return; }
    if (e.pointerType === 'mouse' && st.pz) { const h = hitTest(w.x, w.y, false); const hv = h && !st.groups[h].locked && canPlay() ? h : null; if (hv !== st.hover) { st.hover = hv; dirty = true; setCursor(); } }
  });
  function endPtr(e) {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (pendingGrab && pendingGrab.id === e.pointerId) pendingGrab = null;
    if (drag && e.pointerId === drag.id) finishDrag();
    if (pan && e.pointerId === pan.id) pan = null;
    setCursor();
  }
  cv.addEventListener('pointerup', endPtr);
  cv.addEventListener('pointercancel', endPtr);
  cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { net.send({ t: 'cursor', x: null, y: null }); if (st.hover) { st.hover = null; dirty = true; } } });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const w = toWorld(e);
    // Rueda del ratón o pellizco del trackpad = zoom; dos dedos en trackpad = mover la mesa.
    const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
    if (e.ctrlKey || (mouseWheel && !e.shiftKey)) zoomAt(w.sx, w.sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    else { view.tx -= e.shiftKey ? e.deltaY : e.deltaX; view.ty -= e.shiftKey ? 0 : e.deltaY; clampView(); userZoomed = true; dirty = true; }
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (!running || e.target.closest('input,textarea')) return;
    if (e.code === 'Space') { spaceDown = true; setCursor(); e.preventDefault(); }
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; setCursor(); } });
  window.addEventListener('resize', () => running && resize());
  if (window.ResizeObserver) new ResizeObserver(() => running && resize()).observe(cv);

  /* ---------------- API pública ---------------- */
  return {
    start(code) {
      running = true; st.pz = null; st.groups = {}; st.sprites = null; st.image = null; st.players = []; st.cursors = {}; st.race = null; st.progress = {};
      resize(); requestAnimationFrame(loop);
      net.close(); net.connect(code, getProfile());
    },
    stop() { running = false; net.close(); st.pz = null; },
    resize, fit: () => fit(true), focus: () => fit(),
    zoomIn() { zoomAt(cw / 2, ch / 2, 1.35); },
    zoomOut() { zoomAt(cw / 2, ch / 2, 1 / 1.35); },
    toggleGuide() { st.guide = !st.guide; dirty = true; return st.guide; },
    toggleEdges() { st.edges = !st.edges; dirty = true; return st.edges; },
    togglePan() { st.panMode = !st.panMode; setCursor(); return st.panMode; },
    setTheme(name) { theme = THEMES[name] || THEMES.ciruela; cv.parentElement.style.background = theme.page; dirty = true; },
    arrange() { if (!canPlay()) { ui.onToast(whyNot()); return; } if (!net.send({ t: 'arrange' })) ui.onToast('Sin conexión.'); },
    chat(text) { return net.send({ t: 'chat', text }); },
    profile(p) { net.send({ t: 'profile', ...p }); },
    control(t) { if (!net.send({ t })) ui.onToast('Sin conexión.'); },
    watch(pub) { net.send({ t: 'watch', board: pub }); },
    react(e) {
      const lw = st.lastWorld && performance.now() - st.lastWorld.t < 8000 ? st.lastWorld : { x: (cw / 2 - view.tx) / view.s, y: (ch / 2 - view.ty) / view.s };
      const x = Math.max(0, Math.min(W, lw.x)), y = Math.max(0, Math.min(H, lw.y));
      if (!net.send({ t: 'react', e, x: +x.toFixed(4), y: +y.toFixed(4) })) ui.onToast('Sin conexión.');
    },
    admin(a, extra = {}) { if (!net.send({ t: 'admin', a, ...extra })) ui.onToast('Sin conexión.'); },
    /** Piezas para la bandeja: las que nadie ha movido todavía, bordes primero. */
    loosePieces() {
      if (!st.pz || !st.sprites) return [];
      const { cols, rows } = st.pz, out = [];
      for (const [gid, g] of Object.entries(st.groups)) {
        if (g.locked || g.members.length !== 1 || g.z !== 0) continue;
        if (st.holds[gid] && st.holds[gid] !== st.you) continue;
        if (drag && drag.gid === gid) continue;
        const i = g.members[0], edge = isEdge(i, cols, rows);
        if (st.edges && !edge) continue;
        out.push({ gid, i, edge });
      }
      return out.sort((a, b) => (b.edge - a.edge) || a.i - b.i);
    },
    sprite(i) { return st.sprites ? st.sprites[i].img : null; },
    externalStart(gid, e) {
      const g = st.groups[gid]; if (!g || g.locked || !st.pz) return false;
      if (!canPlay()) { ui.onToast(whyNot()); return false; }
      if (st.holds[gid] && st.holds[gid] !== st.you) return false;
      if (!net.send({ t: 'grab', gid, pid: st.pz.id })) { ui.onToast('Sin conexión.'); return false; }
      unlockAudio();
      const { cols } = st.pz, i = g.members[0], r = Math.floor(i / cols), c = i % cols;
      drag = { gid, dx: (c + 0.5) * pieceW(), dy: (r + 0.5) * pieceH(), x: g.x, y: g.y, id: e.pointerId, ext: true };
      st.holds[gid] = st.you; moveDrag(toWorld(e)); setCursor();
      return true;
    },
    externalMove(e) { if (drag && drag.ext && drag.id === e.pointerId) { st.lastWorld = { ...toWorld(e), t: performance.now() }; moveDrag(toWorld(e)); } },
    externalEnd(e) { if (drag && drag.ext && drag.id === e.pointerId) { finishDrag(); setCursor(); } },
    unlockAudio,
    get role() { return st.role; },
    get pub() { return st.pub; },
    get players() { return st.players; },
    get scores() { return st.scores; },
    get room() { return st.room; },
    get you() { return st.you; },
    get puzzle() { return st.pz; },
    get race() { return st.race; },
    get progress() { return st.progress; },
    get boardKey() { return st.key; },
    get boardDone() { return st.boardDone; },
    get canPlay() { return canPlay(); },
    get assets() { return { pz: st.pz, geo: st.geo, sprites: st.sprites, image: st.image, theme }; },
    serverNow: now,
    hud: pushHud,
    // Ayuda para pruebas automáticas: posición en pantalla del centro de una pieza.
    _debug(i, target) {
      if (!st.pz) return null; const { cols } = st.pz, r = Math.floor(i / cols), c = i % cols;
      const gid = Object.keys(st.groups).find(k => st.groups[k].members.includes(i)); if (!gid) return null;
      const p = target ? { x: st.pz.FX, y: st.pz.FY } : posOf(gid);
      const s = toScreen(p.x + (c + 0.5) * pieceW(), p.y + (r + 0.5) * pieceH());
      return { gid, locked: st.groups[gid].locked, x: s.x, y: s.y, ready: !!st.sprites };
    },
  };
}
