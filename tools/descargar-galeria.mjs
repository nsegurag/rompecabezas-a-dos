#!/usr/bin/env node
// Descarga las 25 imágenes de la galería desde Wikimedia Commons (obras de dominio público y fotos con licencia libre),
// crea la versión grande (1600 px) y la miniatura (360 px) y escribe public/galeria/galeria.json + CREDITOS.md.
//
// Uso (una sola vez, en tu computadora, con Node 18 o más nuevo):
//     node tools/descargar-galeria.mjs
//
// Luego revisa las imágenes en public/galeria/ y sube la carpeta a GitHub.
// Si alguna no te gusta, cambia su línea en la lista de abajo (por otro nombre de archivo de Commons o por otra búsqueda) y vuelve a correr el script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'galeria');
const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'RompecabezasADos/1.0 (proyecto personal de rompecabezas; descarga unica de galeria)';
const BIG = 1600, MINI = 360;

const CATS = [
  { id: 'pintura', nombre: 'Pintura clásica' }, { id: 'paisajes', nombre: 'Paisajes' }, { id: 'animales', nombre: 'Animales' },
  { id: 'ciudades', nombre: 'Ciudades y pueblos' }, { id: 'flores', nombre: 'Flores y jardines' },
];
// file = nombre exacto del archivo en Commons (si no existe, se usa la búsqueda q). q = búsqueda en inglés.
const ITEMS = [
  { cat: 'pintura', titulo: 'La noche estrellada', file: 'Van Gogh - Starry Night - Google Art Project.jpg', q: 'Starry Night Van Gogh' },
  { cat: 'pintura', titulo: 'La gran ola de Kanagawa', file: 'Great Wave off Kanagawa2.jpg', q: 'Great Wave off Kanagawa Hokusai' },
  { cat: 'pintura', titulo: 'El caminante sobre el mar de nubes', file: 'Caspar David Friedrich - Wanderer above the sea of fog.jpg', q: 'Wanderer above the sea of fog Friedrich' },
  { cat: 'pintura', titulo: 'Los nenúfares', file: 'Claude Monet - Water Lilies - 1906, Ryerson.jpg', q: 'Monet Water Lilies 1906' },
  { cat: 'pintura', titulo: 'El nacimiento de Venus', file: 'Sandro Botticelli - La nascita di Venere - Google Art Project - edited.jpg', q: 'Botticelli Birth of Venus' },
  { cat: 'pintura', titulo: 'La joven de la perla', file: 'Meisje met de parel.jpg', q: 'Girl with a Pearl Earring Vermeer' },
  { cat: 'pintura', titulo: 'Tarde de domingo en la Grande Jatte', file: 'A Sunday on La Grande Jatte, Georges Seurat, 1884.jpg', q: 'Sunday Afternoon on the Island of La Grande Jatte Seurat' },

  { cat: 'paisajes', titulo: 'Matterhorn y su reflejo', q: 'Matterhorn reflection lake' },
  { cat: 'paisajes', titulo: 'Vía Láctea sobre la montaña', q: 'Milky Way mountains lake night' },
  { cat: 'paisajes', titulo: 'Bosque en otoño', q: 'autumn forest path' },
  { cat: 'paisajes', titulo: 'Dolomitas', q: 'Dolomites Tre Cime di Lavaredo' },
  { cat: 'paisajes', titulo: 'Torres del Paine', q: 'Torres del Paine landscape' },

  { cat: 'animales', titulo: 'Zorro rojo', q: 'red fox' },
  { cat: 'animales', titulo: 'Tigre de Bengala', q: 'Bengal tiger' },
  { cat: 'animales', titulo: 'Elefante africano', q: 'African elephant' },
  { cat: 'animales', titulo: 'Guacamaya roja', q: 'scarlet macaw' },
  { cat: 'animales', titulo: 'Jirafa', q: 'giraffe savanna' },

  { cat: 'ciudades', titulo: 'Gran Canal de Venecia', q: 'Venice Grand Canal' },
  { cat: 'ciudades', titulo: 'Oia, Santorini', q: 'Oia Santorini' },
  { cat: 'ciudades', titulo: 'Manarola, Cinque Terre', q: 'Manarola Cinque Terre' },
  { cat: 'ciudades', titulo: 'Antigua Guatemala', q: 'Antigua Guatemala Arco de Santa Catalina' },

  { cat: 'flores', titulo: 'Campo de tulipanes', q: 'tulip field Netherlands' },
  { cat: 'flores', titulo: 'Lavanda en Provenza', q: 'lavender field Provence' },
  { cat: 'flores', titulo: 'Girasoles', q: 'sunflower field' },
  { cat: 'flores', titulo: 'Cerezos en flor', q: 'cherry blossom' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, asJson) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: asJson ? 'application/json' : '*/*' } });
    if (r.status === 429 || r.status >= 500) { await sleep((Number(r.headers.get('retry-after')) || 4) * 1000 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return asJson ? r.json() : Buffer.from(await r.arrayBuffer());
  }
  throw new Error('Demasiados reintentos: ' + url);
}
const strip = h => String(h || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
const slug = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function info(p) {
  const ii = p.imageinfo && p.imageinfo[0]; if (!ii) return null;
  const m = ii.extmetadata || {};
  return { title: p.title, index: p.index ?? 0, url: ii.descriptionurl, w: ii.width, h: ii.height, mime: ii.mime,
    licencia: strip(m.LicenseShortName && m.LicenseShortName.value), autor: strip(m.Artist && m.Artist.value).slice(0, 120) };
}
const PROPS = 'action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|size|mime|extmetadata';
async function byTitle(file) {
  const j = await get(`${API}?${PROPS}&redirects=1&titles=${encodeURIComponent('File:' + file)}`, true);
  const p = (j.query.pages || []).find(x => !x.missing); return p ? info(p) : null;
}
async function search(q, prefix) {
  const j = await get(`${API}?${PROPS}&generator=search&gsrnamespace=6&gsrlimit=20&gsrsearch=${encodeURIComponent((prefix ? prefix + ' ' : '') + q)}`, true);
  return ((j.query && j.query.pages) || []).map(info).filter(Boolean).sort((a, b) => a.index - b.index);
}
// Buena candidata: JPG/PNG, grande, proporción razonable para un rompecabezas y licencia libre reconocible.
const good = c => /^image\/(jpeg|png)$/.test(c.mime) && c.w >= 1400 && c.w / c.h > 0.7 && c.w / c.h < 2.2 && /public domain|pd|cc0|cc[ -]by/i.test(c.licencia);

async function resolve(it) {
  if (it.file) { const c = await byTitle(it.file); if (c && /^image\/(jpeg|png)$/.test(c.mime)) return c; }
  for (const prefix of ['incategory:"Featured pictures on Wikimedia Commons"', 'incategory:"Quality images"', '']) {
    const c = (await search(it.q, prefix)).find(good); if (c) return c;
    await sleep(500);
  }
  return null;
}
const thumb = (title, w) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title.replace(/^File:/, '').replace(/ /g, '_'))}?width=${w}`;

fs.mkdirSync(path.join(OUT, 'mini'), { recursive: true });
const done = [], fallos = [];
let n = 0;
for (const it of ITEMS) {
  n++;
  process.stdout.write(`[${String(n).padStart(2, '0')}/${ITEMS.length}] ${it.titulo} … `);
  try {
    const c = await resolve(it);
    if (!c) throw new Error('no se encontró una imagen libre adecuada');
    const id = `${String(n).padStart(2, '0')}-${slug(it.titulo)}`, ext = c.mime === 'image/png' ? 'png' : 'jpg';
    fs.writeFileSync(path.join(OUT, `${id}.${ext}`), await get(thumb(c.title, BIG)));
    await sleep(700);
    fs.writeFileSync(path.join(OUT, 'mini', `${id}.${ext}`), await get(thumb(c.title, MINI)));
    done.push({ id, cat: it.cat, titulo: it.titulo, autor: c.autor, licencia: c.licencia, fuente: c.url, src: `/galeria/${id}.${ext}`, mini: `/galeria/mini/${id}.${ext}` });
    console.log(`OK  ${c.title.replace(/^File:/, '')}  [${c.licencia}]`);
  } catch (e) { fallos.push(it.titulo); console.log('FALLÓ: ' + e.message); }
  await sleep(900);
}
if (!done.length) { console.error('\nNo se descargó nada. ¿Tienes internet?'); process.exit(1); }
fs.writeFileSync(path.join(OUT, 'galeria.json'), JSON.stringify({ categorias: CATS, imagenes: done }, null, 1));
fs.writeFileSync(path.join(OUT, 'CREDITOS.md'), '# Créditos de la galería\n\nImágenes de Wikimedia Commons. Cada una conserva su licencia.\n\n' +
  done.map(d => `- **${d.titulo}** — ${d.autor || 'autor desconocido'} — ${d.licencia} — ${d.fuente}`).join('\n') + '\n');
console.log(`\nListo: ${done.length} imágenes en ${OUT}` + (fallos.length ? `\nNo se pudieron: ${fallos.join(', ')} (cambia su línea en el script y vuelve a correrlo).` : ''));
