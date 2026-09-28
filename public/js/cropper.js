// Recorte de la foto con la proporción elegida (1:1, 4:3, 16:9...).
// Se arrastra para encuadrar y se hace zoom con la barra, la rueda o pellizcando.
export class Cropper {
  constructor(canvas, range) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.range = range;
    this.img = null; this.z = 1; this.cx = 0.5; this.cy = 0.5; this.aspect = 1; this.ptrs = new Map(); this.pinch = null;
    range.addEventListener('input', () => { this.z = +range.value; this.draw(); });
    canvas.addEventListener('pointerdown', e => { if (!this.img) return; canvas.setPointerCapture(e.pointerId); this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (this.ptrs.size === 2) { const [a, b] = [...this.ptrs.values()]; this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.z }; } });
    canvas.addEventListener('pointermove', e => {
      const prev = this.ptrs.get(e.pointerId); if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY }; this.ptrs.set(e.pointerId, cur);
      if (this.pinch && this.ptrs.size >= 2) { const [a, b] = [...this.ptrs.values()]; this.setZoom(this.pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / this.pinch.d); return; }
      const rect = canvas.getBoundingClientRect(), g = this.geom(), k = g.sw / rect.width;
      this.cx -= (cur.x - prev.x) * k / this.img.naturalWidth;
      this.cy -= (cur.y - prev.y) * k / this.img.naturalHeight;
      this.draw();
    });
    const end = e => { this.ptrs.delete(e.pointerId); if (this.ptrs.size < 2) this.pinch = null; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', e => { if (!this.img) return; e.preventDefault(); this.setZoom(this.z * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  }
  setZoom(z) { this.z = Math.max(1, Math.min(4, z)); this.range.value = this.z; this.draw(); }
  setAspect(a) { this.aspect = a; this.cv.style.aspectRatio = String(a); this.draw(); }
  load(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Sin archivo'));
      const im = new Image();
      im.onload = () => { this.img = im; this.z = 1; this.cx = 0.5; this.cy = 0.5; this.range.value = 1; requestAnimationFrame(() => this.draw()); resolve(im); };
      im.onerror = () => reject(new Error('No se pudo leer la imagen. Prueba con un JPG o PNG.'));
      im.src = URL.createObjectURL(file);
    });
  }
  /** Proporción natural de la foto, para sugerir el recorte que menos corta. */
  get naturalAspect() { return this.img ? this.img.naturalWidth / this.img.naturalHeight : 1; }
  reset() { this.img = null; }
  geom() {
    const w = this.img.naturalWidth, h = this.img.naturalHeight, a = this.aspect;
    let sw, sh;
    if (w / h > a) { sh = h / this.z; sw = sh * a; } else { sw = w / this.z; sh = sw / a; }
    const cx = Math.max(sw / 2, Math.min(w - sw / 2, this.cx * w)), cy = Math.max(sh / 2, Math.min(h - sh / 2, this.cy * h));
    this.cx = cx / w; this.cy = cy / h;
    return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
  }
  draw() {
    if (!this.img) return;
    const rect = this.cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
    const Wp = Math.round((rect.width || 320) * d), Hp = Math.round(Wp / this.aspect);
    if (this.cv.width !== Wp || this.cv.height !== Hp) { this.cv.width = Wp; this.cv.height = Hp; }
    const g = this.geom(), x = this.ctx;
    x.clearRect(0, 0, Wp, Hp); x.drawImage(this.img, g.sx, g.sy, g.sw, g.sh, 0, 0, Wp, Hp);
    x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1;
    for (let i = 1; i < 3; i++) { x.beginPath(); x.moveTo(Wp * i / 3, 0); x.lineTo(Wp * i / 3, Hp); x.moveTo(0, Hp * i / 3); x.lineTo(Wp, Hp * i / 3); x.stroke(); }
  }
  /** Exporta el recorte. Con más piezas se usa más resolución para que se vean nítidas. */
  export(pieces) {
    const g = this.geom();
    const long = pieces >= 300 ? 2200 : pieces >= 150 ? 1800 : pieces >= 64 ? 1400 : 1100;
    for (const size of [long, Math.round(long * 0.85), Math.round(long * 0.7)]) {
      const c = document.createElement('canvas');
      if (this.aspect >= 1) { c.width = size; c.height = Math.round(size / this.aspect); } else { c.height = size; c.width = Math.round(size * this.aspect); }
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
      x.drawImage(this.img, g.sx, g.sy, g.sw, g.sh, 0, 0, c.width, c.height);
      for (let q = 0.88; q >= 0.62; q -= 0.06) { const u = c.toDataURL('image/jpeg', q); if (u.length <= 5_000_000) return u; }
    }
    return null;
  }
}
