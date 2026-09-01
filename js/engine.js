(function () {
  const App = window.App;
  const U = App.utils;
  const CF = 0.5;

  function Engine(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ac.createGain();
    this.musicGain = this.ac.createGain();
    this.musicGain.gain.value = 0.15;
    this.dest = this.ac.createMediaStreamDestination();
    this.master.connect(this.ac.destination);
    this.master.connect(this.dest);
    this.musicGain.connect(this.master);

    this.prepared = {};
    this.t = 0;
    this.playing = false;
    this._raf = null;
    this._lastTs = 0;
    this._voices = [];
    this._musicSrc = null;
    this.musicBuffer = null;
    this.onTick = null;
    this.onEnd = null;
  }

  Engine.prototype.setFormat = function (aspect, res) {
    const hd = res === '1080p';
    let w, h;
    if (aspect === '9:16') { w = hd ? 1080 : 720; h = hd ? 1920 : 1280; }
    else if (aspect === '1:1') { w = h = hd ? 1080 : 720; }
    else { w = hd ? 1920 : 1280; h = hd ? 1080 : 720; }
    this.canvas.width = w;
    this.canvas.height = h;
  };

  Engine.prototype.loadImageEl = function (url, proxied) {
    const self = this;
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const to = setTimeout(() => resolve({ ok: false }), 25000);
      img.onload = () => { clearTimeout(to); resolve({ ok: true, el: img }); };
      img.onerror = () => {
        clearTimeout(to);
        if (!proxied && !/^data:/.test(url)) {
          self.loadImageEl(U.weserv(url, 1600), true).then(resolve);
        } else {
          resolve({ ok: false });
        }
      };
      img.src = proxied ? url : url;
    });
  };

  Engine.prototype.loadVideoEl = function (url, anonymous) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      if (anonymous) v.crossOrigin = 'anonymous';
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      const to = setTimeout(() => resolve({ ok: false }), 30000);
      v.onloadeddata = () => {
        clearTimeout(to);
        resolve({ ok: true, el: v, safe: !!anonymous });
      };
      v.onerror = () => {
        clearTimeout(to);
        if (anonymous) resolve({ ok: false, retryUnsafe: true });
        else resolve({ ok: false });
      };
      v.src = url;
      v.load();
    });
  };

  Engine.prototype.prepareScene = async function (s) {
    const P = this.prepared;
    if (P[s.id]) delete P[s.id];
    if (!s.media || !s.media.url) {
      P[s.id] = { type: 'ph', seed: U.hash(s.id) };
      return;
    }
    if (s.media.type === 'image') {
      let r = await this.loadImageEl(s.media.finalUrl || s.media.url, !!s.media.finalUrl);
      if (!r.ok) r = await this.loadImageEl(U.weserv(s.media.url, 1600), true);
      if (!r.ok) {
        const plain = new Image();
        await new Promise(res => { plain.onload = plain.onerror = res; plain.src = s.media.url; });
        if (plain.naturalWidth) { P[s.id] = { type: 'img', el: plain, safe: false }; s.media.safe = false; return; }
        P[s.id] = { type: 'ph', seed: U.hash(s.id) };
        s.media.safe = false;
        return;
      }
      P[s.id] = { type: 'img', el: r.el, safe: true };
      s.media.safe = true;
    } else {
      let r = await this.loadVideoEl(s.media.finalUrl || s.media.url, true);
      if (!r.ok && s.media.finalUrl && s.media.finalUrl !== s.media.url) {
        r = await this.loadVideoEl(s.media.url, true);
      }
      if (r.ok) {
        P[s.id] = { type: 'vid', el: r.el, safe: true };
        if (!s.media.duration || isNaN(s.media.duration)) s.media.duration = r.el.duration || 15;
        s.media.safe = true;
        return;
      }
      if (r.retryUnsafe) {
        r = await this.loadVideoEl(s.media.url, false);
        if (r.ok) {
          P[s.id] = { type: 'vid', el: r.el, safe: false };
          if (!s.media.duration) s.media.duration = r.el.duration || 15;
          s.media.safe = false;
          return;
        }
      }
      P[s.id] = { type: 'ph', seed: U.hash(s.id) };
      s.media.safe = false;
    }
  };

  Engine.prototype.prepareAll = async function (onProgress) {
    const scenes = App.state.project.scenes;
    for (let i = 0; i < scenes.length; i++) {
      onProgress && onProgress(i, scenes.length);
      await this.prepareScene(scenes[i]);
    }
    onProgress && onProgress(scenes.length, scenes.length);
  };

  Engine.prototype.sceneAt = function (t) {
    const tl = App.timeline();
    for (const e of tl.entries) {
      if (t >= e.start && t < e.end) return e;
    }
    return tl.entries.length ? null : null;
  };

  Engine.prototype.drawPlaceholder = function (ctx, W, H, seed, text) {
    const palettes = [
      ['#1a2a4f', '#3b1d5e'], ['#0f3d3a', '#123c63'], ['#43214f', '#71284b'],
      ['#243b1d', '#1d4f44'], ['#4f2a1a', '#63301d'], ['#20304f', '#1d5e50']
    ];
    const p = palettes[seed % palettes.length];
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, p[0]);
    g.addColorStop(1, p[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };

  Engine.prototype.drawCover = function (ctx, src, sw, sh, W, H, zoom, panX, panY, alpha) {
    if (!sw || !sh) return;
    const scale = Math.max(W / sw, H / sh) * (zoom || 1);
    const dw = sw * scale, dh = sh * scale;
    const dx = (W - dw) / 2 + (panX || 0) * (dw - W) / 2;
    const dy = (H - dh) / 2 + (panY || 0) * (dh - H) / 2;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.restore();
  };

  Engine.prototype.wrapText = function (ctx, text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  };

  Engine.prototype.drawCaption = function (ctx, W, H, text, pos, alpha) {
    if (!text) return;
    const fs = Math.round(H * 0.055);
    ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = this.wrapText(ctx, text, W * 0.86);
    const lh = fs * 1.35;
    const totalH = lines.length * lh;
    let y0;
    if (pos === 'center') y0 = H / 2 - totalH / 2 + lh / 2;
    else if (pos === 'title') y0 = H * 0.12 + lh / 2;
    else y0 = H * 0.88 - totalH + lh / 2;

    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    for (let i = 0; i < lines.length; i++) {
      const y = y0 + i * lh;
      ctx.shadowColor = 'rgba(0,0,0,.85)';
      ctx.shadowBlur = fs * 0.35;
      ctx.shadowOffsetY = 2;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.lineWidth = fs * 0.14;
      ctx.strokeText(lines[i], W / 2, y);
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#fff';
      ctx.fillText(lines[i], W / 2, y);
    }
    ctx.restore();
  };

  const FILTERS = {
    none: 'none',
    grayscale: 'grayscale(1) contrast(1.05)',
    sepia: 'sepia(0.75) contrast(1.02)',
    warm: 'saturate(1.25) hue-rotate(-8deg) brightness(1.04)',
    cool: 'saturate(1.1) hue-rotate(12deg) brightness(0.98)',
    vintage: 'sepia(0.35) saturate(0.85) contrast(1.08) brightness(0.96)',
    vivid: 'saturate(1.45) contrast(1.12)',
    noir: 'grayscale(1) contrast(1.3) brightness(0.92)'
  };
  Engine.FILTERS = FILTERS;

  function fxOf(scene) {
    const fx = scene.effects || {};
    const filter = FILTERS[fx.filter] ? fx.filter : 'none';
    let speed = Number(fx.speed);
    if (!isFinite(speed) || speed < 0.5 || speed > 2.5) speed = 1;
    return { filter: filter, speed: speed, fadeIn: fx.fadeIn !== false, fadeOut: fx.fadeOut !== false };
  }
  Engine.prototype.fxOf = fxOf;

  Engine.prototype.syncVideo = function (p, entry, t, playing) {
    const el = p.el;
    if (!el) return;
    const s = entry.scene;
    const fx = fxOf(s);
    const wantRate = el.playbackRate !== fx.speed ? fx.speed : el.playbackRate;
    if (el.playbackRate !== wantRate) {
      try { el.playbackRate = fx.speed; } catch (e) {}
    }
    const local = t - entry.start;
    const target = (s.trimStart || 0) + local * fx.speed;
    if (playing) {
      if (el.paused) {
        try { el.currentTime = target; } catch (e) {}
        const pr = el.play();
        if (pr && pr.catch) pr.catch(() => {});
      } else if (Math.abs(el.currentTime - target) > 0.45) {
        try { el.currentTime = target; } catch (e) {}
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.08) {
        try { el.currentTime = target; } catch (e) {}
      }
    }
  };

  Engine.prototype.pauseVideos = function () {
    for (const id in this.prepared) {
      const p = this.prepared[id];
      if (p.type === 'vid' && p.el && !p.el.paused) p.el.pause();
    }
  };

  Engine.prototype.draw = function (t) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const tl = App.timeline();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!tl.entries.length) {
      this.drawCaption(ctx, W, H, 'Add scenes to begin', 'center', 0.8);
      return;
    }
    t = U.clamp(t, 0, Math.max(0, tl.total - 0.001));
    let idx = -1;
    for (let i = 0; i < tl.entries.length; i++) {
      if (t >= tl.entries[i].start && t < tl.entries[i].end) { idx = i; break; }
    }
    if (idx < 0) idx = tl.entries.length - 1;
    const cur = tl.entries[idx];
    const next = tl.entries[idx + 1] || null;
    const localT = t - cur.start;
    const remain = cur.end - t;
    const cf = (next && (cur.scene.transition === 'cut' || next.scene.transition === 'cut')) ? 0 : CF;

    this.renderEntry(ctx, W, H, cur, localT, 1);

    let fadeAlpha = 0;
    if (next && cf > 0 && remain < cf) {
      fadeAlpha = 1 - remain / cf;
      const nPrep = this.prepared[next.scene.id];
      if (nPrep && nPrep.type === 'vid') {
        const target = next.scene.trimStart || 0;
        if (nPrep.el.paused) {
          try { nPrep.el.currentTime = target; } catch (e) {}
          const pr = nPrep.el.play();
          if (pr && pr.catch) pr.catch(() => {});
        }
      }
      this.renderEntry(ctx, W, H, next, -1, fadeAlpha);
    }

    const s = cur.scene;
    if (s.overlay !== false && s.text) {
      this.drawCaption(ctx, W, H, s.text, s.overlayPos || 'bottom', 1);
    }

    if (this.playing && next && cf > 0 && remain < cf) {
      const nPrep2 = this.prepared[next.scene.id];
      if (nPrep2 && nPrep2.type === 'vid' && nPrep2.el.currentTime > (next.scene.trimStart || 0) + cf + 0.2) {
        nPrep2.el.pause();
      }
    }
  };

  Engine.prototype.renderEntry = function (ctx, W, H, entry, localT, alpha) {
    const scene = entry.scene;
    const fx = fxOf(scene);
    let envA = alpha == null ? 1 : alpha;
    if (localT >= 0) {
      if (fx.fadeIn && localT < 0.35) envA *= Math.max(0.05, localT / 0.35);
      if (fx.fadeOut && entry.dur - localT < 0.35) envA *= Math.max(0.05, (entry.dur - localT) / 0.35);
    }
    if (envA <= 0.01) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    ctx.filter = FILTERS[fx.filter] || 'none';
    try {
      this.renderEntryInner(ctx, W, H, entry, localT, envA);
    } finally {
      ctx.filter = 'none';
    }
  };

  Engine.prototype.renderEntryInner = function (ctx, W, H, entry, localT, alpha) {
    let p = this.prepared[entry.scene.id];
    if (!p || (p.type === 'ph' && entry.scene.media)) {
      p = { type: 'ph', seed: U.hash(entry.scene.id), loading: true };
    }
    if (p.type === 'ph') {
      this.drawPlaceholder(ctx, W, H, p.seed);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      return;
    }
    if (p.type === 'img') {
      const prog = entry.dur > 0 ? U.clamp(localT / entry.dur, 0, 1) : 0;
      const seed = U.hash(entry.scene.id);
      const dir = seed % 4;
      const zoom = 1 + prog * 0.09;
      const panX = dir === 0 ? prog * 0.5 : dir === 2 ? -prog * 0.5 : 0;
      const panY = dir === 1 ? -prog * 0.4 : dir === 3 ? prog * 0.4 : 0;
      this.drawCover(ctx, p.el, p.el.naturalWidth, p.el.naturalHeight, W, H, zoom, panX, panY, alpha);
      return;
    }
    if (p.type === 'vid') {
      this.drawCover(ctx, p.el, p.el.videoWidth || 16, p.el.videoHeight || 9, W, H, 1, 0, 0, alpha);
      return;
    }
  };

  Engine.prototype.stopAudioNodes = function () {
    this._voices.forEach(v => { try { v.stop(); } catch (e) {} });
    this._voices = [];
    if (this._musicSrc) { try { this._musicSrc.stop(); } catch (e) {} this._musicSrc = null; }
  };

  Engine.prototype.scheduleAudio = function (fromT) {
    const ac = this.ac;
    const anchor = ac.currentTime + 0.05;
    const tl = App.timeline();
    for (const e of tl.entries) {
      const buf = App.state.voBuffers[e.scene.id];
      if (!buf) continue;
      const endT = e.start + Math.min(buf.duration, e.dur);
      if (endT <= fromT) continue;
      const offsetInBuf = Math.max(0, fromT - e.start);
      const playAt = anchor + Math.max(0, e.start - fromT);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(this.master);
      src.start(playAt, offsetInBuf);
      this._voices.push(src);
    }
    if (this.musicBuffer && this.musicBuffer.duration > 0) {
      const src = ac.createBufferSource();
      src.buffer = this.musicBuffer;
      src.loop = true;
      src.connect(this.musicGain);
      src.start(anchor, fromT % this.musicBuffer.duration);
      this._musicSrc = src;
    }
  };

  Engine.prototype.play = async function () {
    if (this.ac.state === 'suspended') await this.ac.resume();
    const tl = App.timeline();
    if (!tl.entries.length) return;
    if (this.t >= tl.total - 0.01) this.t = 0;
    cancelAnimationFrame(this._raf);
    this.stopAudioNodes();
    this.scheduleAudio(this.t);
    const entry = this.sceneAt(this.t);
    if (entry) {
      const p = this.prepared[entry.scene.id];
      if (p && p.type === 'vid') this.syncVideo(p, entry, this.t, true);
    }
    this.playing = true;
    this._spokenIdx = -1;
    this._lastTs = performance.now();
    const loop = (ts) => {
      if (!this.playing) return;
      const dt = Math.min(0.25, (ts - this._lastTs) / 1000);
      this._lastTs = ts;
      this.t += dt;
      const tlx = App.timeline();
      if (this.t >= tlx.total) {
        this.t = tlx.total;
        this.playing = false;
        this.stopAudioNodes();
        this.pauseVideos();
        this.draw(this.t);
        this.onTick && this.onTick(this.t, tlx.total, false);
        this.onEnd && this.onEnd();
        return;
      }
      const e2 = this.sceneAt(this.t);
      if (e2) {
        const p2 = this.prepared[e2.scene.id];
        if (p2 && p2.type === 'vid') this.syncVideo(p2, e2, this.t, true);
        const idx = tlx.entries.indexOf(e2);
        if (idx !== this._spokenIdx) {
          this._spokenIdx = idx;
          if (App.state.voSpeakOnly && App.state.voSpeakOnly[e2.scene.id]) {
            App.speakLocally(e2.scene.text, e2.scene.voVoice);
          }
        }
      }
      this.draw(this.t);
      this.onTick && this.onTick(this.t, tlx.total, true);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  };

  Engine.prototype.pause = function () {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this.stopAudioNodes();
    this.pauseVideos();
    App.stopLocalSpeech && App.stopLocalSpeech();
    this.draw(this.t);
  };

  Engine.prototype.seekTo = function (t) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    App.stopLocalSpeech && App.stopLocalSpeech();
    this.t = U.clamp(t, 0, Math.max(0, App.timeline().total - 0.001));
    const entry = this.sceneAt(this.t);
    if (entry) {
      const p = this.prepared[entry.scene.id];
      if (p && p.type === 'vid') this.syncVideo(p, entry, this.t, false);
    }
    this.draw(this.t);
    this.onTick && this.onTick(this.t, App.timeline().total, false);
  };

  App.Engine = Engine;
})();
