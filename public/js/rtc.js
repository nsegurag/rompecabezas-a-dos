/**
 * Llamada de voz y video entre los jugadores de una sala (WebRTC).
 * Cada participante se conecta directo con cada uno de los demás ("malla").
 * El servidor del juego solo reenvía los mensajes para establecer la conexión.
 * Usa el patrón "perfect negotiation" para que dos ofertas simultáneas no choquen.
 */
export class Call {
  constructor(net, ui) {
    this.net = net; this.ui = ui;
    this.local = null; this.inCall = false; this.mic = false; this.cam = false; this.facing = 'user';
    this.peers = new Map(); // id -> {pc, polite, makingOffer, ignoreOffer, stream}
    this.ice = null; this.you = null; this.players = [];
    this.meters = new Map(); this.audioCtx = null; this.meterTimer = null;
    net.on('rtc', m => this.onSignal(m.from, m.data));
    net.on('status', s => { if (s !== 'open' && this.inCall) this.leave(true); });
  }
  static supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection); }

  async iceServers() {
    if (this.ice) return this.ice;
    try { const r = await fetch('/api/ice'); this.ice = (await r.json()).iceServers; }
    catch { this.ice = [{ urls: 'stun:stun.l.google.com:19302' }]; }
    return this.ice;
  }

  /**
   * Entrar a la llamada. Se entra con micrófono y cámara APAGADOS: no se pide
   * permiso todavía y ya se escucha y se ve a los demás. Cada quien los activa
   * con los botones cuando quiera (ahí el navegador pide el permiso).
   */
  async join() {
    if (this.inCall) return;
    if (!Call.supported()) throw new Error('Tu navegador no permite llamadas. Prueba con Chrome, Edge, Firefox o Safari actualizados.');
    if (!window.isSecureContext) throw new Error('La llamada necesita que la página se abra con https://');
    await this.iceServers();
    this.local = new MediaStream();
    this.inCall = true; this.mic = false; this.cam = false;
    this.ui.onLocal(this.local, this.state());
    this.announce();
    // Conectar con quienes ya están en la llamada (nosotros hacemos la oferta).
    for (const p of this.players) if (p.id !== this.you && p.media && p.media.call) this.connect(p.id);
  }
  state() { return { call: this.inCall, mic: this.inCall && this.mic, cam: this.inCall && this.cam }; }
  announce() { this.net.send({ t: 'media', ...this.state() }); }

  leave(silent) {
    for (const id of [...this.peers.keys()]) this.drop(id);
    if (this.local) this.local.getTracks().forEach(t => t.stop());
    this.local = null; this.inCall = false; this.mic = false; this.cam = false;
    this.unmeter('me');
    if (!silent) this.announce();
    this.ui.onLocal(null, this.state());
  }

  /** El canal (audio o video) por el que enviamos a esa persona. */
  sender(pc, kind) {
    const tr = pc.getTransceivers().find(t => !t.stopped && t.receiver.track && t.receiver.track.kind === kind);
    return tr ? tr.sender : null;
  }
  sendTrack(kind, track) { for (const p of this.peers.values()) { const s = this.sender(p.pc, kind); if (s) s.replaceTrack(track).catch(() => {}); } }
  permissionError(e, what) {
    if (e && e.name === 'NotAllowedError') return `No diste permiso para usar ${what}. Actívalo en la configuración del navegador (el candado junto a la dirección).`;
    if (e && e.name === 'NotFoundError') return `No encontramos ${what} en este dispositivo.`;
    if (e && e.name === 'NotReadableError') return `Otra app está usando ${what}. Ciérrala e intenta de nuevo.`;
    return `No se pudo abrir ${what}.`;
  }

  async toggleMic() {
    if (!this.local) return;
    let track = this.local.getAudioTracks()[0];
    if (this.mic) { // silenciar: el micrófono se apaga del todo
      if (track) { track.stop(); this.local.removeTrack(track); }
      this.sendTrack('audio', null); this.unmeter('me');
      this.mic = false;
    } else {
      try {
        const a = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        track = a.getAudioTracks()[0]; this.local.addTrack(track);
        this.sendTrack('audio', track); this.meter('me', new MediaStream([track]));
        this.mic = true;
      } catch (e) { this.ui.onError(this.permissionError(e, 'el micrófono')); return; }
    }
    this.announce(); this.ui.onLocal(this.local, this.state());
  }
  async toggleCam() {
    if (!this.local) return;
    const old = this.local.getVideoTracks()[0];
    if (this.cam) { // apagar: se detiene la cámara (se apaga su luz)
      if (old) { old.stop(); this.local.removeTrack(old); }
      this.sendTrack('video', null);
      this.cam = false;
    } else {
      try {
        const v = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: this.facing } });
        const track = v.getVideoTracks()[0]; this.local.addTrack(track);
        this.sendTrack('video', track);
        this.cam = true;
      } catch (e) { this.ui.onError(this.permissionError(e, 'la cámara')); return; }
    }
    this.announce(); this.ui.onLocal(this.local, this.state());
  }
  async flipCam() {
    if (!this.cam || !this.local) return;
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    const old = this.local.getVideoTracks()[0];
    try {
      if (old) old.stop();
      const v = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: this.facing } });
      const track = v.getVideoTracks()[0];
      this.sendTrack('video', track);
      if (old) this.local.removeTrack(old);
      this.local.addTrack(track);
      this.ui.onLocal(this.local, this.state());
    } catch { this.ui.onError('No se pudo cambiar de cámara.'); }
  }

  /** Lista de jugadores actualizada: abrir o cerrar conexiones según quién está en la llamada. */
  setPlayers(players, you) {
    this.players = players; this.you = you;
    if (!this.inCall) return;
    const inCall = new Set(players.filter(p => p.id !== you && p.media && p.media.call).map(p => p.id));
    for (const id of [...this.peers.keys()]) if (!inCall.has(id)) this.drop(id);
  }

  /**
   * Conexión con una persona. Quien la inicia crea un canal de audio y uno de
   * video (aunque estén apagados); quien responde usa los que vienen en la oferta.
   * Así prender o apagar micrófono y cámara es solo cambiar la pista del canal.
   */
  peer(id, initiator) {
    let p = this.peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: this.ice || [] });
    p = { pc, polite: this.you > id, makingOffer: false, ignoreOffer: false, stream: new MediaStream() };
    this.peers.set(id, p);
    const sig = data => this.net.send({ t: 'rtc', to: id, data });
    if (initiator) {
      const a = this.local.getAudioTracks()[0], v = this.local.getVideoTracks()[0];
      pc.addTransceiver(a || 'audio', { direction: 'sendrecv', streams: [this.local] });
      pc.addTransceiver(v || 'video', { direction: 'sendrecv', streams: [this.local] });
    }
    pc.onnegotiationneeded = async () => {
      try { p.makingOffer = true; await pc.setLocalDescription(); sig({ description: pc.localDescription }); }
      catch { } finally { p.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) sig({ candidate }); };
    pc.ontrack = ({ track }) => {
      if (p.stream.getTracks().some(t => t.kind === track.kind)) p.stream.getTracks().filter(t => t.kind === track.kind).forEach(t => p.stream.removeTrack(t));
      p.stream.addTrack(track);
      track.onunmute = () => this.ui.onRemote(id, p.stream);
      this.ui.onRemote(id, p.stream);
      if (track.kind === 'audio') this.meter(id, p.stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { pc.restartIce && pc.restartIce(); this.ui.onPeerState(id, 'failed'); }
      else this.ui.onPeerState(id, pc.connectionState);
    };
    return p;
  }
  connect(id) { this.peer(id, true); } // crear los canales dispara onnegotiationneeded -> oferta

  async onSignal(from, data) {
    if (!this.inCall) return;
    const p = this.peer(from, false), pc = p.pc;
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          // Usar los canales de la oferta también para enviar, con lo que tengamos encendido.
          for (const t of pc.getTransceivers()) {
            if (t.stopped || !t.receiver.track) continue;
            if (t.direction === 'recvonly' || t.direction === 'inactive') t.direction = 'sendrecv';
            const mine = t.receiver.track.kind === 'audio' ? this.local.getAudioTracks()[0] : this.local.getVideoTracks()[0];
            if (mine && t.sender.track !== mine) await t.sender.replaceTrack(mine);
            if (t.sender.setStreams) t.sender.setStreams(this.local);
          }
          await pc.setLocalDescription();
          this.net.send({ t: 'rtc', to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('rtc', e); }
  }
  drop(id) {
    const p = this.peers.get(id); if (!p) return;
    try { p.pc.close(); } catch { }
    this.peers.delete(id); this.unmeter(id);
    this.ui.onRemote(id, null);
  }

  /* Indicador de quién está hablando */
  meter(id, stream) {
    if (!stream.getAudioTracks().length) return;
    try {
      this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      this.unmeter(id);
      const src = this.audioCtx.createMediaStreamSource(stream), an = this.audioCtx.createAnalyser();
      an.fftSize = 512; src.connect(an);
      this.meters.set(id, { src, an, buf: new Uint8Array(an.fftSize), speaking: false });
      if (!this.meterTimer) this.meterTimer = setInterval(() => this.readMeters(), 150);
    } catch { }
  }
  unmeter(id) { const m = this.meters.get(id); if (m) { try { m.src.disconnect(); } catch { } this.meters.delete(id); } }
  readMeters() {
    if (!this.meters.size) { clearInterval(this.meterTimer); this.meterTimer = null; return; }
    for (const [id, m] of this.meters) {
      m.an.getByteTimeDomainData(m.buf);
      let sum = 0; for (const v of m.buf) { const d = (v - 128) / 128; sum += d * d; }
      const speaking = Math.sqrt(sum / m.buf.length) > 0.04 && (id !== 'me' || this.mic);
      if (speaking !== m.speaking) { m.speaking = speaking; this.ui.onSpeaking(id, speaking); }
    }
  }
}
