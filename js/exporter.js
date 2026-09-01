(function () {
  const App = window.App;

  function pickMime() {
    const candidates = [
      ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'mp4'],
      ['video/mp4', 'mp4'],
      ['video/webm;codecs=vp9,opus', 'webm'],
      ['video/webm;codecs=vp8,opus', 'webm'],
      ['video/webm', 'webm']
    ];
    if (typeof MediaRecorder === 'undefined') return null;
    for (const [m, ext] of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext: ext };
      } catch (e) {}
    }
    return null;
  }

  App.checkExportSupport = function () {
    const okCanvas = typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype.captureStream;
    const okRec = typeof MediaRecorder !== 'undefined';
    return { supported: !!(okCanvas && okRec && pickMime()), reason: !okRec ? 'MediaRecorder not supported' : (!okCanvas ? 'canvas capture not supported' : '') };
  };

  App.unsafeScenes = function () {
    return App.state.project.scenes.filter(s => {
      const p = App.engine && App.engine.prepared[s.id];
      return s.media && p && !p.safe;
    }).map(s => s);
  };

  App.exportVideo = async function (engine, callbacks) {
    const cb = callbacks || {};
    const sup = pickMime();
    if (!sup) throw new Error('This browser cannot record video. Try Chrome, Edge or Firefox.');

    await engine.prepareAll((i, n) => cb.onPrepare && cb.onPrepare(i, n));

    const unsafe = [];
    for (const s of App.state.project.scenes) {
      const p = engine.prepared[s.id];
      if (s.media && p && !p.safe && p.type !== 'ph') unsafe.push(s);
    }
    if (unsafe.length && !(cb.onUnsafeConfirm && await cb.onUnsafeConfirm(unsafe))) {
      throw new Error('EXPORT_CANCELLED');
    }

    let gdmStream = null;
    let audioTracks;
    if (cb.useTabAudio) {
      try {
        gdmStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
      } catch (e) {
        throw new Error('Screen-share was cancelled.');
      }
      const at = gdmStream.getAudioTracks();
      if (!at.length) {
        gdmStream.getTracks().forEach(t => t.stop());
        throw new Error('No audio was shared. Retry and tick "Also share tab audio" in the dialog.');
      }
      audioTracks = at;
      cb.onTabAudio && cb.onTabAudio();
    } else {
      audioTracks = engine.dest.stream.getAudioTracks();
    }

    const fps = App.state.project.meta.fps || 30;
    const W = engine.canvas.width;
    const bitrate = W >= 1800 ? 10000000 : 5000000;

    const vStream = engine.canvas.captureStream(fps);
    const mixed = new MediaStream([...vStream.getVideoTracks(), ...audioTracks]);

    let rec;
    try {
      rec = new MediaRecorder(mixed, { mimeType: sup.mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128000 });
    } catch (e) {
      rec = new MediaRecorder(mixed);
    }

    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

    const finished = new Promise(resolve => { rec.onstop = resolve; });

    rec.start(250);

    const endReached = new Promise(resolve => { engine.onEnd = resolve; });
    engine.seekTo(0);
    cb.onStart && cb.onStart();
    await engine.play();

    const monitor = setInterval(() => {
      const tl = App.timeline();
      cb.onProgress && cb.onProgress(Math.min(0.99, engine.t / Math.max(0.1, tl.total)));
    }, 200);

    await endReached;
    clearInterval(monitor);

    setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
    }, 400);

    await finished;
    vStream.getTracks().forEach(t => t.stop());
    if (gdmStream) gdmStream.getTracks().forEach(t => t.stop());
    else engine.dest.stream.getTracks().forEach(t => t.stop());

    const blob = new Blob(chunks, { type: sup.mime.split(';')[0] });
    cb.onProgress && cb.onProgress(1);
    return { blob: blob, ext: sup.ext };
  };
})();
