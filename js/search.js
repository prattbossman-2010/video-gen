(function () {
  const App = window.App;
  const S = App.utils;

  async function fetchJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  const openverseImages = async (q) => {
    const d = await fetchJSON('https://api.openverse.org/v1/images/?format=json&page_size=24&q=' + encodeURIComponent(q));
    return (d.results || []).map(r => ({
      kind: 'image',
      url: r.url,
      thumb: r.thumbnail || r.url,
      title: r.title || '',
      w: r.width, h: r.height,
      credit: (r.creator || 'unknown') + ' / Openverse (' + (r.license || '') + ')',
      source: 'Openverse'
    })).filter(x => x.url);
  };

  const wikimediaImages = async (q) => {
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
      '&generator=search&gsrnamespace=6&gsrlimit=20' +
      '&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap') +
      '&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=360';
    const d = await fetchJSON(url);
    const pages = (d.query && d.query.pages) || {};
    return Object.values(pages).map(p => {
      const ii = p.imageinfo && p.imageinfo[0];
      if (!ii) return null;
      let credit = 'Wikimedia Commons';
      try { credit = (ii.extmetadata && ii.extmetadata.Artist ? strip(ii.extmetadata.Artist.value) : '') + ' / Wikimedia Commons'; } catch (e) {}
      return { kind: 'image', url: ii.url, thumb: ii.thumburl || ii.url, title: p.title || '', w: ii.width, h: ii.height, credit: credit, source: 'Wikimedia' };
    }).filter(Boolean);
  };

  function strip(html) {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return d.textContent.trim() || 'unknown';
  }

  const commonsVideos = async (q) => {
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
      '&generator=search&gsrnamespace=6&gsrlimit=24' +
      '&gsrsearch=' + encodeURIComponent(q + ' filetype:video') +
      '&prop=imageinfo&iiprop=url|size';
    const d = await fetchJSON(url);
    const pages = (d.query && d.query.pages) || {};
    return Object.values(pages).map(p => {
      const ii = p.imageinfo && p.imageinfo[0];
      if (!ii) return null;
      const u = ii.url || '';
      if (!/\.(webm|mp4)$/i.test(u)) return null;
      return { kind: 'video', url: u, thumb: '', title: p.title || '', w: ii.width, h: ii.height, credit: 'Wikimedia Commons', source: 'Wikimedia' };
    }).filter(Boolean);
  };

  const pexelsPhotos = async (q) => {
    const key = (App.state.project.keys.pexels || '').trim();
    if (!key) return [];
    const d = await fetchJSON('https://api.pexels.com/v1/search?per_page=24&query=' + encodeURIComponent(q), { headers: { Authorization: key } });
    return (d.photos || []).map(p => ({
      kind: 'image',
      url: p.src.original,
      thumb: p.src.medium || p.src.small,
      title: p.alt || '',
      w: p.width, h: p.height,
      credit: (p.photographer || 'unknown') + ' / Pexels',
      source: 'Pexels'
    }));
  };

  function pickVideoFile(files) {
    const mp4s = (files || []).filter(f => f.file_type === 'video/mp4' && f.width);
    mp4s.sort((a, b) => b.width - a.width);
    return mp4s.find(f => f.width <= 1920) || mp4s[mp4s.length - 1] || (files || [])[0];
  }

  const pexelsVideos = async (q) => {
    const key = (App.state.project.keys.pexels || '').trim();
    if (!key) return [];
    const d = await fetchJSON('https://api.pexels.com/videos/search?per_page=15&query=' + encodeURIComponent(q), { headers: { Authorization: key } });
    return (d.videos || []).map(v => {
      const f = pickVideoFile(v.video_files);
      if (!f) return null;
      return { kind: 'video', url: f.link, thumb: v.image, w: f.width, h: f.height, duration: v.duration, credit: (v.user && v.user.name) + ' / Pexels', source: 'Pexels' };
    }).filter(Boolean);
  };

  const pixabayImages = async (q) => {
    const key = (App.state.project.keys.pixabay || '').trim();
    if (!key) return [];
    const d = await fetchJSON('https://pixabay.com/api/?safesearch=true&per_page=24&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key));
    return (d.hits || []).map(h => ({
      kind: 'image',
      url: h.largeImageURL,
      thumb: h.previewURL,
      title: h.tags || '',
      w: h.imageWidth, h: h.imageHeight,
      credit: 'Pixabay contributor / Pixabay',
      source: 'Pixabay'
    }));
  };

  function parseDur(v) {
    if (!v) return 0;
    v = String(v);
    if (v.indexOf(':') >= 0) {
      const p = v.split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    }
    return parseFloat(v) || 0;
  }

  const archiveVideos = async (q) => {
    const tight = App.cleanQuery(q, 4) || q;
    const words = App.cleanQuery(q, 3).split(' ').filter(Boolean);
    const w = words.length ? words.join(' AND ') : tight;
    const variants = [
      '(title:(' + w + ' OR ' + words.concat(['gameplay', 'playthrough', 'longplay']).join(' AND ') + ')) AND mediatype:(movies)',
      '(title:(' + w + ') OR description:(' + w + ')) AND mediatype:(movies)',
      'title:("' + tight + '") AND mediatype:(movies)'
    ].filter(Boolean);

    let docs = [];
    for (const v of variants) {
      try {
        const d = await fetchJSON('https://archive.org/advancedsearch.php?q=' + encodeURIComponent(v) +
          '&fl%5B%5D=identifier&fl%5B%5D=title&rows=16&page=1&sort%5B%5D=-downloads&output=json');
        docs = ((d.response && d.response.docs) || []);
        if (docs.length) break;
      } catch (e) {}
    }
    docs = docs.slice(0, 8);
    const out = [];
    for (const doc of docs) {
      try {
        const md = await fetchJSON('https://archive.org/metadata/' + encodeURIComponent(doc.identifier));
        let best = null;
        for (const f of md.files || []) {
          const name = (f.name || '').toLowerCase();
          if (!/\.(mp4|m4v)$/.test(name)) continue;
          const sizeMB = parseInt(f.size || '0', 10) / 1048576;
          if (sizeMB > 250) continue;
          const dur = parseDur(f.length);
          if (dur && dur < 3) continue;
          if (!best || Math.abs(sizeMB - 40) < Math.abs(best.sizeMB - 40)) best = { name: f.name, sizeMB: sizeMB };
        }
        if (best) {
          out.push({
            kind: 'video',
            url: 'https://archive.org/download/' + encodeURIComponent(doc.identifier) + '/' + encodeURIComponent(best.name),
            thumb: 'https://archive.org/services/img/' + encodeURIComponent(doc.identifier),
            title: String(doc.title || doc.identifier || ''),
            w: null, h: null,
            credit: 'Internet Archive / ' + doc.identifier,
            source: 'Archive'
          });
        }
      } catch (e) {}
    }
    return out;
  };

  const bingVideos = async (q) => {
    if (!App.helper.available) return [];
    const d = await fetchJSON(App.helper.base + '/vsearch?q=' + encodeURIComponent(q));
    const items = (d.results || []).map(r => ({
      kind: 'video',
      url: r.url,
      thumb: r.thumb,
      title: r.title || '',
      w: null, h: null,
      duration: r.duration || null,
      credit: (r.source || 'Web') + ' via web search',
      source: r.source || 'Web'
    }));
    return relevantOnly(q, items);
  };

  function relevantOnly(q, items) {
    const words = q.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    if (!words.length) return items;
    const hits = items.filter(r => {
      const hay = ((r.title || '') + ' ' + r.url).toLowerCase();
      return words.some(w => hay.includes(w));
    });
    return hits.length >= 2 ? hits : items;
  }

  const bingImages = async (q) => {
    if (!App.helper.available) return [];
    const d = await fetchJSON(App.helper.base + '/isearch?q=' + encodeURIComponent(q));
    const items = (d.results || []).map(r => ({
      kind: 'image',
      url: r.url,
      thumb: r.thumb,
      title: r.title || '',
      w: r.width || null, h: r.height || null,
      credit: 'Found on the open web',
      source: 'Web'
    }));
    return relevantOnly(q, items);
  };

  const SOURCES = {
    image: [
      ['Web', bingImages],
      ['Openverse', openverseImages],
      ['Wikimedia', wikimediaImages],
      ['Pexels', pexelsPhotos],
      ['Pixabay', pixabayImages]
    ],
    video: [
      ['Archive', archiveVideos],
      ['Web', bingVideos],
      ['Pexels', pexelsVideos],
      ['Wikimedia', commonsVideos]
    ]
  };

  App.searchMedia = async function (query, kind, onEach) {
    const sources = SOURCES[kind] || [];
    let done = 0;
    const tasks = sources.map(async ([name, fn]) => {
      try {
        const items = await fn(query);
        onEach(name, items, null);
        return items.length;
      } catch (e) {
        onEach(name, [], e.message || String(e));
        return 0;
      } finally {
        done++;
      }
    });
    await Promise.all(tasks);
  };

  App.probeImage = function (url) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const to = setTimeout(() => resolve({ ok: false }), 15000);
      img.onload = () => { clearTimeout(to); resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight, safe: true }); };
      img.onerror = () => { clearTimeout(to); resolve({ ok: false }); };
      img.src = url;
    });
  };

  App.probeImageFallback = function (url) {
    return new Promise(resolve => {
      const proxied = S.weserv(url, 1600);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const to = setTimeout(() => resolve({ ok: false, safe: false }), 20000);
      img.onload = () => { clearTimeout(to); resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight, safe: true, finalUrl: proxied }); };
      img.onerror = () => { clearTimeout(to); resolve({ ok: false, safe: false }); };
      img.src = proxied;
    });
  };

  App.probeVideo = function (url, timeoutMs) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true;
      v.preload = 'metadata';
      v.playsInline = true;
      const finish = (res) => { clearTimeout(to); resolve(res); };
      const to = setTimeout(() => finish({ ok: false }), timeoutMs || 20000);
      v.onloadeddata = () => finish({
        ok: true,
        duration: v.duration,
        w: v.videoWidth,
        h: v.videoHeight,
        safe: true
      });
      v.onerror = () => finish({ ok: false });
      v.src = url;
    });
  };

  App.probeVideoUnsafe = function (url) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'metadata';
      v.playsInline = true;
      const to = setTimeout(() => resolve({ ok: false }), 20000);
      v.onloadeddata = () => { clearTimeout(to); resolve({ ok: true, duration: v.duration, w: v.videoWidth, h: v.videoHeight, safe: false }); };
      v.onerror = () => { clearTimeout(to); resolve({ ok: false }); };
      v.src = url;
    });
  };

  App.dmTitleQueries = async function (q) {
    try {
      const d = await fetchJSON('https://api.dailymotion.com/videos?search=' + encodeURIComponent(q) +
        '&fields=title,duration&limit=8&sort=relevance');
      return (d.list || []).map(v => String(v.title || '')
        .toLowerCase()
        .replace(/\b(4k|hd|1080p|720p|shorts?|video|clip|full|free|stock|footage|relaxation|asmr|ep\d+|part\s*\d+)\b/gi, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ').trim())
        .filter(t => t.length >= 8 && t.split(' ').length <= 10 && t.split(' ').length >= 2)
        .slice(0, 4);
    } catch (e) {
      return [];
    }
  };

  App.guessKindFromUrl = function (u) {
    if (/\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(u)) return 'video';
    if (/\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i.test(u)) return 'image';
    return null;
  };

  App.helper = {
    base: 'http://127.0.0.1:8737',
    available: false,
    async probe() {
      try {
        const r = await fetch(this.base + '/ping', { signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined });
        if (!r.ok) return false;
        const d = await r.json();
        this.available = !!(d && d.ok);
      } catch (e) {
        this.available = false;
      }
      return this.available;
    },
    async fetchBlob(url, onProgress) {
      const r = await fetch(this.base + '/fetch?url=' + encodeURIComponent(url));
      if (!r.ok) throw new Error('fetcher HTTP ' + r.status);
      const len = parseInt(r.headers.get('X-Original-Length') || '0', 10);
      if (!r.body) return await r.blob();
      const reader = r.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (onProgress && len) onProgress(got / len);
      }
      return new Blob(parts, { type: r.headers.get('Content-Type') || 'application/octet-stream' });
    },
    async extractPage(pageUrl) {
      const r = await fetch(this.base + '/extract?url=' + encodeURIComponent(pageUrl));
      if (!r.ok) throw new Error('extract HTTP ' + r.status);
      return r.json();
    },
    mediaProxyUrl(url) {
      return this.base + '/fetch?url=' + encodeURIComponent(url);
    }
  };
})();
