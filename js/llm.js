(function () {
  const App = window.App;
  const C = window.APP_CONFIG || {};

  function ls(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }

  function cfg(name) {
    const v = (C[name] == null ? '' : String(C[name])).trim();
    if (v && !/^PASTE_.*_HERE$/.test(v)) return v;
    return ls('cfg_' + name).trim();
  }

  App.hasKey = function (name) { return !!cfg(name); };

  const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

  function zenUrl() {
    return ((C.zenBase || 'https://opencode.ai/zen/v1').replace(/\/+$/, '')) + '/chat/completions';
  }

  let good = null;
  const disabledP = { or: false, zen: false };

  function modelList(kind) {
    const out = [];
    const split = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
    const hasOr = !!cfg('openrouterKey') && !disabledP.or;
    const hasZen = !!cfg('zenKey') && !disabledP.zen;
    if (kind === 'tts') {
      if (hasOr) split(cfg('openrouterTtsModel')).forEach(m => out.push(['or', m]));
      if (hasZen) split(cfg('zenTtsModel')).forEach(m => out.push(['zen', m]));
      return out;
    }
    if (hasOr) split(cfg('openrouterModels') || 'google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3-ultra-550b-a55b:free,z-ai/glm-5.2:free').forEach(m => out.push(['or', m]));
    if (hasZen) split(cfg('zenModels') || 'gemini-3.7-flash,grok-4.6,gpt-5.4-mini').forEach(m => out.push(['zen', m]));
    return out;
  }

  async function chatCall(provider, model, messages, maxTokens) {
    const isOr = provider === 'or';
    const key = cfg(isOr ? 'openrouterKey' : 'zenKey');
    if (!key) throw new Error('no api key');
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    if (isOr) {
      headers['HTTP-Referer'] = 'https://script2video.local';
      headers['X-Title'] = 'Script2Video Studio';
    }
    const body = {
      model: model,
      messages: messages,
      max_tokens: maxTokens || 500,
      temperature: 0.4
    };
    const url = isOr ? OR_URL : zenUrl();
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(60000) : undefined
        });
        if (!r.ok) {
          const t = await r.text();
          if (r.status === 401 || r.status === 402 || r.status === 403) {
            disabledP[isOr ? 'or' : 'zen'] = true;
            good = null;
            throw new Error('provider disabled for this session: HTTP ' + r.status + ' ' + t.slice(0, 80));
          }
          lastErr = new Error('HTTP ' + r.status + ' ' + t.slice(0, 90));
          if (r.status === 429 && attempt === 0) {
            await new Promise(res => setTimeout(res, 6000));
            continue;
          }
          throw lastErr;
        }
        const d = await r.json();
        const msg = d.choices && d.choices[0] && d.choices[0].message;
        if (!msg || !msg.content) throw new Error('empty completion');
        return msg.content;
      } catch (e) {
        lastErr = e;
        if (String(e.message).includes('429') && attempt === 0) {
          await new Promise(res => setTimeout(res, 6000));
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('request failed');
  }

  const ENV_MAP = {
    OPENROUTER_API_KEY: 'openrouterKey',
    ZEN_API_KEY: 'zenKey',
    OPENROUTER_MODELS: 'openrouterModels',
    OPENROUTER_TTS_MODEL: 'openrouterTtsModel',
    ZEN_MODELS: 'zenModels',
    ZEN_TTS_MODEL: 'zenTtsModel',
    ZEN_BASE_URL: 'zenBase'
  };

  App.loadEnvViaHelper = async function () {
    if (!(App.helper && App.helper.available)) return false;
    try {
      const r = await fetch(App.helper.base + '/envfile', {
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(5000) : undefined
      });
      if (!r.ok) return false;
      const d = await r.json();
      if (!d.vars) return false;
      let applied = false;
      for (const k of Object.keys(ENV_MAP)) {
        const target = ENV_MAP[k];
        const current = window.APP_CONFIG[target];
        const isPlaceholder = !current || /^PASTE_/.test(String(current));
        if (d.vars[k] && isPlaceholder && !ls('cfg_' + target)) {
          window.APP_CONFIG[target] = d.vars[k];
          applied = true;
        }
      }
      return applied;
    } catch (e) {
      return false;
    }
  };

  App.llmText = async function (prompt, maxTokens, onTry) {
    let order = [];
    if (good) order.push(good);
    for (const pm of modelList('text')) {
      const o = { provider: pm[0], model: pm[1] };
      if (!order.some(x => x.provider === o.provider && x.model === o.model)) order.push(o);
    }
    let lastErr = null;
    for (const o of order) {
      try {
        onTry && onTry((o.provider === 'or' ? 'OpenRouter' : 'Zen') + ' / ' + o.model);
        const out = await chatCall(o.provider, o.model, [{ role: 'user', content: prompt }], maxTokens);
        good = o;
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    try {
      onTry && onTry('free keyless model');
      const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt) + '?model=openai-fast', {
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(35000) : undefined
      });
      if (r.ok) {
        let raw = await r.text();
        if ((r.headers.get('Content-Type') || '').includes('json')) {
          try { raw = JSON.parse(raw).choices[0].message.content; } catch (e) {}
        }
        return raw;
      }
    } catch (e) {}
    throw new Error('all AI providers failed (' + (lastErr ? lastErr.message : 'no keys configured') + ')');
  };

  function parseKeywords(v) {
    let arr = [];
    if (Array.isArray(v)) arr = v;
    else arr = String(v || '').split(/[,\n;]/);
    const seen = new Set();
    const out = [];
    for (let w of arr) {
      w = String(w).toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (w.length < 3 || seen.has(w)) continue;
      seen.add(w);
      out.push(w.split(' ').slice(0, 3).join(' '));
      if (out.length >= 5) break;
    }
    return out;
  }

  async function jsonWithRetry(buildPrompt, parseFn, maxTokens, onTry) {
    let extra = '';
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await App.llmText(buildPrompt() + extra, maxTokens, onTry);
      try {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('reply contained no JSON object');
        const slice = raw.slice(start, end + 1);
        if (/\[\s*\.\.\.\s*\]|\[\.\.\.\]|\u2026/.test(slice)) throw new Error('reply contains [..] placeholders');
        const json = JSON.parse(slice);
        return parseFn(json);
      } catch (e) {
        lastErr = e;
        extra = '\n\nIMPORTANT: Your previous reply was rejected (' + String(e.message).slice(0, 70) + '). Respond again with ONLY one complete valid minified JSON object. Fill EVERY field with real finished content - never use "[...]", ellipses, comments or placeholders.';
      }
    }
    throw lastErr || new Error('invalid JSON twice');
  }

  App.llmEnhanceScript = async function (script, hints, onTry) {
    const sys = 'You are an elite cinematic screenwriter. Expand the user\'s short idea into a narration script for a short video. HARD RULES: keep EVERY character, event and outcome exactly as the user wrote it (who fights, who wins, what finisher happens) - never invent contradictory outcomes; spell all proper nouns exactly as given; use vivid concrete visual language that can be matched to real footage; structure: strong hook line, escalating build-up, dramatic climax at the end, one memorable closing line; 160-340 words; plain prose only, paragraphs separated by blank lines (each paragraph becomes a scene); NO titles, NO stage directions, NO markdown, NO lists.' +
      ' OUTPUT FORMAT (mandatory): your very first line must be exactly SCRIPT_START, then the script paragraphs, then a final line exactly SCRIPT_END. Write NOTHING before SCRIPT_START and nothing after SCRIPT_END - no planning, no notes, no explanations.' +
      (hints ? '\nOverall visual style: ' + hints : '');
    const raw = await App.llmText(sys + '\n\nUSER IDEA:\n' + script.slice(0, 2000), 2400, onTry);
    let t = String(raw).replace(/```[a-z]*|```/gi, '');
    let body;
    const starts = [];
    const ends = [];
    t.replace(/SCRIPT_START/gi, (m, i) => { starts.push(i); return m; });
    t.replace(/SCRIPT_END/gi, (m, i) => { ends.push(i); return m; });
    if (starts.length) {
      const s = starts[starts.length - 1];
      const cands = ends.filter(x => x > s);
      const e = cands.length ? Math.max.apply(null, cands) : t.length;
      if (e > s) body = t.slice(s + 12, e);
    }
    if (!body) {
      body = t
        .replace(/^#+\s*/gm, '')
        .replace(/^\*\*(.*)\*\*$/gm, '$1')
        .replace(/SCRIPT_(START|END)/gi, '')
        .replace(/^["'\u201c\u201d\s]+|["'\u201c\u201d\s]+$/g, '');
      const lines = body.split('\n');
      while (lines.length) {
        const l = lines[0].trim();
        if (!l || (/^(we (need|must|should|are)|i (need|must|will|should)|let me|first(ly)?[, ]|okay[,!]|sure[,!]|to (write|create|make|produce|craft)|the user|my (task|goal)|as an? )/i.test(l))) {
          lines.shift();
        } else break;
      }
      body = lines.join('\n').trim();
    }
    body = body.replace(/^["'\u201c\u201d\s]+|["'\u201c\u201d\s]+$/g, '').trim();
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words < 40) throw new Error('enhancer returned no usable script');
    return body;
  };

  App.llmPlanScenes = async function (script, hints, onTry) {
    const sys = 'You are a video director. Split the script into scenes. Respond ONLY with minified JSON: {"entities":["named characters/brands that recur"],"scenes":[{"text":"exact narration text","caption":"3-6 word punchy on-screen caption","keywords":["concrete visible thing"],"mood":"calm"}]}. Rules: entities lists proper-noun subjects that appear across scenes (e.g. game/anime/movie characters) - empty array if none; caption is a short catchy phrase from the text (never the whole sentence); keywords are VISIBLE searchable things for stock AND web footage search (3-5 items, 1-2 words each) - when a scene features a named character, that exact lowercase name MUST be the first keyword, followed by visible elements (e.g. ["raiden","lightning","fight"]); if the subject is a video-game character add "gameplay" as the last keyword; mood one of calm,epic,sad,happy,tense,mysterious; keep narration text unchanged; 1-3 sentences per scene.' +
      (hints ? '\nOverall visual style the keywords should match: ' + hints : '');
    const build = () => sys + '\n\nSCRIPT:\n' + script.slice(0, 8000);
    return await jsonWithRetry(build, json => {
      if (!json.scenes || !Array.isArray(json.scenes) || !json.scenes.length) throw new Error('scenes missing');
      const out = json.scenes.map(s => {
        const text = String(s.text || '').trim();
        let kws = parseKeywords(s.keywords);
        if (!kws.length) kws = App.extractKeywords(text).slice(0, 4);
        let cap = String(s.caption || '').replace(/["\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim();
        if (cap.length > 60) cap = cap.slice(0, 57).trim() + '...';
        return { text: text, caption: cap, keywords: kws, mood: String(s.mood || '').toLowerCase() };
      }).filter(s => s.text);
      if (!out.length) throw new Error('all scenes empty');
      let entities = [];
      if (Array.isArray(json.entities)) {
        entities = json.entities.map(e => String(e).toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()).filter(e => e.length >= 3).slice(0, 6);
      }
      return { scenes: out, entities: entities };
    }, 2800, onTry);
  };

  App.llmRankClips = async function (sceneText, clips, onTry) {
    const list = clips.map((c, i) => ({
      i: i,
      title: String(c.title || c.credit || '').slice(0, 70),
      dur: c.duration ? Number(Number(c.duration).toFixed(1)) : null
    }));
    const sys = 'Pick which stock clip best matches the sentence visually. Reply ONLY minified JSON {"order":[best to worst indices]} using every index exactly once. No other text.';
    const raw = await App.llmText(sys + '\n\nSentence: ' + sceneText.slice(0, 300) + '\n\nClips: ' + JSON.stringify(list), 250, onTry);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0) throw new Error('no json');
    const d = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(d.order)) throw new Error('order missing');
    const seen = new Set();
    const order = [];
    for (const n of d.order) {
      const idx = Math.round(Number(n));
      if (idx >= 0 && idx < clips.length && !seen.has(idx)) { seen.add(idx); order.push(clips[idx]); }
    }
    clips.forEach((c, i) => { if (!seen.has(i)) order.push(c); });
    return order;
  };

  App.llmEditPlan = async function (scenesSummary, onTry) {
    const sys = 'You are a professional video editor controlling pacing and rhythm. For each scene choose the final duration in seconds and a transition. Rules: duration must be at least voLen + 0.35 (never cut off narration) and between 2 and 30 seconds; tense or epic action scenes cut fast and punchy (2.5-4.5s, hard "cut"); calm/sad/happy scenes breathe longer (4-8s, gentle "fade"); make the climactic scene the fastest cutting of all; give the final scene about 1 extra second to land the closing line; vary the rhythm - never make every scene the same length; trim dead air after narration ends. Respond ONLY with minified JSON: {"scenes":[{"i":0,"duration":5.2,"transition":"fade"}]} including every index. No other text.';
    const build = () => sys + '\n\nSCENES:\n' + scenesSummary;
    return await jsonWithRetry(build, json => {
      if (!json.scenes || !Array.isArray(json.scenes) || !json.scenes.length) throw new Error('scenes missing');
      for (const s of json.scenes) {
        if (!isFinite(Number(s.i)) || !isFinite(Number(s.duration))) throw new Error('invalid numbers in plan');
      }
      return json.scenes;
    }, 900, onTry);
  };

  window.__llmCfg = cfg;
})();
