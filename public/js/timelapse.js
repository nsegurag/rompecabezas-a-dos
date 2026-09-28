import { W, H, THEMES, buildGeometry, buildSprites, drawPieces, drawTable } from './geometry.js';

/**
 * Video en cámara rápida del armado.
 * El servidor guarda cada movimiento; aquí se reproducen sobre un canvas y el
 * navegador lo graba como video (MediaRecorder). Todo pasa en tu dispositivo.
 */
export function timelapseSupported() {
  return !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
}
function pickType() {
  const opts = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const t of opts) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  return '';
}
const fmt = ms => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; const p = v => String(v).padStart(2, '0'); return (h ? h + ':' : '') + p(m) + ':' + p(x); };
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo cargar la foto.')); i.src = src; }); }

export async function makeTimelapse({ code, key, canvas, assets, themeName, onProgress, signal }) {
  const r = await fetch(`/api/rooms/${code}/replay?key=${encodeURIComponent(key || 'shared')}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'No se pudo preparar el video.');
  if (!data.events.length) throw new Error('Todavía no hay movimientos para grabar.');

  // Reusar las piezas ya preparadas si es la misma partida.
  let geo, sprites, image;
  if (assets && assets.pz && assets.pz.id === data.id && assets.sprites) ({ geo, sprites, image } = assets);
  else { image = await loadImage(data.img); geo = buildGeometry(data.cols, data.rows, data.seed); sprites = buildSprites(image, geo); }

  const theme = THEMES[themeName] || THEMES.ciruela;
  const WIDTH = 1200, HEIGHT = 800; // misma proporción que la mesa (3:2)
  canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d'), s = WIDTH / W;
  const groups = JSON.parse(JSON.stringify(data.initial));
  const events = data.events, total = events[events.length - 1][0] || 1;

  // Duración: más movimientos, video un poco más largo (entre 6 y 20 segundos).
  const intro = 1200, play = Math.min(20000, Math.max(6000, 4000 + events.length * 45)), outro = 3200, dur = intro + play + outro;
  let applied = 0;
  function apply(ev) {
    const [, kind] = ev;
    if (kind === 'd') {
      const [, , target, x, y, del, locked] = ev;
      const members = new Set(groups[target] ? groups[target].members : []);
      for (const d of del) { if (groups[d]) groups[d].members.forEach(m => members.add(m)); delete groups[d]; }
      groups[target] = { x, y, z: applied + 1, members: [...members], locked: !!locked };
    } else if (kind === 'a') {
      for (const [gid, [x, y]] of Object.entries(ev[2])) if (groups[gid]) { groups[gid].x = x; groups[gid].y = y; }
    }
  }
  const order = () => Object.keys(groups).sort((a, b) => (groups[a].locked ? 0 : 1) - (groups[b].locked ? 0 : 1) || groups[a].z - groups[b].z);

  function frame(t) {
    const k = t < intro ? 0 : Math.min(events.length, Math.floor(((t - intro) / play) * events.length));
    while (applied < k) apply(events[applied++]);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = theme.page; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    drawTable(ctx, data, theme, 1 / s, 1, null);
    drawPieces(ctx, data, geo, sprites, groups, order(), gid => groups[gid]);
    const finished = applied >= events.length && t >= intro + play;
    if (finished && data.doneAt) { ctx.drawImage(image, data.FX, data.FY, data.PW, data.PH); }
    // Textos
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const clock = applied ? events[applied - 1][0] : 0;
    ctx.fillStyle = 'rgba(20,14,24,.72)'; roundRect(ctx, 20, 20, 360, 64, 14); ctx.fill();
    ctx.fillStyle = '#f2b134'; ctx.font = '26px "Young Serif", Georgia, serif'; ctx.fillText(trim(ctx, data.room, 330), 36, 50);
    ctx.fillStyle = '#e9e1f0'; ctx.font = '700 16px "Atkinson Hyperlegible", system-ui, sans-serif';
    ctx.fillText(`${data.cols * data.rows} piezas · ${fmt(clock)}${data.who ? ' · ' + data.who : ''}`, 36, 72);
    // Barra de progreso
    const pr = applied / events.length;
    ctx.fillStyle = 'rgba(255,255,255,.15)'; roundRect(ctx, 20, HEIGHT - 26, WIDTH - 40, 8, 4); ctx.fill();
    ctx.fillStyle = '#f2b134'; roundRect(ctx, 20, HEIGHT - 26, Math.max(8, (WIDTH - 40) * pr), 8, 4); ctx.fill();
    if (finished && data.doneAt) {
      const a = Math.min(1, (t - intro - play) / 600);
      ctx.globalAlpha = a; ctx.fillStyle = 'rgba(20,14,24,.82)'; roundRect(ctx, WIDTH / 2 - 260, HEIGHT - 150, 520, 100, 18); ctx.fill();
      ctx.fillStyle = '#f2b134'; ctx.font = '40px "Young Serif", Georgia, serif'; ctx.textAlign = 'center';
      ctx.fillText('¡Armado!', WIDTH / 2, HEIGHT - 98);
      ctx.fillStyle = '#e9e1f0'; ctx.font = '700 18px "Atkinson Hyperlegible", system-ui, sans-serif';
      ctx.fillText(`Tiempo total ${fmt(data.doneAt - data.startAt)} · Rompecabezas a Dos`, WIDTH / 2, HEIGHT - 66);
      ctx.textAlign = 'left'; ctx.globalAlpha = 1;
    }
  }

  frame(0);
  const type = pickType();
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 4_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  rec.start(250);
  await new Promise((resolve, reject) => {
    const t0 = performance.now();
    const step = () => {
      if (signal && signal.aborted) { reject(new Error('cancelado')); return; }
      const t = performance.now() - t0;
      frame(t); onProgress && onProgress(Math.min(1, t / dur));
      if (t >= dur) resolve(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }).finally(() => { if (rec.state !== 'inactive') rec.stop(); stream.getTracks().forEach(tr => tr.stop()); });
  await stopped;
  const mime = rec.mimeType || type || 'video/webm';
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  return { blob, ext: mime.includes('mp4') ? 'mp4' : 'webm', type: mime.split(';')[0] };
}

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
function trim(ctx, text, max) { let t = text || ''; while (t.length > 1 && ctx.measureText(t).width > max) t = t.slice(0, -1); return t === text ? t : t + '…'; }
