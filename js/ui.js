(function () {
  const App = window.App;
  const U = App.utils;
  const $ = id => document.getElementById(id);

  let engine = null;
  let searchResults = [];

  function toast(msg, type) {
    const d = document.createElement('div');
    d.className = 'toast ' + (type || '');
    d.textContent = msg;
    $('toasts').appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .4s'; }, 4200);
    setTimeout(() => d.remove(), 4800);
  }
  App.toast = toast;

  function show(sectionId) {
    ['stepInput', 'stepProgress', 'stepPreview'].forEach(id => {
      $(id).hidden = id !== sectionId;
    });
    window.scrollTo({ top: 0 });
  }

  function populateVoices() {
    const sel = $('selVoice');
    sel.innerHTML = '';
    App.TTS_VOICES.forEach(g => {
      const og = document.createElement('optgroup');
      og.label = g.group;
      g.items.forEach(([val, label]) => {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = label;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = 'Brian';
  }

  function selectedScene() {
    return App.state.project.scenes.find(s => s.id === App.state.advSceneId) || null;
  }

  function startGeneration() {
    const script = $('scriptInput').value.trim();
    if (!script) { toast('Type or paste your script first', 'error'); return; }

    App.state.project = {
      meta: { title: 'My Video', aspect: $('aspectSel').value, res: $('resSel').value, fps: 30 },
      scenes: [],
      music: { name: '', volume: 0.15 },
      keys: App.state.project.keys || { pexels: '', pixabay: '' }
    };
    App.state.voBuffers = {};
    engine.prepared = {};
    engine.stopAudioNodes();
    engine.pauseVideos();
    engine.playing = false;

    show('stepProgress');
    $('logList').innerHTML = '';
    $('genProgBar').style.width = '2%';
    $('btnGenerate').disabled = true;
    $('btnCancelGen').disabled = false;

    App.agent.run({
      script: script,
      hints: $('styleHints').value.trim(),
      aspect: $('aspectSel').value,
      res: $('resSel').value,
      voice: $('selVoice').value
    }, {
      log: (cls, msg) => {
        const li = document.createElement('li');
        li.className = cls;
        li.textContent = msg;
        $('logList').appendChild(li);
        $('logList').scrollTop = $('logList').scrollHeight;
      },
      progress: p => {
        $('genProgBar').style.width = Math.round(p * 100) + '%';
      },
      onScriptEnhanced: t => {
        $('scriptInput').value = t;
      }
    }).then(ok => {
      $('btnGenerate').disabled = false;
      if (ok) {
        renderAdvScenes();
        renderSceneBar();
        engine.seekTo(0);
        show('stepPreview');
        toast('Video ready! Press play to preview.', 'ok');
      } else {
        show('stepInput');
      }
    }).catch(e => {
      $('btnGenerate').disabled = false;
      toast('Generation failed: ' + (e.message || e), 'error');
      show('stepInput');
    });
  }

  function cancelGeneration() {
    App.agent.stop();
    $('btnCancelGen').disabled = true;
  }

  function updateTimeUI(t, total, playing) {
    $('scrubber').max = String(Math.max(0.1, total));
    $('scrubber').value = String(t);
    $('timeLabel').textContent = U.fmtTime(t) + ' / ' + U.fmtTime(total);
    $('btnPlay').innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
    const tl = App.timeline();
    const segs = $('sceneBar').children;
    tl.entries.forEach((e, i) => {
      const seg = segs[i];
      if (!seg) return;
      const active = t >= e.start && t < e.end;
      seg.classList.toggle('active', active);
      seg.querySelector('.fill').style.width = active ? ((t - e.start) / e.dur * 100) + '%' : (t >= e.end ? '100%' : '0%');
    });
  }

  function renderSceneBar() {
    const bar = $('sceneBar');
    bar.innerHTML = '';
    App.timeline().entries.forEach((e, i) => {
      const seg = document.createElement('div');
      seg.className = 'scene-seg';
      seg.style.flex = String(Math.max(0.6, e.dur));
      seg.title = 'Scene ' + (i + 1) + ' (' + e.dur.toFixed(1) + 's)';
      seg.innerHTML = '<div class="fill"></div>';
      seg.addEventListener('click', () => engine.seekTo(e.start + 0.01));
      bar.appendChild(seg);
    });
  }

  function renderAdvScenes() {
    const wrap = $('advScenes');
    wrap.innerHTML = '';
    App.state.project.scenes.forEach((s, i) => {
      const chip = document.createElement('div');
      chip.className = 'scene-chip' + (s.id === App.state.advSceneId ? ' active' : '');
      let thumbHtml = '<div class="thumb-mini" style="display:flex;align-items:center;justify-content:center;font-size:10px;color:#8a97a8">none</div>';
      if (s.media && s.media.thumb) thumbHtml = '<img class="thumb-mini" src="' + U.esc(U.thumbProxy(s.media.thumb)) + '" alt="">';
      else if (s.media) thumbHtml = '<div class="thumb-mini" style="display:flex;align-items:center;justify-content:center;font-size:14px">' + (s.media.type === 'video' ? '&#9654;' : '&#128444;') + '</div>';
      const e = App.timeline().entries.find(x => x.scene.id === s.id);
      chip.innerHTML =
        '<span class="num">' + (i + 1) + '</span>' + thumbHtml +
        '<span class="txt">' + U.esc(s.text || '(empty)') + '</span>' +
        '<span class="meta">' + (e ? Math.round(e.dur) : '?') + 's' + (App.state.voBuffers[s.id] ? ' · vo' : '') + (s.media && s.media.safe === false ? ' · blocked' : '') + '</span>';
      chip.addEventListener('click', () => selectAdvScene(s.id));
      wrap.appendChild(chip);
    });
  }

  function selectAdvScene(id) {
    App.state.advSceneId = id;
    renderAdvScenes();
    renderAdvEditor();
  }

  function renderAdvEditor() {
    const s = selectedScene();
    $('advEditor').hidden = !s;
    if (!s) return;
    $('edText').value = s.text || '';
    $('edKeywords').value = (s.keywords || []).join(', ');
    $('cbOverlay').checked = s.overlay !== false;
    $('selOverlayPos').value = s.overlayPos || 'bottom';
    $('selTransition').value = s.transition || '';
    const fx = s.effects || {};
    $('selFilter').value = fx.filter || '';
    $('rgSpeed').value = String(fx.speed || 1);
    $('lblSpeed').textContent = Number(fx.speed || 1).toFixed(2) + 'x';
    renderMediaInfo();
    setupTrimLimits(s);
    $('voStatus').textContent = App.state.voBuffers[s.id]
      ? 'Voiceover ready (' + App.state.voBuffers[s.id].duration.toFixed(1) + 's)'
      : 'No voiceover yet.';
  }

  function renderMediaInfo() {
    const s = selectedScene();
    const box = $('mediaInfo');
    if (!s) return;
    if (!s.media) {
      box.innerHTML = '<span class="muted">No visual — styled placeholder is used.</span>';
      $('trimBox').hidden = true;
      return;
    }
    const m = s.media;
    const safeTxt = m.safe == null ? '' :
      (m.safe ? '<span class="badge-ok">export OK</span>' : '<span class="badge-warn">preview only - source blocks recording</span>');
    box.innerHTML =
      '<b>' + m.type + '</b> from ' + U.esc(m.source || 'URL') +
      (m.w ? ' · ' + m.w + 'x' + m.h : '') +
      (m.duration ? ' · source ' + m.duration.toFixed(1) + 's' : '') +
      (safeTxt ? ' · ' + safeTxt : '') +
      '<br><span class="muted">' + U.esc(m.credit || '') + '</span>';
    $('trimBox').hidden = false;
    setupTrimLimits(s);
  }

  function setupTrimLimits(s) {
    const rgStart = $('rgTrimStart'), rgDur = $('rgDur');
    if (!s.media || s.media.type !== 'video') {
      rgStart.parentElement.hidden = true;
      rgDur.min = 1; rgDur.max = 60; rgDur.step = 0.1;
      rgDur.value = String(s.imgDur || 5);
      $('lblTrimDur').textContent = 'Image duration: ' + (s.imgDur || 5).toFixed(1) + 's';
      return;
    }
    rgStart.parentElement.hidden = false;
    const mdur = s.media.duration || 15;
    rgStart.max = String(Math.max(0, mdur - 0.5));
    rgStart.value = String(s.trimStart || 0);
    const maxD = Math.min(120, mdur - (s.trimStart || 0));
    rgDur.max = String(Math.max(1, maxD));
    rgDur.value = String(Math.min(s.trimDur || Math.min(mdur, 15), maxD));
    $('lblTrimStart').textContent = 'Clip start: ' + (s.trimStart || 0).toFixed(1) + 's';
    $('lblTrimDur').textContent = 'Clip length: ' + parseFloat(rgDur.value).toFixed(1) + 's';
  }

  function afterSceneChange(reprepare) {
    renderAdvScenes();
    renderSceneBar();
    App.saveLocal();
    const p = reprepare ? engine.prepareScene(selectedScene()).then(() => { renderMediaInfo(); }) : Promise.resolve();
    p.then(() => { engine.seekTo(engine.t); });
  }

  async function doSearch(kindOverride) {
    const kind = kindOverride || App.state.searchKind;
    const q = $('edKeywords').value.trim();
    const status = $('searchStatus');
    const grid = $('resultsGrid');
    if (!q) { toast('Type some keywords first', 'error'); return; }
    status.textContent = 'Searching sources...';
    grid.innerHTML = '';
    searchResults = [];
    await App.searchMedia(q, kind, (name, items, err) => {
      if (err) {
        if (name === 'Pexels') status.textContent = 'Pexels failed (' + err + '). Add a free key in Help for more results.';
        else if (name === 'Pixabay') status.textContent = 'Pixabay unavailable from the browser.';
        else toast(name + ' failed: ' + err, 'error');
      }
      items.forEach(it => searchResults.push(it));
      renderResults(kind);
    });
    const n = searchResults.filter(x => x.kind === kind).length;
    status.textContent = n ? n + ' results found' : 'No results found.';
  }

  function renderResults(kind) {
    const grid = $('resultsGrid');
    grid.innerHTML = '';
    searchResults.filter(x => x.kind === kind).slice(0, 48).forEach(it => {
      const card = document.createElement('div');
      card.className = 'result-card';
      if (it.thumb) {
        card.innerHTML = '<img loading="lazy" src="' + U.esc(U.thumbProxy(it.thumb)) + '" alt=""><span class="tag">' + U.esc((it.source || '')) + '</span>';
      } else {
        card.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#1d242f;font-size:22px">&#127909;</div><span class="tag">' + U.esc(it.source || '') + '</span>';
      }
      card.title = it.title ? it.title + '\n' + it.url : it.url;
      card.addEventListener('click', () => assignMedia(it));
      grid.appendChild(card);
    });
  }

  async function assignMedia(item) {
    const s = selectedScene();
    if (!s) return;
    s.media = {
      type: item.kind,
      url: item.url,
      thumb: item.thumb,
      w: item.w, h: item.h,
      duration: item.duration || null,
      credit: item.credit,
      source: item.source,
      safe: null
    };
    s.trimStart = 0;
    s.trimDur = null;
    delete engine.prepared[s.id];
    renderAdvEditor();
    afterSceneChange(true);
    toast('Visual updated', 'ok');
  }

  async function useCustomUrl() {
    const raw = $('edCustomUrl').value.trim();
    if (!/^https?:\/\//i.test(raw)) { toast('Enter a full http(s) URL', 'error'); return; }
    const btn = $('btnUseUrl');
    btn.disabled = true;
    try {
      let url = raw;

      if (App.helper.available) {
        const looksLikePage = !App.guessKindFromUrl(raw);
        if (looksLikePage) {
          toast('Reading page like a browser...');
          const ex = await App.helper.extractPage(raw);
          if (ex.results && ex.results.length) {
            url = ex.results[0];
            toast('Found video on that page', 'ok');
          }
        }
        const blob = await App.helper.fetchBlob(url);
        url = URL.createObjectURL(blob);
        const kind = blob.type.startsWith('image/') ? 'image' : 'video';
        assignMedia({ kind: kind, url: url, thumb: '', credit: 'downloaded via helper', source: 'Web download', safe: true });
        $('edCustomUrl').value = '';
        return;
      }

      const kind = App.guessKindFromUrl(url);
      if (!kind) {
        throw new Error('Not a direct media link. Run fetcher.py to unlock webpage URLs.');
      }
      const probe = kind === 'video' ? await App.probeVideo(url) : await App.probeImage(url);
      if (!probe.ok && kind === 'video') {
        toast('That host blocks direct access. Run fetcher.py (see Help) to unlock it.', 'error');
        return;
      }
      if (!probe.ok && kind === 'image') {
        const r2 = await App.probeImageFallback(url);
        if (!r2.ok) { toast('Could not load that image', 'error'); return; }
        assignMedia({ kind: kind, url: r2.finalUrl, thumb: url, credit: 'custom URL', source: 'URL', safe: true });
        $('edCustomUrl').value = '';
        return;
      }
      assignMedia({
        kind: kind, url: url, thumb: kind === 'image' ? url : '',
        w: probe.w, h: probe.h, duration: probe.duration || null,
        credit: 'custom URL', source: 'URL', safe: probe.safe
      });
      $('edCustomUrl').value = '';
    } catch (e) {
      toast((e.message || e), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function generateVOForSelected(btn) {
    const s = selectedScene();
    if (!s) return;
    if (!s.text.trim()) { toast('Add narration text first', 'error'); return; }
    s.voVoice = $('selVoice').value;
    btn.disabled = true;
    $('voStatus').textContent = 'Synthesizing with ' + s.voVoice + '...';
    try {
      const buf = await App.generateVO(s.text, s.voVoice, msg => {
        $('voStatus').textContent = msg;
      });
      App.state.voBuffers[s.id] = buf;
      s.hasVO = true;
      $('voStatus').textContent = 'Voiceover ready (' + buf.duration.toFixed(1) + 's)';
      afterSceneChange(false);
      toast('Voiceover regenerated', 'ok');
    } catch (e) {
      $('voStatus').textContent = 'TTS failed';
      toast('Voiceover failed. Check internet connection.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function previewVO() {
    const s = selectedScene();
    if (!s || !s.text.trim()) { toast('Add narration text first', 'error'); return; }
    const btn = $('btnPreviewVO');
    btn.disabled = true;
    try {
      const buf = await App.generateVO(s.text, s.voVoice || $('selVoice').value, () => {});
      if (!window.__vgaAC) window.__vgaAC = new (window.AudioContext || window.webkitAudioContext)();
      const ac = window.__vgaAC;
      if (ac.state === 'suspended') await ac.resume();
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      src.start();
      src.onended = () => { btn.disabled = false; };
    } catch (e) {
      const u = App.speakLocally(s.text, s.voVoice || $('selVoice').value);
      if (u) {
        u.onend = () => { btn.disabled = false; };
        setTimeout(() => { btn.disabled = false; }, Math.min(30000, 2000 + s.text.length * 70));
        toast('Cloud voices unavailable - using device built-in voice', 'error');
      } else {
        btn.disabled = false;
        toast('Preview failed', 'error');
      }
    }
  }

  async function runExport() {
    if (!App.state.project.scenes.length) { toast('Nothing to export yet', 'error'); return; }
    const sup = App.checkExportSupport();
    if (!sup.supported) { toast('Recording not supported here: ' + sup.reason, 'error'); return; }
    const btn = $('btnExport');
    btn.disabled = true;
    $('progWrap').hidden = false;
    $('progBar').style.width = '0%';
    $('dlLink').hidden = true;
    const wasPlaying = engine.playing;
    if (wasPlaying) engine.pause();

    try {
      const speakOnly = App.state.project.scenes.filter(s => App.state.voSpeakOnly && App.state.voSpeakOnly[s.id]);
      let useTabAudio = false;
      if (speakOnly.length) {
        const canTab = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
        $('tabAudioRow').hidden = !canTab;
        useTabAudio = canTab && $('cbTabAudio').checked;
        if (!useTabAudio) {
          const hasMusic = !!engine.musicBuffer;
          const msg = speakOnly.length + ' scene(s) have no embedded voiceover (cloud voices unreachable).' +
            (hasMusic ? ' Your background music WILL be included.' : ' The export will have NO audio unless you:') +
            (hasMusic ? '' : '\n\n- add background music in step 1, or\n- keep "screen-share audio capture" ticked (Chrome/Edge), or\n- export anyway for a silent video.');
          if (!confirm(msg + '\n\nContinue?')) {
            btn.disabled = false;
            $('progWrap').hidden = true;
            return;
          }
        }
      }
      $('exportStatus').textContent = 'Checking clips...';
      const result = await App.exportVideo(engine, {
        useTabAudio: useTabAudio,
        onPrepare: (i, n) => {
          $('exportStatus').textContent = 'Loading media ' + i + '/' + n + '...';
          $('progBar').style.width = (n ? i / n * 20 : 20) + '%';
        },
        onUnsafeConfirm: async unsafeList => {
          return confirm(
            unsafeList.length + ' clip(s) cannot be recorded because their website blocks saving.\n\n' +
            'They will appear as black frames.\n\nContinue anyway?'
          );
        },
        onStart: () => {
          $('exportStatus').textContent = 'Recording in real time... keep this tab visible!';
        },
        onProgress: p => {
          $('progBar').style.width = (20 + p * 80).toFixed(1) + '%';
          if (p >= 0.99) $('exportStatus').textContent = 'Finalizing file...';
        }
      });
      const fname = (App.state.project.meta.title || 'video').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').toLowerCase() + '.' + result.ext;
      const dl = $('dlLink');
      dl.href = URL.createObjectURL(result.blob);
      dl.download = fname;
      dl.textContent = 'Save video (' + (result.blob.size / 1048576).toFixed(1) + ' MB)';
      dl.hidden = false;
      $('exportStatus').textContent = 'Done! Click the green button to save.';
      toast('Export complete', 'ok');
    } catch (e) {
      if (!String(e.message).includes('CANCELLED')) {
        $('exportStatus').textContent = 'Export failed: ' + (e.message || e);
        toast('Export failed', 'error');
      }
    } finally {
      btn.disabled = false;
      setTimeout(() => { $('progWrap').hidden = true; }, 1500);
    }
  }

  function applyFormat() {
    App.state.project.meta.aspect = $('aspectSel').value;
    App.state.project.meta.res = $('resSel').value;
    engine.setFormat($('aspectSel').value, $('resSel').value);
    engine.draw(engine.t);
    App.saveLocal();
  }

  function bindEvents() {
    $('btnGenerate').addEventListener('click', startGeneration);
    $('btnCancelGen').addEventListener('click', cancelGeneration);
    $('btnRegenerate').addEventListener('click', () => show('stepInput'));

    $('btnPlay').addEventListener('click', () => {
      if (engine.playing) engine.pause();
      else engine.play();
    });
    $('scrubber').addEventListener('input', e => engine.seekTo(parseFloat(e.target.value)));

    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault();
        if (engine.playing) engine.pause(); else engine.play();
      }
    });

    $('aspectSel').addEventListener('change', applyFormat);
    $('resSel').addEventListener('change', applyFormat);

    $('musicFile').addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        if (!window.__vgaAC) window.__vgaAC = new (window.AudioContext || window.webkitAudioContext)();
        const ac = window.__vgaAC;
        const ab = await f.arrayBuffer();
        engine.musicBuffer = await ac.decodeAudioData(ab);
        App.state.project.music.name = f.name;
        $('musicName').textContent = f.name + ' (' + engine.musicBuffer.duration.toFixed(0) + 's)';
        toast('Music loaded', 'ok');
      } catch (err) {
        toast('Could not decode that audio file', 'error');
      }
    });
    $('btnMusicClear').addEventListener('click', () => {
      engine.musicBuffer = null;
      App.state.project.music.name = '';
      $('musicName').textContent = '';
      $('musicFile').value = '';
    });
    $('rgMusicVol').addEventListener('input', e => {
      engine.musicGain.gain.value = parseInt(e.target.value, 10) / 100;
      App.state.project.music.volume = parseInt(e.target.value, 10) / 100;
      App.saveLocal();
    });

    $('btnExport').addEventListener('click', runExport);

    $('btnHelp').addEventListener('click', () => {
      $('keyOpenrouter').value = window.__llmCfg ? window.__llmCfg('openrouterKey') : '';
      $('keyZen').value = window.__llmCfg ? window.__llmCfg('zenKey') : '';
      $('keyPexels').value = App.state.project.keys.pexels || '';
      $('keyPixabay').value = App.state.project.keys.pixabay || '';
      $('helpModal').hidden = false;
    });
    $('btnCloseHelp').addEventListener('click', () => {
      try {
        localStorage.setItem('cfg_openrouterKey', $('keyOpenrouter').value.trim());
        localStorage.setItem('cfg_zenKey', $('keyZen').value.trim());
      } catch (e) {}
      App.state.project.keys.pexels = $('keyPexels').value.trim();
      App.state.project.keys.pixabay = $('keyPixabay').value.trim();
      App.saveLocal();
      $('helpModal').hidden = true;
      toast('Settings saved', 'ok');
    });

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        App.state.searchKind = tab.dataset.kind;
        if (searchResults.length) renderResults(App.state.searchKind);
      });
    });
    $('btnSearchMedia').addEventListener('click', () => doSearch());
    $('edKeywords').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    $('btnUseUrl').addEventListener('click', useCustomUrl);

    $('edText').addEventListener('input', () => {
      const s = selectedScene();
      if (s) {
        s.text = $('edText').value;
        App.saveLocal();
        renderAdvScenes();
        engine.draw(engine.t);
      }
    });
    $('cbOverlay').addEventListener('change', e => {
      const s = selectedScene();
      if (s) { s.overlay = e.target.checked; engine.draw(engine.t); App.saveLocal(); }
    });
    $('selOverlayPos').addEventListener('change', e => {
      const s = selectedScene();
      if (s) { s.overlayPos = e.target.value; engine.draw(engine.t); App.saveLocal(); }
    });
    $('selTransition').addEventListener('change', e => {
      const s = selectedScene();
      if (s) { s.transition = e.target.value; App.saveLocal(); }
    });
    $('selFilter').addEventListener('change', e => {
      const s = selectedScene();
      if (s) {
        s.effects = Object.assign({ speed: 1 }, s.effects, { filter: e.target.value });
        engine.draw(engine.t);
        App.saveLocal();
      }
    });
    $('rgSpeed').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      const s = selectedScene();
      if (s) {
        s.effects = Object.assign({ filter: '' }, s.effects, { speed: v });
        $('lblSpeed').textContent = v.toFixed(2) + 'x';
        renderSceneBar();
        App.saveLocal();
        engine.draw(engine.t);
      }
    });
    $('rgTrimStart').addEventListener('input', e => {
      const s = selectedScene();
      if (!s || !s.media || s.media.type !== 'video') return;
      s.trimStart = parseFloat(e.target.value);
      $('lblTrimStart').textContent = 'Clip start: ' + s.trimStart.toFixed(1) + 's';
      setupTrimLimits(s);
      afterSceneChange(true);
    });
    $('rgDur').addEventListener('input', e => {
      const s = selectedScene();
      if (!s) return;
      if (s.media && s.media.type === 'video') {
        s.trimDur = parseFloat(e.target.value);
        $('lblTrimDur').textContent = 'Clip length: ' + s.trimDur.toFixed(1) + 's';
      } else {
        s.imgDur = parseFloat(e.target.value);
        $('lblTrimDur').textContent = 'Image duration: ' + s.imgDur.toFixed(1) + 's';
      }
      renderSceneBar();
      App.saveLocal();
      engine.draw(engine.t);
    });

    $('btnGenVO').addEventListener('click', e => generateVOForSelected(e.target));
    $('btnPreviewVO').addEventListener('click', previewVO);

    window.addEventListener('beforeunload', e => {
      if (engine.playing) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  async function init() {
    if (!App.loadLocal()) App.state.project = App.sampleProject();

    engine = new App.Engine($('stage'));
    App.engine = engine;
    engine.setFormat(App.state.project.meta.aspect || '16:9', App.state.project.meta.res || '720p');
    engine.onTick = (t, total, playing) => updateTimeUI(t, total, playing);

    $('aspectSel').value = App.state.project.meta.aspect || '16:9';
    $('resSel').value = App.state.project.meta.res || '720p';
    $('keyOpenrouter').value = window.__llmCfg ? window.__llmCfg('openrouterKey') : '';
    $('keyZen').value = window.__llmCfg ? window.__llmCfg('zenKey') : '';
    $('keyPexels').value = App.state.project.keys.pexels || '';
    $('keyPixabay').value = App.state.project.keys.pixabay || '';

    populateVoices();
    bindEvents();
    engine.draw(0);

    const unlocked = await App.helper.probe();
    if (unlocked) {
      await App.loadEnvViaHelper();
      $('helperPill').hidden = false;
      toast('Browser mode active - full-web HD video search enabled', 'ok');
    }
    let helperConnected = unlocked;
    setInterval(async () => {
      const ok = await App.helper.probe().catch(() => false);
      if (ok && !helperConnected) {
        helperConnected = true;
        await App.loadEnvViaHelper();
        $('helperPill').hidden = false;
        toast('Helper connected - full-web HD video search enabled', 'ok');
      } else if (!ok && helperConnected) {
        helperConnected = false;
        $('helperPill').hidden = true;
      }
    }, 7000);

    if (!App.checkExportSupport().supported) {
      toast('This browser cannot record video. Chrome, Edge or Firefox recommended.', 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
