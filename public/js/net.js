// Conexión WebSocket con reconexión automática.
export class Net {
  constructor() { this.h = {}; this.ws = null; this.closed = true; this.tries = 0; this.timer = null; }
  on(t, f) { (this.h[t] || (this.h[t] = [])).push(f); }
  emit(t, m) { (this.h[t] || []).forEach(f => f(m)); }
  connect(room, profile) { this.room = room; this.profile = profile; this.closed = false; this.tries = 0; this.open(); }
  open() {
    clearTimeout(this.timer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.tries = 0; this.emit('status', 'open'); ws.send(JSON.stringify({ t: 'join', room: this.room, ...this.profile })); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } this.emit(m.t, m); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.emit('status', 'closed');
      if (!this.closed) { const d = Math.min(8000, 400 * 2 ** this.tries++); this.timer = setTimeout(() => this.open(), d); }
    };
  }
  send(m) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; } return false; }
  close() { this.closed = true; clearTimeout(this.timer); if (this.ws) { const w = this.ws; this.ws = null; w.close(); } }
}
