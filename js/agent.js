(function () {
  const App = window.App;
  const U = App.utils;

  function scoreItem(it, keywords) {
    let s = it.kind === 'video' ? 120 : 50;
    const t = ((it.title || '') + ' ' + (it.credit || '')).toLowerCase();
    keywords.forEach(k => { if (t.includes(k.toLowerCase())) s += 22; });
    if (it.w) s += Math.min(it.w, 1920) / 1920 * 15;
    if (it.source === 'Pexels') s += 14;
    if (it.source === 'Pixabay') s += 8;
    if (it.duration != null) {
      if (it.duration >= 3 && it.duration <= 90) s += 12;
      else if (it.duration < 2.5) s -= 60;
    }
    if (/\.ogv|\.ogg/i.test(it.url)) s -= 30;
    return s;
  }

  function buildQueries(scene, hints) {
    const kws = (scene.keywords || []).slice(0, 6);
    const ents = (App.state.entitySet || new Set());
    const named = kws.filter(k => ents.has(k));
    const queries = [];
    for (const n of named) {
      const act = kws.find(k => k !== n);
      queries.push(act ? n + ' ' + act : n);
    }
    for (const e of (App.state.entityQueries ? Object.keys(App.state.entityQueries) : [])) {
      if (named.includes(e)) queries.unshift(App.state.entityQueries[e]);
    }
    if (hints) {
      const hq = App.cleanQuery(hints, 8);
      if (hq) queries.push((kws.slice(0, 2).join(' ') + ' ' + hq).trim());
      queries.push(hq);
    }
    if (kws.length) queries.push(kws.join(' '));
    if (kws.length >= 2) queries.push(kws.slice(0, 2).join(' '));
    if (kws.length) queries.push(kws[0]);
    for (const n of named) queries.push(n + ' gameplay');
    return [...new Set(queries.filter(Boolean))].slice(0, 8);
  }

  function rememberHit(q, src) {
    if (!q || !App.state.entityQueries) return;
    const words = q.toLowerCase().split(/\s+/);
    for (const e of (App.state.entitySet || new Set())) {
      if (words.includes(e) && !App.state.entityQueries[e]) App.state.entityQueries[e] = q;
    }
    rememberSource(src);
  }

  async function aiKeywords(text, log, sceneNum) {
    try {
      const prompt = 'Pick stock footage search terms for this sentence. Reply with ONLY 5 simple common English words (single words, comma separated) describing visible things: objects, places, nature, weather, actions on camera.\n\nSentence: ' + text.slice(0, 400);
      const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt) + '?model=openai-fast', { signal: withTimeoutS(20) });
      if (!r.ok) return null;
      let raw = await r.text();
      const ct = (r.headers.get('Content-Type') || '').toLowerCase();
      if (ct.includes('json')) {
        try { raw = JSON.parse(raw).choices[0].message.content; } catch (e) {}
      }
      const seen = new Set();
      const words = [];
      for (let w of String(raw).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
        if (w.length >= 4 && w.length <= 14 && !seen.has(w) && !STOP_EXTRA.has(w)) {
          seen.add(w);
          words.push(w);
        }
        if (words.length >= 5) break;
      }
      if (words.length >= 2) {
        log('ok', 'scene ' + sceneNum + ' AI visual keywords: ' + words.join(', '));
        return words;
      }
    } catch (e) {}
    return null;
  }

  const STOP_EXTRA = new Set(['stock', 'footage', 'video', 'keywords', 'words', 'comma', 'separated', 'reply', 'sentence', 'visible', 'things', 'objects', 'places', 'nature', 'actions', 'camera', 'simple', 'common', 'english', 'describing', 'pick', 'search', 'terms', 'only', 'scene']);

  function sanitizeWords(list) {
    const seen = new Set();
    const out = [];
    for (let w of list || []) {
      w = String(w).toLowerCase().replace(/[^a-z\s]/g, ' ').trim().split(/\s+/)[0];
      if (w.length >= 3 && !seen.has(w)) { seen.add(w); out.push(w); }
    }
    return out.slice(0, 6);
  }

  const GENERIC_BROLL = {
    calm: ['gentle ocean waves', 'clouds drifting sky', 'forest sunlight peaceful', 'lake morning mist'],
    epic: ['epic mountains aerial', 'storm clouds dramatic', 'waterfall powerful cinematic', 'desert dunes aerial'],
    sad: ['rain window drops', 'foggy forest alone', 'empty beach grey sky', 'slow clouds grey'],
    happy: ['sunny meadow flowers', 'beach waves sunshine', 'city day timelapse bright', 'sunflowers field wind'],
    tense: ['dark storm clouds', 'night city rain neon', 'thunder lightning sky', 'dark forest wind'],
    mysterious: ['starry night sky stars', 'misty mountains fog', 'moonlight clouds night', 'deep forest dark']
  };

  function genericQueryFor(scene) {
    const pool = GENERIC_BROLL[scene.mood] || null;
    if (pool) return pool[U.hash(scene.id) % pool.length];
    const all = Object.values(GENERIC_BROLL).flat();
    return all[U.hash(scene.id) % all.length];
  }

  function withTimeoutS(sec) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(sec * 1000);
    return undefined;
  }

  async function searchPool(query, kind, log) {
    const pool = [];
    await App.searchMedia(query, kind, (name, items, err) => {
      if (err && name !== 'Openverse' && name !== 'Pixabay') log('warn', name + ' unavailable (' + err + ')');
      items.forEach(i => pool.push(i));
    });
    return pool;
  }

  function candHay(cand) {
    return ((cand.title || '') + ' ' + (cand.credit || '') + ' ' + cand.url).toLowerCase();
  }

  function gateOk(cand, ents) {
    if (!ents || !ents.length) return true;
    const hay = candHay(cand);
    return ents.some(e => hay.includes(e));
  }

  async function probeVideoSmart(url) {
    const local = url.startsWith('http://127.0.0.1');
    let r = await App.probeVideo(url, local ? 120000 : undefined);
    if (r.ok && r.safe) return { info: r, useUrl: url, proxied: false };
    if (App.helper && App.helper.available && !local) {
      const purl = App.helper.mediaProxyUrl(url);
      const r2 = await App.probeVideo(purl, 45000);
      if (r2.ok && r2.duration >= 2.5 && r2.w >= 240) {
        return { info: { ok: true, duration: r2.duration, w: r2.w, h: r2.h, safe: true }, useUrl: purl, proxied: true };
      }
    }
    return null;
  }

  async function findVideo(queries, ents, kws, budget, log, isCancelled) {
    let tried = 0;
    for (const q of queries) {
      if (isCancelled()) throw new Error('CANCELLED');
      let pool = [];
      try { pool = await searchPool(q, 'video', log); } catch (e) {}
      pool = orderPool(pool, kws);
      for (const cand of pool) {
        if (isCancelled()) throw new Error('CANCELLED');
        if (tried >= budget) return null;
        if (!gateOk(cand, ents)) continue;
        tried++;
        log('step', 'testing video: ' + shortLabel(cand));
        const hit = await probeVideoSmart(cand.url);
        if (hit && hit.info.duration >= 2.5 && hit.info.w >= 240) {
          log('ok', 'found video: ' + shortLabel(cand) + ' (' + hit.info.duration.toFixed(1) + 's' + (hit.proxied ? ', streamed via local helper' : '') + ')');
          rememberHit(q, cand.source);
          return {
            type: 'video',
            url: hit.useUrl,
            finalUrl: hit.useUrl !== cand.url ? hit.useUrl : '',
            origUrl: cand.url,
            thumb: cand.thumb,
            title: cand.title,
            w: hit.info.w, h: hit.info.h,
            duration: hit.info.duration,
            credit: cand.credit,
            source: cand.source,
            safe: true
          };
        }
      }
    }
    return null;
  }

  async function findImage(queries, ents, kws, budget, log, isCancelled) {
    let tried = 0;
    for (const q of queries) {
      if (isCancelled()) throw new Error('CANCELLED');
      let pool = [];
      try { pool = await searchPool(q, 'image', log); } catch (e) {}
      pool = orderPool(pool, kws);
      for (const cand of pool) {
        if (isCancelled()) throw new Error('CANCELLED');
        if (tried >= budget) return null;
        if (!gateOk(cand, ents)) continue;
        tried++;
        let r = await App.probeImage(cand.url);
        let finalUrl = '';
        if (!r.ok || !r.safe) {
          const r2 = await App.probeImageFallback(cand.url);
          if (r2.ok) { r = r2; finalUrl = r2.finalUrl; }
        }
        if (r.ok && r.w >= 400) {
          log('ok', 'using image: ' + shortLabel(cand) + ' (' + r.w + 'x' + r.h + ')');
          rememberHit(q, cand.source);
          return {
            type: 'image',
            url: finalUrl || cand.url,
            finalUrl: finalUrl,
            thumb: cand.thumb,
            title: cand.title,
            w: r.w, h: r.h,
            duration: null,
            credit: cand.credit,
            source: cand.source,
            safe: true
          };
        }
      }
    }
    return null;
  }

  async function pickMedia(scene, hints, log, isCancelled) {
    const queries = buildQueries(scene, hints);
    const theme = (App.state.themeWords || []).join(' ');
    if (theme && queries.length) queries[0] = (theme + ' ' + queries[0]).trim();

    try {
      const seed = queries[0] || scene.keywords.join(' ');
      const titles = await App.dmTitleQueries(seed);
      if (titles.length) {
        const rest = queries.slice(1);
        const head = queries.slice(0, 1);
        const merged = [];
        for (const q of [].concat(head, titles.slice(0, 2), rest, titles.slice(2))) {
          if (q && !merged.includes(q)) merged.push(q);
        }
        queries.length = 0;
        queries.push(...merged.slice(0, 8));
        log('ok', 'web relevance boost: "' + titles[0] + '"');
      }
    } catch (e) {}

    const kws = (scene.keywords || []).slice(0, 6);
    const ents = [...(App.state.entitySet || new Set())].filter(e => kws.includes(e));

    if (ents.length) log('step', 'subject locked: ' + ents.join(', ') + ' - only matching footage accepted');

    let media = await findVideo(queries, ents, kws, 14, log, isCancelled);
    if (!media && ents.length) {
      log('warn', 'no strictly matching video - widening search...');
      media = await findVideo(queries, [], kws, 8, log, isCancelled);
    }
    if (!media) media = await findImage(queries, ents, kws, 6, log, isCancelled);
    if (!media && ents.length) media = await findImage(queries, [], kws, 4, log, isCancelled);

    if (!media) {
      const generic = genericQueryFor(scene);
      log('warn', 'no specific footage - trying mood-matched b-roll: "' + generic + '"');
      let pool = [];
      try { pool = await searchPool(generic, 'video', log); } catch (e) {}
      pool = orderPool(pool, []);
      for (const cand of pool) {
        if (isCancelled()) throw new Error('CANCELLED');
        const r = await App.probeVideo(cand.url);
        if (r.ok && r.duration >= 3 && r.w >= 240) {
          log('ok', 'using generic b-roll: ' + shortLabel(cand) + ' (' + r.duration.toFixed(1) + 's)');
          rememberSource(cand.source);
          return {
            type: 'video',
            url: cand.url,
            finalUrl: '',
            thumb: cand.thumb,
            title: cand.title,
            w: r.w, h: r.h,
            duration: r.duration,
            credit: cand.credit,
            source: cand.source,
            safe: r.safe
          };
        }
      }
    }
    return media;
  }

  function orderPool(pool, kws) {
    const pref = App.state.preferredSource;
    const sorted = pool.slice().sort((a, b) => scoreItem(b, kws || []) - scoreItem(a, kws || []));
    if (!pref) return sorted;
    const hit = sorted.filter(x => x.source === pref);
    const rest = sorted.filter(x => x.source !== pref);
    return hit.concat(rest);
  }

  function rememberSource(src) {
    if (src && src !== 'Web') App.state.preferredSource = src;
  }

  function deriveEntities(text) {
    const counts = {};
    for (const w of text.match(/[A-Z][a-zA-Z]{2,}/g) || []) {
      counts[w] = (counts[w] || 0) + 1;
    }
    return Object.keys(counts)
      .filter(w => counts[w] >= 2)
      .map(w => w.toLowerCase())
      .slice(0, 6);
  }

  function shortLabel(cand) {
    const t = (cand.title || '').replace(/\.(jpe?g|png|webm|mp4|webp|gif|tiff?|svg)$/i, '').trim();
    if (t) return t.length > 48 ? t.slice(0, 48) + '...' : t;
    return (cand.source || 'media') + ' result';
  }

  App.agent = {
    cancelFlag: false,

    isCancelled() { return this.cancelFlag; },

    stop() { this.cancelFlag = true; },

    async run(opts, api) {
      this.cancelFlag = false;
      const log = (cls, msg) => api.log(cls, msg);
      const setProg = p => api.progress(p);

      try {
        const project = App.state.project;
        project.meta.aspect = opts.aspect;
        project.meta.res = opts.res;
        App.state.preferredSource = null;
        App.state.themeWords = opts.hints ? opts.hints.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4).slice(0, 2) : [];
        App.state.entitySet = new Set();
        App.state.entityQueries = {};
        App.state.mediaUse = {};

        let workScript = opts.script;
        const origWords = opts.script.split(/\s+/).filter(Boolean).length;
        if (origWords < 110) {
          log('step', 'short script - AI screenwriter is expanding it into a full cinematic script...');
          await tick();
          try {
            const enhanced = await App.llmEnhanceScript(opts.script, opts.hints, msg => {
              log('step', 'screenwriter via ' + msg);
            });
            const w = enhanced.split(/\s+/).filter(Boolean).length;
            if (enhanced && w > origWords * 1.5 && w < 900) {
              workScript = enhanced;
              if (api.onScriptEnhanced) api.onScriptEnhanced(enhanced);
              log('ok', 'script enhanced: ' + origWords + ' -> ' + w + ' words (check the editor to review it)');
              await tick();
            } else {
              log('warn', 'enhancement result rejected - using your original script');
            }
          } catch (e) {
            log('warn', 'script enhancement skipped (' + String(e.message || e).slice(0, 60) + ')');
          }
        }

        log('step', 'analyzing script...');
        await tick();
        let planned = null;
        const hasAIKeys = window.__llmCfg && (window.__llmCfg('openrouterKey') || window.__llmCfg('zenKey'));
        if (!hasAIKeys) log('warn', 'No AI keys set - paste them via Help for much better visual matching. Using keyless model only...');
        try {
          planned = await App.llmPlanScenes(workScript, opts.hints, msg => {
            log('step', 'AI director: ' + msg);
          });
          log('ok', 'AI director planned ' + planned.scenes.length + ' scenes');
        } catch (e) {
          log('warn', 'AI director unavailable (' + String(e.message || e).slice(0, 70) + ') - using standard split');
        }
        const scenes = planned ? planned.scenes.map(p => {
          const s = App.newScene(p.text);
          s.keywords = p.keywords;
          s.mood = p.mood;
          return s;
        }) : App.buildScenesFromScript(workScript);
        if (!scenes.length) throw new Error('The script is empty.');
        scenes.forEach(s => { s.voVoice = opts.voice; });
        project.scenes = scenes;

        if (planned && planned.entities.length) {
          App.state.entitySet = new Set(planned.entities);
          log('ok', 'recurring subjects detected: ' + planned.entities.join(', ') + ' (footage will stay consistent)');
        } else if (!planned) {
          const derived = deriveEntities(opts.script);
          if (derived.length) {
            App.state.entitySet = new Set(derived);
            log('ok', 'recurring subjects detected: ' + derived.join(', '));
          }
        }
        App.state.voBuffers = {};
        App.engine.prepared = {};
        log('ok', scenes.length + ' scenes detected');

        if (!planned) {
          log('step', 'extracting visual keywords per scene...');
          for (let i = 0; i < scenes.length; i++) {
            if (this.isCancelled()) throw new Error('CANCELLED');
            const s = scenes[i];
            let kws = null;
            if (s.text && s.text.length > 15) {
              kws = await aiKeywords(s.text, log, i + 1);
              await tick();
            }
            if (!kws || !kws.length) {
              const prev = scenes[i - 1];
              if ((s.keywords || []).length < 2 && prev && prev.keywords.length >= 2) {
                s.keywords = prev.keywords.slice(0, 3).concat(s.keywords);
                log('warn', 'scene ' + (i + 1) + ': reusing nearby scene keywords');
              }
            } else {
              s.keywords = kws;
            }
          }
        }
        setProg(0.03);

        setProg(0.04);

        log('step', 'generating voiceovers with ' + opts.voice + '...');
        let voFails = 0;
        App.state.voSpeakOnly = {};
        for (let i = 0; i < scenes.length; i++) {
          if (this.isCancelled()) throw new Error('CANCELLED');
          const s = scenes[i];
          try {
            const buf = await App.generateVO(s.text, opts.voice, msg => {
              log('step', 'scene ' + (i + 1) + ': ' + msg);
            });
            App.state.voBuffers[s.id] = buf;
            s.hasVO = true;
            log('ok', 'scene ' + (i + 1) + ' voiceover ready (' + buf.duration.toFixed(1) + 's)');
          } catch (e) {
            voFails++;
            App.state.voSpeakOnly[s.id] = true;
            log('err', 'scene ' + (i + 1) + ' cloud voiceover failed (' + (e.message || e) + ')');
          }
          setProg(0.05 + 0.25 * ((i + 1) / scenes.length));
          await tick();
        }
        if (voFails === scenes.length) {
          const helperHint = (App.helper && App.helper.available) ? '' :
            ' Start "Start Studio.bat" (in this folder), then Generate again - it provides reliable embedded voices and full-web HD videos.';
          log('warn', 'Cloud voices are unreachable on this network. Preview will read scenes with your device built-in voice.' + helperHint);
        } else if (voFails > 0) {
          log('warn', voFails + ' scene(s) will use preview-only voice.');
        }

        log('step', (App.helper && App.helper.available
          ? 'searching the entire web for visuals (browser mode)...'
          : 'searching free stock libraries for visuals...'));
        for (let i = 0; i < scenes.length; i++) {
          if (this.isCancelled()) throw new Error('CANCELLED');
          const s = scenes[i];
          log('step', 'scene ' + (i + 1) + '/' + scenes.length + ': looking for "' + (s.keywords.join(', ') || 'matching footage') + '"');
          let media = null;
          try {
            media = await pickMedia(s, opts.hints, log, () => this.isCancelled());
          } catch (e) {
            if (String(e.message).includes('CANCELLED')) throw e;
          }
          const voDur = App.state.voBuffers[s.id] ? App.state.voBuffers[s.id].duration : 0;
          const needDur = U.clamp(voDur + 0.5, 2.5, 45);
          if (media) {
            s.media = media;
            if (media.type === 'video') {
              const uses = App.state.mediaUse[media.url] || 0;
              App.state.mediaUse[media.url] = uses + 1;
              const usable = Math.max(0, media.duration - needDur);
              let start;
              if (usable <= 0.5) {
                start = 0;
              } else if (usable <= needDur * 2.2) {
                start = Math.min(usable * Math.min(0.12 + uses * 0.25, 0.85), usable);
              } else {
                const stride = Math.min(needDur, usable / 3);
                start = (uses * stride) % (usable - stride * 0.5);
              }
              s.trimStart = Math.round(Math.max(0, start) * 10) / 10;
              s.trimDur = Math.round(Math.min(needDur, media.duration - s.trimStart) * 10) / 10;
              log('ok', 'scene ' + (i + 1) + ' trimmed to ' + (s.trimDur).toFixed(1) + 's' + (uses ? ' (moment ' + (uses + 1) + ' of the same clip for visual consistency)' : ''));
            } else {
              s.imgDur = Math.round(needDur * 10) / 10;
              log('ok', 'scene ' + (i + 1) + ' set to ' + s.imgDur.toFixed(1) + 's');
            }
          } else {
            s.media = null;
            log('warn', 'scene ' + (i + 1) + ': nothing found anywhere - using styled placeholder');
          }
          setProg(0.3 + 0.45 * ((i + 1) / scenes.length));
          await tick();
        }

        log('step', 'loading and preparing clips...');
        const eng = App.engine;
        const scenesList = project.scenes;
        for (let i = 0; i < scenesList.length; i++) {
          if (this.isCancelled()) throw new Error('CANCELLED');
          await eng.prepareScene(scenesList[i]);
          setProg(0.75 + 0.2 * ((i + 1) / scenesList.length));
        }

        try {
          if (this.isCancelled()) throw new Error('CANCELLED');
          log('step', 'AI editor is reviewing pacing...');
          await tick();
          const summary = scenesList.map((s, i) => {
            const vo = App.state.voBuffers[s.id];
            return JSON.stringify({
              i: i,
              words: s.text.split(/\s+/).length,
              voLen: vo ? Number(vo.duration.toFixed(2)) : 0,
              currentDur: Number(App.sceneBaseDur(s).toFixed(2)),
              visual: s.media ? s.media.type + ':' + (s.media.source || '') : 'placeholder',
              mood: s.mood || ''
            });
          }).join('\n');
          const plan = await App.llmEditPlan(summary, msg => {
            log('step', 'AI editor via ' + msg);
          });
          let appliedCount = 0;
          for (const p of plan.scenes || []) {
            const idx = Math.round(Number(p.i));
            if (!(idx >= 0 && idx < scenesList.length)) continue;
            const s = scenesList[idx];
            const vo = App.state.voBuffers[s.id];
            const voDur = vo ? vo.duration : 0;
            let target = Number(p.duration);
            if (!isFinite(target)) continue;
            target = U.clamp(target, Math.max(1.8, voDur + 0.35), 30);
            if (s.media && s.media.type === 'video') {
              const mdur = (s.media.duration || 15) - (s.trimStart || 0);
              const sp = App.sceneSpeed(s);
              const srcTarget = Math.min(target * sp, Math.max(mdur, 2.5));
              s.trimDur = Math.round(srcTarget * 10) / 10;
            } else {
              s.imgDur = Math.round(target * 10) / 10;
            }
            if (p.transition === 'cut' || p.transition === 'fade') {
              s.transition = p.transition;
            }
            appliedCount++;
            log('ok', 'scene ' + (idx + 1) + ': ' + target.toFixed(1) + 's, ' + (s.transition || 'fade'));
          }
          if (!appliedCount) {
            log('warn', 'AI editor made no valid changes - keeping automatic timing');
          } else {
            log('ok', 'AI editor adjusted ' + appliedCount + '/' + scenesList.length + ' scenes');
          }
        } catch (e) {
          if (String(e.message).includes('CANCELLED')) throw e;
          log('warn', 'AI editor skipped (' + String(e.message || e).slice(0, 70) + ')');
        }
        setProg(0.97);

        const tl = App.timeline();
        log('ok', 'final cut assembled: ' + scenesList.length + ' scenes, ' + U.fmtTime(tl.total) + ' total');
        setProg(1);
        return true;
      } catch (e) {
        if (String(e.message || e).includes('CANCELLED')) {
          log('warn', 'cancelled');
          return false;
        }
        log('err', 'generation failed: ' + (e.message || e));
        throw e;
      }
    }
  };

  function tick() { return new Promise(r => setTimeout(r, 15)); }
})();
