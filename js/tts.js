(function () {
  const App = window.App;

  const FEMALE = new Set(['Amy', 'Emma', 'Joanna', 'Salli', 'Ivy', 'Kendra', 'Kimberly', 'Nicole', 'Raveena', 'Aditi', 'Celine', 'Chantal', 'Marlene', 'Vicki', 'Carla', 'Vitoria', 'Ines', 'Tatyana', 'Mizuki', 'Seoyeon', 'Zhiyu', 'Astrid', 'Filiz', 'Lotte', 'Ewa', 'Maja', 'Carmen', 'Dora', 'Mathilde', 'Penelope']);

  const LANG = {
    Conchita: 'es', Enrique: 'es', Penelope: 'es', Miguel: 'es',
    Celine: 'fr', Mathieu: 'fr', Chantal: 'fr',
    Marlene: 'de', Hans: 'de', Vicki: 'de',
    Carla: 'it', Giorgio: 'it',
    Vitoria: 'pt-BR', Ricardo: 'pt-BR', Ines: 'pt', Cristiano: 'pt',
    Tatyana: 'ru', Maxim: 'ru',
    Mizuki: 'ja', Takumi: 'ja', Seoyeon: 'ko', Zhiyu: 'zh-CN',
    Astrid: 'sv', Filiz: 'tr', Lotte: 'nl', Ruben: 'nl',
    Ewa: 'pl', Jacek: 'pl', Jan: 'pl', Maja: 'pl',
    Carmen: 'ro', Dora: 'is', Karl: 'is', Mathilde: 'no'
  };

  App.voiceLang = function (voice) { return LANG[voice] || 'en'; };

  function withTimeout(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    return undefined;
  }

  async function fetchAudio(url, timeoutMs, opts) {
    const r = await fetch(url, Object.assign({ signal: withTimeout(timeoutMs || 30000) }, opts || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const type = (r.headers.get('Content-Type') || '').toLowerCase();
    const ab = await r.arrayBuffer();
    if (!ab || ab.byteLength < 512) throw new Error('empty audio');
    if (type.includes('json') || type.includes('html') || type.startsWith('text/')) throw new Error('not audio');
    return ab;
  }

  function gttsUrl(text, lang) {
    return 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' +
      encodeURIComponent(lang) + '&q=' + encodeURIComponent(text);
  }
  function b64ToBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function voiceRate(voice) {
    return FEMALE.has(voice) ? 1.05 : 0.93;
  }

  async function reshape(ac, buffer, voice) {
    const rate = voiceRate(voice);
    if (!buffer || Math.abs(rate - 1) < 0.02 || buffer.duration < 0.3) return buffer;
    try {
      const ch = Math.min(2, buffer.numberOfChannels);
      const length = Math.ceil(buffer.length / rate);
      const off = new OfflineAudioContext(ch, length, buffer.sampleRate);
      const src = off.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(off.destination);
      src.start();
      return await off.startRendering();
    } catch (e) {
      return buffer;
    }
  }

  async function llmAudioTts(text, voice) {
    const cfgf = window.__llmCfg;
    const key = cfgf('openrouterKey');
    if (!key) throw new Error('no openrouter key');
    const model = cfgf('openrouterTtsModel');
    const v = FEMALE.has(voice) ? 'nova' : 'onyx';
    const chunks = chunkText(text, 900);
    const bufs = [];
    if (!window.__vgaAC) window.__vgaAC = new (window.AudioContext || window.webkitAudioContext)();
    const ac = window.__vgaAC;
    for (const chunk of chunks) {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
          'HTTP-Referer': 'https://script2video.local',
          'X-Title': 'Script2Video Studio'
        },
        body: JSON.stringify({
          model: model,
          modalities: ['text', 'audio'],
          audio: { voice: v, format: 'mp3' },
          messages: [{ role: 'user', content: 'Read this out loud exactly as written:\n' + chunk }]
        }),
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(120000) : undefined
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 90));
      }
      const d = await r.json();
      const audioObj = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.audio;
      if (!audioObj || !audioObj.data) throw new Error('no audio in response');
      const decoded = await ac.decodeAudioData(b64ToBuffer(audioObj.data).slice(0));
      bufs.push(decoded);
      await new Promise(r2 => setTimeout(r2, 150));
    }
    return concatBuffers(ac, bufs);
  }

  function chunkText(text, maxLen) {    text = (text || '').trim();
    if (!text) return [];
    if (text.length <= maxLen) return [text];
    const sentences = text.match(/[^.!?\n]+[.!?]*[\s]*/g) || [text];
    const chunks = [];
    let buf = '';
    for (let s of sentences) {
      s = s.trim();
      if ((buf + ' ' + s).trim().length > maxLen) {
        if (buf) chunks.push(buf.trim());
        while (s.length > maxLen) {
          let cut = s.lastIndexOf(' ', maxLen);
          if (cut < maxLen * 0.5) cut = maxLen;
          chunks.push(s.slice(0, cut).trim());
          s = s.slice(cut);
        }
        buf = s;
      } else {
        buf = (buf ? buf + ' ' : '') + s;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
    return chunks.filter(Boolean);
  }

  function concatBuffers(ac, buffers) {
    if (!buffers.length) throw new Error('empty audio');
    if (buffers.length === 1) return buffers[0];
    const ch = Math.max(...buffers.map(b => b.numberOfChannels));
    const rate = buffers[0].sampleRate;
    const len = buffers.reduce((a, b) => a + b.length, 0);
    const out = ac.createBuffer(ch, len, rate);
    let offset = 0;
    for (const b of buffers) {
      for (let c = 0; c < ch; c++) {
        out.getChannelData(c).set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), offset);
      }
      offset += b.length;
    }
    return out;
  }

  async function decodeChunks(ac, text, voice, buildUrl, maxLen) {
    const chunks = chunkText(text, maxLen);
    if (!chunks.length) throw new Error('no text');
    const bufs = [];
    for (const chunk of chunks) {
      const ab = await fetchAudio(buildUrl(chunk, voice));
      const decoded = await ac.decodeAudioData(ab.slice(0));
      bufs.push(decoded);
      await new Promise(r => setTimeout(r, 200));
    }
    return concatBuffers(ac, bufs);
  }

  const RELAYS = [
    ['codetabs', u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)],
    ['allorigins', u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)],
    ['corsproxy.io', u => 'https://corsproxy.io/?url=' + encodeURIComponent(u)],
    ['thingproxy', u => 'https://thingproxy.freeboard.io/fetch/' + u]
  ];

  const PROVIDERS = [
    {
      name: 'device voices (helper)',
      when: () => App.helper && App.helper.available,
      synth: async (ac, text, voice) => {
        const gender = FEMALE.has(voice) ? 'female' : 'male';
        if (text.length > 4500) text = text.slice(0, 4500);
        const ab = await fetchAudio(App.helper.base + '/sapi?gender=' + gender +
          '&text=' + encodeURIComponent(text), 120000);
        const buf = await ac.decodeAudioData(ab.slice(0));
        return await reshape(ac, buf, voice);
      }
    },
    {
      name: 'AI studio voices',
      when: () => window.__llmCfg && !!window.__llmCfg('openrouterTtsModel') && !!window.__llmCfg('openrouterKey'),
      synth: async (ac, text, voice) => {
        return await llmAudioTts(text, voice);
      }
    },
    {
      name: 'helper online voices',
      when: () => App.helper && App.helper.available,
      synth: async (ac, text, voice) => {
        const buf = await decodeChunks(ac, text, voice,
          (chunk) => App.helper.base + '/tts?lang=' + encodeURIComponent(App.voiceLang(voice)) + '&text=' + encodeURIComponent(chunk), 180);
        return await reshape(ac, buf, voice);
      }
    },
    {
      name: 'StreamElements',
      when: () => true,
      synth: (ac, text, voice) => decodeChunks(ac, text, voice,
        (chunk, v) => 'https://api.streamelements.com/kappa/v2/speech?voice=' + encodeURIComponent(v) + '&text=' + encodeURIComponent(chunk), 280)
    }
  ];

  for (const [rname, wrap] of RELAYS) {
    PROVIDERS.push({
      name: rname + ' relay',
      when: () => true,
      synth: (ac, text, voice) => decodeChunks(ac, text, voice,
        chunk => wrap(gttsUrl(chunk, App.voiceLang(voice))), 180)
    });
  }

  let lastGoodProvider = null;
  let llmAudioBroken = false;

  App.generateVO = async function (text, voice, onProgress) {
    if (!window.__vgaAC) window.__vgaAC = new (window.AudioContext || window.webkitAudioContext)();
    const ac = window.__vgaAC;
    if (ac.state === 'suspended') await ac.resume();

    voice = voice || 'Brian';
    const chain = [];
    if (lastGoodProvider && lastGoodProvider.when()) chain.push(lastGoodProvider);
    for (const p of PROVIDERS) {
      if (p === lastGoodProvider) continue;
      if (p.name === 'AI studio voices' && llmAudioBroken) continue;
      if (p.when()) chain.push(p);
    }

    let lastErr = null;
    for (const provider of chain) {
      try {
        onProgress && onProgress('synthesizing via ' + provider.name + '...');
        let buffer = await provider.synth(ac, text || ' ', voice);
        if (!['device voices (helper)', 'AI studio voices'].includes(provider.name)) {
          buffer = await reshape(ac, buffer, voice);
        }
        lastGoodProvider = provider;
        onProgress && onProgress('done');
        return buffer;
      } catch (e) {
        lastErr = e;
        if (provider.name === 'AI studio voices') llmAudioBroken = true;
      }
    }
    throw new Error('all speech services failed (' + (lastErr ? lastErr.message : 'unknown') + ')');
  };

  App.speakLocally = function (text, voice) {
    try {
      if (!('speechSynthesis' in window)) return null;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = App.voiceLang(voice || 'Brian');
      const target = u.lang.slice(0, 2);
      const v = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(target));
      if (v) u.voice = v;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      return u;
    } catch (e) {
      return null;
    }
  };

  App.stopLocalSpeech = function () {
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) {}
  };

  App.TTS_VOICES = [
    { group: 'English', items: [['Brian', 'Brian - male, deep'], ['Amy', 'Amy - female'], ['Emma', 'Emma - female, soft'], ['Joanna', 'Joanna - female, warm'], ['Matthew', 'Matthew - male, news'], ['Salli', 'Salli - female'], ['Joey', 'Joey - male, young'], ['Justin', 'Justin - male, young'], ['Ivy', 'Ivy - female, young']] },
    { group: 'Spanish / French / German', items: [['Conchita', 'Conchita - Spanish female'], ['Enrique', 'Enrique - Spanish male'], ['Celine', 'Celine - French female'], ['Mathieu', 'Mathieu - French male'], ['Marlene', 'Marlene - German female'], ['Hans', 'Hans - German male']] },
    { group: 'Italian / Portuguese / Russian', items: [['Carla', 'Carla - Italian female'], ['Giorgio', 'Giorgio - Italian male'], ['Vitoria', 'Vitoria - Portuguese BR female'], ['Ricardo', 'Ricardo - Portuguese BR male'], ['Tatyana', 'Tatyana - Russian female'], ['Maxim', 'Maxim - Russian male']] },
    { group: 'Asian languages', items: [['Mizuki', 'Mizuki - Japanese female'], ['Takumi', 'Takumi - Japanese male'], ['Seoyeon', 'Seoyeon - Korean female'], ['Zhiyu', 'Zhiyu - Chinese female']] },
    { group: 'Other languages', items: [['Astrid', 'Astrid - Swedish'], ['Filiz', 'Filiz - Turkish'], ['Lotte', 'Lotte - Dutch'], ['Ewa', 'Ewa - Polish'], ['Carmen', 'Carmen - Romanian']] }
  ];
})();
