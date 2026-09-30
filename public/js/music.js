// Música relajante para armar. Es solo para quien la escucha (no se comparte con la sala).
// "Generativa": se compone sola en el navegador con Web Audio, nunca se repite y no pesa nada.
// "Pistas": si existe /musica/pistas.json, suena una lista de mp3 en orden aleatorio, sin repetir la anterior.
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { } } };

export const MOODS = [
  { id: 'piano', label: 'Piano suave', hint: 'Notas sueltas y cálidas' },
  { id: 'noche', label: 'Noche tranquila', hint: 'Lento, con colchón de fondo' },
  { id: 'bosque', label: 'Bosque', hint: 'Viento y notas graves' },
];
const PENT_MAJ = [0, 2, 4, 7, 9], PENT_MIN = [0, 3, 5, 7, 10];
const midi = m => 440 * Math.pow(2, (m - 69) / 12);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// Cada ambiente: escala, progresión de acordes (raíz relativa + tipo), ritmo de notas y carácter.
const RECIPES = {
  piano: { scale: PENT_MAJ, root: 60, chords: [[0, 'M'], [-7, 'M'], [-3, 'm'], [-5, 'M']], gap: [1.3, 4.2], oct: [0, 1], decay: [3, 5.5], pad: 0.035, padLen: [14, 22], twin: 0.16, wind: 0 },
  noche: { scale: PENT_MIN, root: 57, chords: [[0, 'm'], [-4, 'M'], [-2, 'M'], [-7, 'm']], gap: [3, 8], oct: [0, 1], decay: [5, 8], pad: 0.06, padLen: [18, 28], twin: 0.05, wind: 0 },
  bosque: { scale: PENT_MAJ, root: 50, chords: [[0, 'M'], [-5, 'M'], [-3, 'm'], [2, 'M']], gap: [4, 9], oct: [-1, 0], decay: [4, 7], pad: 0.045, padLen: [20, 30], twin: 0.04, wind: 0.05 },
};

export function createMusic() {
  const S = {
    on: ls.get('rz_music_on') !== '0',                       // por defecto suena, hasta que la persona la apague
    vol: Math.min(100, Math.max(0, Number(ls.get('rz_music_vol') ?? 20))),
    mood: ls.get('rz_music_mood') || 'piano',
  };
  if (!Number.isFinite(S.vol)) S.vol = 20;
  const listeners = new Set();
  const emit = () => listeners.forEach(f => f(S));
  let armed = false, ctx = null, master, duckG, bus, timers = [], playing = false, ducked = false, tracks = null, trackState = null, windNodes = null, key = 0, chordIx = 0;
  const speakers = new Set();

  const gainFor = v => Math.pow(v / 100, 1.2);

  /* ---------- Grafo de audio ---------- */
  function build() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0;
    duckG = ctx.createGain(); duckG.gain.value = 1;
    bus = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.3;
    const dry = ctx.createGain(); dry.gain.value = 0.55;
    const wet = ctx.createGain(); wet.gain.value = 0.7;
    const conv = ctx.createConvolver(); conv.buffer = impulse(3.6, 2.6);
    bus.connect(lp); lp.connect(dry); lp.connect(conv); conv.connect(wet);
    dry.connect(duckG); wet.connect(duckG); duckG.connect(master); master.connect(ctx.destination);
  }
  function impulse(sec, decay) {
    const n = Math.floor(ctx.sampleRate * sec), buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return buf;
  }

  /* ---------- Voces ---------- */
  function note(freq, vol, decay, when = 0) {
    const t = ctx.currentTime + when, g = ctx.createGain(), o = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq; o2.type = 'triangle'; o2.frequency.value = freq * 2; g2.gain.value = 0.22;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(bus);
    o.start(t); o2.start(t); o.stop(t + decay + 0.1); o2.stop(t + decay + 0.1);
  }
  function padChord(rootMidi, kind, len, vol) {
    const t = ctx.currentTime, tones = kind === 'M' ? [0, 4, 7, 12] : [0, 3, 7, 12];
    for (const st of tones) for (const det of [-6, 6]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = st === 12 ? 'sine' : 'triangle'; o.frequency.value = midi(rootMidi + st - 12); o.detune.value = det + rnd(-3, 3);
      const att = Math.min(6, len * 0.35), rel = Math.min(7, len * 0.4);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol / 2, t + att); g.gain.setValueAtTime(vol / 2, t + len - rel + att * 0.3); g.gain.linearRampToValueAtTime(0.0001, t + len + rel);
      o.connect(g); g.connect(bus); o.start(t); o.stop(t + len + rel + 0.2);
    }
  }
  function startWind(level) {
    if (windNodes || !level) return;
    const n = ctx.sampleRate * 4, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0;
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 0.07; lfoG.gain.value = level * 0.7;
    g.gain.value = level; lfo.connect(lfoG); lfoG.connect(g.gain);
    const lfo2 = ctx.createOscillator(), lfo2G = ctx.createGain(); lfo2.frequency.value = 0.05; lfo2G.gain.value = 220; lfo2.connect(lfo2G); lfo2G.connect(bp.frequency);
    src.connect(bp); bp.connect(g); g.connect(bus);
    src.start(); lfo.start(); lfo2.start();
    windNodes = { stop() { try { g.gain.cancelScheduledValues(0); g.gain.setTargetAtTime(0, ctx.currentTime, 0.5); setTimeout(() => { try { src.stop(); lfo.stop(); lfo2.stop(); } catch { } }, 2500); } catch { } } };
  }

  /* ---------- Compositor ---------- */
  function later(fn, ms) { const id = setTimeout(() => { timers = timers.filter(x => x !== id); fn(); }, ms); timers.push(id); }
  function generative(moodId) {
    const R = RECIPES[moodId] || RECIPES.piano;
    key = Math.floor(rnd(-4, 5));                                   // cada vez suena en otro tono
    let degree = Math.floor(rnd(0, R.scale.length)), lastFreq = 0;
    startWind(R.wind);
    const noteLoop = () => {
      if (!playing) return;
      const chord = R.chords[chordIx % R.chords.length];
      // La melodía camina por la escala con pasos cortos y algún salto ocasional; nunca repite la misma nota seguida.
      let step = Math.random() < 0.2 ? pick([-3, -2, 2, 3]) : pick([-1, 1, -2, 2, 1, -1]);
      degree = Math.max(-2, Math.min(R.scale.length * 2 - 1, degree + step));
      const oct = Math.floor(degree / R.scale.length), sc = ((degree % R.scale.length) + R.scale.length) % R.scale.length;
      const m = R.root + key + chord[0] + R.scale[sc] + 12 * (oct + pick(R.oct));
      let f = midi(m); if (Math.abs(f - lastFreq) < 1) f = midi(m + R.scale[(sc + 1) % R.scale.length] - R.scale[sc] + (sc === R.scale.length - 1 ? 12 : 0));
      lastFreq = f;
      note(f, rnd(0.12, 0.2), rnd(...R.decay));
      if (Math.random() < R.twin) note(midi(m + 7), rnd(0.05, 0.09), rnd(...R.decay), 0.12);   // a veces una quinta suave
      later(noteLoop, rnd(...R.gap) * 1000 * (Math.random() < 0.12 ? 2.2 : 1));                     // y de vez en cuando, un silencio largo
    };
    const chordLoop = () => {
      if (!playing) return;
      const c = R.chords[chordIx % R.chords.length], len = rnd(...R.padLen);
      padChord(R.root + key + c[0] - 12, c[1], len, R.pad);
      chordIx++;
      later(chordLoop, len * 1000 * 0.92);
    };
    chordLoop(); later(noteLoop, 1500);
  }

  /* ---------- Pistas grabadas (opcional) ---------- */
  async function loadTracks() {
    if (tracks !== null) return tracks;
    tracks = [];
    try {
      const r = await fetch('/musica/pistas.json', { cache: 'no-cache' });
      if (r.ok && /json/.test(r.headers.get('content-type') || '')) {
        const j = await r.json();
        tracks = (j.pistas || []).filter(p => p && /^\/musica\/[\w .()\-]+\.(mp3|ogg|m4a)$/i.test(p.src));
      }
    } catch { }
    emit();
    return tracks;
  }
  function playTracks() {
    if (!tracks || !tracks.length) return;
    const a = new Audio(); a.preload = 'auto';
    const st = trackState = { a, last: -1, fade: 0, current: null, stopped: false, iv: null };
    const shuffleNext = () => {
      let i; do { i = Math.floor(Math.random() * tracks.length); } while (tracks.length > 1 && i === st.last);
      st.last = i; st.current = tracks[i]; a.src = tracks[i].src; st.fade = 0;
      a.play().catch(() => { });
      emit();
    };
    a.addEventListener('ended', shuffleNext);
    a.addEventListener('error', () => { if (!st.stopped) setTimeout(shuffleNext, 1500); });
    st.iv = setInterval(() => {                               // fundido de entrada y salida de 3 s
      const left = (a.duration || 0) - a.currentTime, inn = Math.min(1, a.currentTime / 3), out = a.duration ? Math.min(1, Math.max(0, left / 3)) : 1;
      st.fade = Math.max(0, Math.min(inn, out));
      a.volume = Math.max(0, Math.min(1, gainFor(S.vol) * (ducked ? 0.25 : 1) * st.fade * 1.6));
    }, 100);
    shuffleNext();
  }
  function stopTracks() { const st = trackState; if (!st) return; st.stopped = true; clearInterval(st.iv); try { st.a.pause(); st.a.removeAttribute('src'); st.a.load(); } catch { } trackState = null; }

  /* ---------- Control ---------- */
  function applyGain() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(playing ? gainFor(S.vol) : 0, t, 0.6);
    duckG.gain.setTargetAtTime(ducked ? 0.25 : 1, t, 0.4);
  }
  async function start() {
    if (playing) return;
    if (S.mood === 'pistas') { await loadTracks(); if (!tracks.length) S.mood = 'piano'; }
    if (S.mood !== 'pistas') {
      build(); if (!ctx) return;
      try { await ctx.resume(); } catch { }
      if (ctx.state !== 'running') { pending = true; return; }   // el navegador aún no permitió sonar: se reintenta con el próximo toque
    }
    playing = true; pending = false;
    if (S.mood === 'pistas') playTracks(); else { generative(S.mood); applyGain(); }
    emit();
  }
  function halt() {
    playing = false; timers.forEach(clearTimeout); timers = [];
    if (windNodes) { windNodes.stop(); windNodes = null; }
    stopTracks();
    if (ctx) {                                                // se apaga con un fundido corto y el contexto se cierra, para que no queden restos sonando
      const c = ctx, m = master, t = c.currentTime; ctx = null;
      try { m.gain.cancelScheduledValues(t); m.gain.setTargetAtTime(0, t, 0.25); } catch { }
      setTimeout(() => { c.close().catch(() => { }); }, 1500);
    }
  }
  let pending = false;
  // Si el navegador bloqueó el sonido por no haber un toque antes, arranca en el siguiente toque en cualquier parte.
  const retry = () => { if (S.on && armed && !playing) start(); };
  document.addEventListener('pointerdown', retry, { capture: true });
  document.addEventListener('keydown', retry, { capture: true });

  return {
    state: S, moods: MOODS,
    get playing() { return playing; },
    get trackCount() { return tracks ? tracks.length : 0; },
    get trackNow() { return trackState && trackState.current ? trackState.current : null; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    async probe() { await loadTracks(); },
    async play() { armed = true; S.on = true; ls.set('rz_music_on', '1'); halt(); await start(); emit(); },
    pause() { S.on = false; ls.set('rz_music_on', '0'); halt(); emit(); },
    toggle() { return S.on ? this.pause() : this.play(); },
    /** Arranca si la persona no la había apagado (se llama tras un toque, p. ej. al entrar a la sala). */
    async autoplay() { armed = true; if (S.on) await start(); },
    /** Al salir de la sala la música se detiene, pero la preferencia (encendida o apagada) se conserva. */
    disarm() { armed = false; halt(); emit(); },
    setVol(v) { S.vol = Math.max(0, Math.min(100, Math.round(v))); ls.set('rz_music_vol', String(S.vol)); applyGain(); emit(); },
    async setMood(id) {
      S.mood = id; ls.set('rz_music_mood', id);
      const was = S.on; halt(); if (was) { await new Promise(r => setTimeout(r, 400)); await start(); }
      emit();
    },
    /** Baja sola cuando alguien habla en la llamada, para que no se cuele en los micrófonos. */
    speaking(id, v) { if (v) speakers.add(id); else speakers.delete(id); const d = speakers.size > 0; if (d !== ducked) { ducked = d; applyGain(); } },
    resetSpeakers() { speakers.clear(); if (ducked) { ducked = false; applyGain(); } },
  };
}
