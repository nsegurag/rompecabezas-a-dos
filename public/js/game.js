import { W, H, FX, FY, PAD, buildGeometry, buildSprites, isEdge } from './geometry.js';

/**
 * Mesa de juego: dibujo en canvas, controles y sincronización con el servidor.
 * El servidor decide dónde queda cada grupo al soltarlo (encajes y fijado),
 * así que dos jugadores nunca se pisan los cambios.
 */
export function createGame({ canvas: cv, net, getProfile, ui }) {
  const ctx = cv.getContext('2d');
  const hitCtx = document.createElement('canvas').getContext('2d');
  const st = {
    you: null, room: null, pz: null, groups: {}, holds: {}, remote: {}, pending: {}, players: [], cursors: {},
    geo: null, sprites: null, image: null, guide: false, edges: false, panMode: false, hover: null, flashes: {},
  };
  let view = { s: 200, tx: 0, ty: 0 }, fitS = 200, cw = 0, ch = 0, dpr = 1, userZoomed = false;
  let dirty = true, running = false, drag = null, pendingGrab = null, pan = null, pinch = null, spaceDown = false;
  const ptrs = new Map();
  let particles = [];
  let lastCursorSent = 0, moveQueued = false;

  /* ---------------- fondo de fieltro ---------------- */
  const felt = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d');
    let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 900; i++) { x.fillStyle = r() < 0.5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.08)'; x.fillRect(r() * 96, r() * 96, 1, 1); }
    return ctx.createPattern(c, 'repeat');
  })();

  /* ---------------- sonido ---------------- */
  let audio = null;
  function unlockAudio() { if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { } } }
  function tick(high) {
    try {
      if (!audio) return;
      const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(high ? 1320 : 880, t); o.frequency.exponentialRampToValueAtTime(high ? 660 : 420, t + 0.08);
      g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.12);
    } catch { }
    try { navigator.vibrate && navigator.vibrate(high ? [12, 40, 12] : 10); } catch { }
  }

  /* ---------------- vista ---------------- */
  function resize() {
    const r = cv.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1); cw = r.width; ch = r.height;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    fitS = Math.min((cw - 24) / W, (ch - 24) / H);
    if (!userZoomed) fit(); dirty = true;
  }
  function fit() { view.s = fitS; view.tx = (cw - W * fitS) / 2; view.ty = (ch - H * fitS) / 2; userZoomed = false; dirty = true; }
  function clampView() {
    const m = 60; // no dejes que la mesa se pierda de la pantalla
    view.tx = Math.min(cw - m, Math.max(m - W * view.s, view.tx));
    view.ty = Math.min(ch - m, Math.max(m - H * view.s, view.ty));
  }
  function zoomAt(sx, sy, f) {
    const ns = Math.max(fitS * 0.6, Math.min(fitS * 10, view.s * f));
    const wx = (sx - view.tx) / view.s, wy = (sy - view.ty) / view.s;
    view.s = ns; view.tx = sx - wx * ns; view.ty = sy - wy * ns; clampView(); userZoomed = true; dirty = true;
  }
  function toWorld(e) { const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top; return { sx, sy, x: (sx - view.tx) / view.s, y: (sy - view.ty) / view.s }; }

  /* ---------------- estado de grupos ---------------- */
  const player = id => st.players.find(p => p.id === id);
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
  const hiddenByFilter = g => st.edges && !g.locked && g.members.length === 1 && !isEdge(g.members[0], st.pz.n);
  function stats() {
    if (!st.pz) return null;
    const N = st.pz.n * st.pz.n, ids = Object.keys(st.groups);
    let placed = 0; for (const k of ids) if (st.groups[k].locked) placed += st.groups[k].members.length;
    return { total: N, placed, progress: Math.round(((N - ids.length) / Math.max(1, N - 1)) * 100) };
  }
  function pushHud() {
    const s = stats(); if (!s) return;
    const end = st.pz.doneAt || Date.now();
    ui.onHud({ ...s, ms: end - st.pz.createdAt, done: !!st.pz.doneAt });
  }

  function setPuzzle(p) {
    const same = st.pz && st.pz.id === p.id;
    st.pz = { id: p.id, n: p.n, seed: p.seed, img: p.img, createdAt: p.createdAt, doneAt: p.doneAt };
    st.groups = p.groups; st.pending = {}; st.remote = {};
    drag = null; pendingGrab = null;
    if (!same) {
      st.sprites = null; st.image = null; st.geo = buildGeometry(p.n, p.seed); particles = [];
      const im = new Image(); const id = p.id;
      im.onload = () => { if (!st.pz || st.pz.id !== id) return; st.image = im; st.sprites = buildSprites(im, p.n, st.geo); dirty = true; ui.onImage(im.src); };
      im.onerror = () => ui.onToast('No se pudo cargar la foto del rompecabezas.');
      im.src = p.img;
      userZoomed = false; resize();
    }
    dirty = true; pushHud();
  }

  /* ---------------- mensajes del servidor ---------------- */
  net.on('welcome', m => {
    st.you = m.you; st.room = m.room; st.players = m.players; st.holds = {}; st.cursors = {};
    for (const [gid, by] of m.holds) st.holds[gid] = by;
    setPuzzle(m.puzzle); ui.onRoom(m.room); ui.onPlayers(st.players, st.you); ui.onChatHistory(m.chat || []);
  });
  net.on('puzzle', m => { setPuzzle(m.puzzle); st.holds = {}; ui.onNewPuzzle(m.by); });
  net.on('players', m => {
    st.players = m.players;
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
    ui.onToast(g && g.locked ? 'Esa pieza ya está en su lugar.' : 'Otra persona está moviendo esa pieza.');
    dirty = true;
  });
  net.on('move', m => { st.remote[m.gid] = { x: m.x, y: m.y }; dirty = true; });
  net.on('release', m => { delete st.holds[m.gid]; delete st.remote[m.gid]; delete st.pending[m.gid]; dirty = true; });
  net.on('update', m => {
    for (const gid of m.del || []) { delete st.groups[gid]; delete st.holds[gid]; delete st.remote[gid]; delete st.pending[gid]; }
    for (const [gid, g] of Object.entries(m.set || {})) { st.groups[gid] = g; delete st.remote[gid]; delete st.pending[gid]; if (m.gid === gid || m.arranged) delete st.holds[gid]; if (m.locked && m.gid) st.flashes[gid] = performance.now(); }
    if (m.gid) { delete st.holds[m.gid]; delete st.pending[m.gid]; delete st.remote[m.gid]; }
    if (m.by === st.you && (m.merged || m.locked)) tick(m.locked);
    dirty = true; pushHud();
  });
  net.on('done', m => { if (st.pz) { st.pz.doneAt = m.doneAt; pushHud(); burst(); ui.onDone(m.doneAt - st.pz.createdAt); } });
  net.on('cursor', m => { if (m.x == null) delete st.cursors[m.id]; else st.cursors[m.id] = { x: m.x, y: m.y }; dirty = true; });
  net.on('status', s => { if (s === 'closed') { drag = null; pendingGrab = null; } ui.onStatus(s); });

  /* ---------------- dibujo ---------------- */
  function draw() {
    dirty = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
    const px = 1 / view.s;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 24 * dpr; ctx.fillStyle = '#3a2e44';
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(0, 0, W, H, 0.03); else ctx.rect(0, 0, W, H); ctx.fill(); ctx.restore();
    ctx.save(); ctx.clip(); ctx.scale(px, px); ctx.fillStyle = felt; ctx.fillRect(0, 0, W * view.s, H * view.s); ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(FX, FY, 1, 1);
    if (st.guide && st.image) { ctx.globalAlpha = 0.22; ctx.drawImage(st.image, FX, FY, 1, 1); ctx.globalAlpha = 1; }
    ctx.setLineDash([6 * px, 5 * px]); ctx.lineWidth = 1.2 * px; ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.strokeRect(FX, FY, 1, 1); ctx.setLineDash([]);

    if (st.pz && st.sprites) {
      const n = st.pz.n, sz = (1 + 2 * PAD) / n, now = performance.now();
      for (const gid of drawOrder()) {
        const g = st.groups[gid], p = posOf(gid);
        const lifted = (drag && drag.gid === gid) || (st.holds[gid] && st.holds[gid] !== st.you);
        const dx = lifted ? 0.004 : 0, dy = lifted ? 0.008 : 0;
        const dim = hiddenByFilter(g);
        if (dim) ctx.globalAlpha = 0.16;
        if (!g.locked) for (const i of g.members) { const r = Math.floor(i / n), c = i % n; ctx.drawImage(st.sprites[i].sh, p.x + (c - PAD) / n + dx, p.y + (r - PAD) / n + dy, sz, sz); }
        for (const i of g.members) { const r = Math.floor(i / n), c = i % n; ctx.drawImage(st.sprites[i].img, p.x + (c - PAD) / n - dx, p.y + (r - PAD) / n - dy, sz, sz); }
        ctx.globalAlpha = 1;
        const holder = st.holds[gid] && st.holds[gid] !== st.you ? player(st.holds[gid]) : null;
        const fl = st.flashes[gid]; const flashA = fl ? Math.max(0, 1 - (now - fl) / 900) : 0;
        if (!flashA && fl) delete st.flashes[gid];
        const outline = holder ? holder.color : (flashA ? `rgba(242,177,52,${flashA})` : (st.hover === gid && !drag ? 'rgba(255,255,255,.55)' : null));
        if (outline) {
          ctx.save(); ctx.translate(p.x - dx, p.y - dy); ctx.scale(1 / n, 1 / n);
          ctx.lineWidth = (holder ? 3 : flashA ? 4 : 1.5) * px * n; ctx.strokeStyle = outline;
          for (const i of g.members) ctx.stroke(st.geo.paths[i]);
          ctx.restore();
          if (flashA) dirty = true;
        }
      }
    }

    // cursores de los demás
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
    // confeti
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
    dirty = true;
  }
  function loop() {
    if (!running) return;
    if (moveQueued && drag) { net.send({ t: 'move', gid: drag.gid, x: +drag.x.toFixed(5), y: +drag.y.toFixed(5) }); }
    moveQueued = false;
    if (dirty) draw();
    requestAnimationFrame(loop);
  }

  /* ---------------- detección de piezas ---------------- */
  function hitExact(wx, wy) {
    const n = st.pz.n, ord = drawOrder();
    for (let k = ord.length - 1; k >= 0; k--) {
      const gid = ord[k], g = st.groups[gid];
      if (hiddenByFilter(g)) continue;
      const p = posOf(gid), gx = (wx - p.x) * n, gy = (wy - p.y) * n;
      for (let m = g.members.length - 1; m >= 0; m--) {
        const i = g.members[m], r = Math.floor(i / n), c = i % n;
        if (gx < c - PAD || gx > c + 1 + PAD || gy < r - PAD || gy > r + 1 + PAD) continue;
        if (hitCtx.isPointInPath(st.geo.paths[i], gx, gy)) return gid;
      }
    }
    return null;
  }
  // Tolerante: si el clic cae justo fuera del borde, busca la pieza más cercana (8 px).
  function hitTest(wx, wy, touch) {
    if (!st.pz || !st.geo) return null;
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
    const n = st.pz.n;
    let minC = n, maxC = 0, minR = n, maxR = 0;
    for (const i of g.members) { const r = Math.floor(i / n), c = i % n; minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
    drag.x = Math.max(-minC / n - 0.02, Math.min(W - (maxC + 1) / n + 0.02, w.x - drag.dx));
    drag.y = Math.max(-minR / n - 0.02, Math.min(H - (maxR + 1) / n + 0.02, w.y - drag.dy));
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
    if (ptrs.size >= 2) {
      pendingGrab = null;
      if (!drag) { pan = null; startPinch(); }
      return;
    }
    const wantsPan = e.button === 1 || e.button === 2 || spaceDown || st.panMode;
    if (wantsPan) { pan = { sx: w.sx, sy: w.sy, tx: view.tx, ty: view.ty, id: e.pointerId }; setCursor(); return; }
    if (e.button !== 0) return;
    const gid = hitTest(w.x, w.y, e.pointerType !== 'mouse');
    if (!gid) return; // clic en la mesa vacía: no pasa nada (la mesa ya no se mueve sola)
    const g = st.groups[gid];
    if (g.locked) { st.flashes[gid] = performance.now(); dirty = true; return; }
    if (st.holds[gid] && st.holds[gid] !== st.you) { const pl = player(st.holds[gid]); ui.onToast(`${pl ? pl.name : 'Alguien'} está moviendo esa pieza.`); return; }
    const p = posOf(gid);
    pendingGrab = { gid, id: e.pointerId, sx: w.sx, sy: w.sy, dx: w.x - p.x, dy: w.y - p.y };
  });
  cv.addEventListener('pointermove', e => {
    const w = toWorld(e);
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, w);
    const now = performance.now();
    if (now - lastCursorSent > 40) { lastCursorSent = now; net.send({ t: 'cursor', x: +w.x.toFixed(4), y: +w.y.toFixed(4) }); }
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
      const ns = Math.max(fitS * 0.6, Math.min(fitS * 10, pinch.s * d / pinch.d));
      const wx = (pinch.mx - pinch.tx) / pinch.s, wy = (pinch.my - pinch.ty) / pinch.s;
      view.s = ns; view.tx = mx - wx * ns; view.ty = my - wy * ns; clampView(); userZoomed = true; dirty = true; return;
    }
    if (pendingGrab && e.pointerId === pendingGrab.id) {
      if (Math.hypot(w.sx - pendingGrab.sx, w.sy - pendingGrab.sy) > 3) { const pg = pendingGrab; pendingGrab = null; startDrag(pg); setCursor(); }
      else return;
    }
    if (drag && e.pointerId === drag.id) { moveDrag(w); return; }
    if (pan && e.pointerId === pan.id) { view.tx = pan.tx + (w.sx - pan.sx); view.ty = pan.ty + (w.sy - pan.sy); clampView(); userZoomed = true; dirty = true; return; }
    if (e.pointerType === 'mouse' && st.pz) { const h = hitTest(w.x, w.y, false); const hv = h && !st.groups[h].locked ? h : null; if (hv !== st.hover) { st.hover = hv; dirty = true; setCursor(); } }
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
    if (e.ctrlKey || (mouseWheel && !e.shiftKey)) {
      zoomAt(w.sx, w.sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    } else { // desplazamiento con dos dedos en trackpad
      view.tx -= e.shiftKey ? e.deltaY : e.deltaX; view.ty -= e.shiftKey ? 0 : e.deltaY; clampView(); userZoomed = true; dirty = true;
    }
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (!running || e.target.closest('input,textarea')) return;
    if (e.code === 'Space') { spaceDown = true; setCursor(); e.preventDefault(); }
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; setCursor(); } });
  window.addEventListener('resize', () => running && resize());

  /* ---------------- API pública ---------------- */
  return {
    start(code) {
      running = true; st.pz = null; st.groups = {}; st.sprites = null; st.image = null; st.players = []; st.cursors = {};
      resize(); requestAnimationFrame(loop);
      net.close(); net.connect(code, getProfile());
    },
    stop() { running = false; net.close(); st.pz = null; },
    resize, fit,
    zoomIn() { zoomAt(cw / 2, ch / 2, 1.35); },
    zoomOut() { zoomAt(cw / 2, ch / 2, 1 / 1.35); },
    toggleGuide() { st.guide = !st.guide; dirty = true; return st.guide; },
    toggleEdges() { st.edges = !st.edges; dirty = true; return st.edges; },
    togglePan() { st.panMode = !st.panMode; setCursor(); return st.panMode; },
    arrange() { if (!net.send({ t: 'arrange' })) ui.onToast('Sin conexión.'); },
    chat(text) { return net.send({ t: 'chat', text }); },
    profile(p) { net.send({ t: 'profile', ...p }); },
    get room() { return st.room; },
    get you() { return st.you; },
    get puzzle() { return st.pz; },
    hud: pushHud,
    // Ayuda para pruebas automáticas: posición en pantalla del centro de una pieza.
    _debug(i, target) {
      if (!st.pz) return null; const n = st.pz.n, r = Math.floor(i / n), c = i % n;
      const gid = Object.keys(st.groups).find(k => st.groups[k].members.includes(i)); if (!gid) return null;
      const p = target ? { x: FX, y: FY } : posOf(gid);
      return { gid, locked: st.groups[gid].locked, x: (p.x + (c + 0.5) / n) * view.s + view.tx, y: (p.y + (r + 0.5) / n) * view.s + view.ty, view: { ...view }, ready: !!st.sprites };
    },
  };
}
