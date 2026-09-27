// Recorte cuadrado (1:1) con arrastre, rueda y pellizco.
export class Cropper {
  constructor(canvas, range) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.range = range;
    this.img = null; this.z = 1; this.cx = 0.5; this.cy = 0.5; this.ptrs = new Map(); this.pinch = null;
    range.addEventListener('input', () => { this.z = +range.value; this.draw(); });
    canvas.addEventListener('pointerdown', e => { if (!this.img) return; canvas.setPointerCapture(e.pointerId); this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (this.ptrs.size === 2) { const [a, b] = [...this.ptrs.values()]; this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.z }; } });
    canvas.addEventListener('pointermove', e => {
      const prev = this.ptrs.get(e.pointerId); if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY }; this.ptrs.set(e.pointerId, cur);
      if (this.pinch && this.ptrs.size >= 2) { const [a, b] = [...this.ptrs.values()]; this.setZoom(this.pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / this.pinch.d); return; }
      const rect = canvas.getBoundingClientRect(), g = this.geom(), k = g.side / rect.width;
      this.cx -= (cur.x - prev.x) * k / this.img.naturalWidth;
      this.cy -= (cur.y - prev.y) * k / this.img.naturalHeight;
      this.draw();
    });
    const end = e => { this.ptrs.delete(e.pointerId); if (this.ptrs.size < 2) this.pinch = null; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', e => { if (!this.img) return; e.preventDefault(); this.setZoom(this.z * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  }
  setZoom(z) { this.z = Math.max(1, Math.min(4, z)); this.range.value = this.z; this.draw(); }
  load(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Sin archivo'));
      const im = new Image();
      im.onload = () => { this.img = im; this.z = 1; this.cx = 0.5; this.cy = 0.5; this.range.value = 1; requestAnimationFrame(() => this.draw()); resolve(); };
      im.onerror = () => reject(new Error('No se pudo leer la imagen. Prueba con un JPG o PNG.'));
      im.src = URL.createObjectURL(file);
    });
  }
  reset() { this.img = null; }
  geom() {
    const w = this.img.naturalWidth, h = this.img.naturalHeight, side = Math.min(w, h) / this.z;
    const cx = Math.max(side / 2, Math.min(w - side / 2, this.cx * w)), cy = Math.max(side / 2, Math.min(h - side / 2, this.cy * h));
    this.cx = cx / w; this.cy = cy / h;
    return { sx: cx - side / 2, sy: cy - side / 2, side };
  }
  draw() {
    if (!this.img) return;
    const rect = this.cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1), S = Math.round((rect.width || 320) * d);
    if (this.cv.width !== S) { this.cv.width = this.cv.height = S; }
    const g = this.geom(), x = this.ctx;
    x.clearRect(0, 0, S, S); x.drawImage(this.img, g.sx, g.sy, g.side, g.side, 0, 0, S, S);
    x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1;
    for (let i = 1; i < 3; i++) { x.beginPath(); x.moveTo(S * i / 3, 0); x.lineTo(S * i / 3, S); x.moveTo(0, S * i / 3); x.lineTo(S, S * i / 3); x.stroke(); }
  }
  export() {
    const g = this.geom();
    for (const size of [1024, 880, 720]) {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
      x.drawImage(this.img, g.sx, g.sy, g.side, g.side, 0, 0, size, size);
      for (let q = 0.88; q >= 0.6; q -= 0.07) { const u = c.toDataURL('image/jpeg', q); if (u.length <= 1_400_000) return u; }
    }
    return null;
  }
}
