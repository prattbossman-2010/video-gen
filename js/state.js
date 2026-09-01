(function () {
  const App = (window.App = window.App || {});

  App.utils = {
    uid() {
      return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    },
    clamp(v, a, b) { return Math.max(a, Math.min(b, v)); },
    fmtTime(s) {
      s = Math.max(0, Math.floor(s));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    },
    esc(str) {
      const d = document.createElement('div');
      d.textContent = str == null ? '' : String(str);
      return d.innerHTML;
    },
    debounce(fn, ms) {
      let t;
      return function () {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, arguments), ms);
      };
    },
    hash(str) {
      let h = 0;
      for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
      return Math.abs(h);
    },
    weserv(url, w) {
      return 'https://images.weserv.nl/?w=' + (w || 1600) + '&output=jpg&q=85&url=' + encodeURIComponent(url.replace(/^https?:\/\//, ''));
    },
    thumbProxy(url) {
      return 'https://images.weserv.nl/?w=320&h=200&fit=cover&output=jpg&q=70&url=' + encodeURIComponent(String(url).replace(/^https?:\/\//, ''));
    }
  };

  const STOPWORDS = new Set(('a an and are as at be been being but by can could did do does for from get got had has have he her hers him his how i if in into is it its just like may me might more most much must my no nor not of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours about after again all also any because before below between both during each few further here neither now often since still usually via without yet thing things one two percent welcome welcome today quick guide scenes scene video videos audio voiceover voice narration clip clips footage section sections part parts step steps intro outro subscribe channel share comment description below above lets hey hello hi okay ok yes yeah sure thanks thank please want wants let really actually basically simply lot lots bit okay').split(' '));

  function extractKeywords(text) {
    const seen = new Set();
    const out = [];
    for (let w of text.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/)) {
      w = w.replace(/^'+|'+$/g, '');
      if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= 6) break;
    }
    return out;
  }

  App.cleanQuery = function (text, maxWords) {
    const kws = extractKeywords(typeof text === 'string' ? text : String(text));
    return kws.slice(0, maxWords || 8).join(' ');
  };

  App.extractKeywords = extractKeywords;

  App.defaultProject = function () {
    return {
      meta: { title: 'My Video', aspect: '16:9', res: '720p', fps: 30 },
      scenes: [],
      music: { name: '', volume: 0.15 },
      keys: { pexels: '', pixabay: '' }
    };
  };

  App.state = {
    project: null,
    selectedSceneId: null,
    searchKind: 'image',
    voBuffers: {},
    musicBuffer: null
  };

  App.newScene = function (text) {
    text = (text || '').trim();
    return {
      id: App.utils.uid(),
      text: text,
      keywords: extractKeywords(text),
      media: null,
      trimStart: 0,
      trimDur: null,
      imgDur: 5,
      overlay: true,
      overlayPos: 'bottom',
      transition: '',
      effects: { filter: '', speed: 1 },
      voVoice: '',
      hasVO: false
    };
  };

  function sceneSpeed(s) {
    const sp = s.effects && Number(s.effects.speed);
    return isFinite(sp) && sp >= 0.5 && sp <= 2.5 ? sp : 1;
  }
  App.sceneSpeed = sceneSpeed;

  App.sceneBaseDur = function (s) {
    if (!s.media) return 3.5;
    if (s.media.type === 'image') return s.imgDur || 5;
    const mdur = (s.media.duration || 15) - (s.trimStart || 0);
    const src = Math.min(s.trimDur || Math.min(mdur, 15), mdur);
    return Math.max(0.8, src / sceneSpeed(s));
  };

  const VO_PAD = 0.35;

  App.timeline = function () {
    const t = [];
    let cursor = 0;
    for (const s of App.state.project.scenes) {
      let dur = App.sceneBaseDur(s);
      const vo = App.state.voBuffers[s.id];
      const voDur = vo ? vo.duration : 0;
      if (voDur > 0) dur = Math.max(dur, voDur + VO_PAD);
      dur = Math.round(dur * 20) / 20;
      t.push({ scene: s, start: cursor, end: cursor + dur, dur: dur });
      cursor += dur;
    }
    return { entries: t, total: cursor };
  };

  App.saveLocal = App.utils.debounce(function () {
    try {
      const p = JSON.parse(JSON.stringify(App.state.project));
      localStorage.setItem('vga_project', JSON.stringify(p));
    } catch (e) {}
  }, 400);

  App.loadLocal = function () {
    try {
      const raw = localStorage.getItem('vga_project');
      if (!raw) return false;
      const p = JSON.parse(raw);
      if (!p || !Array.isArray(p.scenes)) return false;
      App.state.project = Object.assign(App.defaultProject(), p);
      App.state.project.keys = Object.assign({ pexels: '', pixabay: '' }, p.keys || {});
      return true;
    } catch (e) {
      return false;
    }
  };

  App.buildScenesFromScript = function (script) {
    let parts = script.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
    if (parts.length <= 1 && script.trim()) {
      const sentences = script.match(/[^.!?\n]+[.!?]*/g) || [script];
      parts = [];
      let buf = '';
      for (const sn of sentences.map(s => s.trim())) {
        buf += (buf ? ' ' : '') + sn;
        if (buf.length > 220) { parts.push(buf); buf = ''; }
      }
      if (buf) parts.push(buf);
    }
    return parts.filter(Boolean).map(t => App.newScene(t));
  };

  App.sampleProject = function () {
    const script =
      'The ocean covers more than seventy percent of our planet.\n\n' +
      'Beneath the waves lives a world of color, motion, and mystery that scientists are only beginning to understand.\n\n' +
      'Every second breath you take comes from the ocean, produced by tiny organisms called phytoplankton.\n\n' +
      'Protecting the blue heart of Earth is not a choice. It is a necessity.';
    const scenes = App.buildScenesFromScript(script);
    scenes.forEach((s, i) => { s.overlayPos = i === 0 ? 'title' : 'bottom'; });
    const proj = App.defaultProject();
    proj.scenes = scenes;
    proj.meta.title = 'The Blue Heart';
    return proj;
  };
})();
