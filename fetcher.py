import html as html_mod
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8737
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
MAX_BYTES = 300 * 1024 * 1024

YTDLP_AVAILABLE = False
yt_dlp = None
FFMPEG_PATH = ""


def _ensure_ytdlp():
    global YTDLP_AVAILABLE, yt_dlp
    if YTDLP_AVAILABLE:
        return True
    try:
        import yt_dlp as _ydl
        yt_dlp = _ydl
        YTDLP_AVAILABLE = True
    except Exception:
        pass
    return YTDLP_AVAILABLE


def _ensure_ffmpeg():
    global FFMPEG_PATH
    if FFMPEG_PATH:
        return True
    try:
        import imageio_ffmpeg
        FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    return bool(FFMPEG_PATH)

YT_CACHE_DIR = os.path.join(tempfile.gettempdir(), "vga_yt")
_YT_CACHE_LOCK = threading.Lock()


def _yt_tmp_path(vid):
    return os.path.join(YT_CACHE_DIR, "yt_" + re.sub(r"[^\w\-]", "", vid) + ".mp4")


def _yt_download_cached(vid):
    if not _ensure_ytdlp():
        raise RuntimeError("yt-dlp not installed")
    _ensure_ffmpeg()
    out_path = _yt_tmp_path(vid)
    with _YT_CACHE_LOCK:
        if os.path.exists(out_path) and os.path.getsize(out_path) > 50000:
            return out_path
    os.makedirs(YT_CACHE_DIR, exist_ok=True)
    tmp_out = os.path.join(YT_CACHE_DIR, "dl_" + uuid.uuid4().hex[:8])
    if FFMPEG_PATH:
        fmt = "bv*[height<=720]+ba/b[height<=720]/b"
    else:
        fmt = "b[height<=480]/b"
    opts = {
        "format": fmt,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "outtmpl": tmp_out + ".%(ext)s",
        "max_filesize": 140 * 1024 * 1024,
        "socket_timeout": 25,
        "retries": 1,
    }
    if FFMPEG_PATH:
        opts["ffmpeg_location"] = FFMPEG_PATH
        opts["merge_output_format"] = "mp4"
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.extract_info("https://www.youtube.com/watch?v=" + vid, download=True)
    candidates = []
    try:
        candidates = [os.path.join(YT_CACHE_DIR, f)
                      for f in os.listdir(YT_CACHE_DIR)
                      if f.startswith(os.path.basename(tmp_out)) and os.path.isfile(os.path.join(YT_CACHE_DIR, f))]
    except OSError:
        pass
    src = max(candidates, key=os.path.getsize) if candidates else None
    if not src:
        raise RuntimeError("download produced no file")
    if os.path.getsize(src) > 140 * 1024 * 1024:
        os.remove(src)
        raise RuntimeError("file too large")
    shutil.move(src, out_path)
    return out_path


def _yt_prefetch(vids):
    def worker(v):
        try:
            _yt_download_cached(v)
            log("[youtube] prefetched %s" % v)
        except Exception as e:
            log("[youtube] prefetch failed %s: %s" % (v, str(e)[:60]))
    for v in vids[:2]:
        threading.Thread(target=worker, args=(v,), daemon=True).start()


def youtube_search(q, limit=6):
    if not _ensure_ytdlp():
        return []
    _ensure_ffmpeg()
    url = ("https://www.youtube.com/results?search_query=" + urllib.parse.quote(q)
           + "&sp=EgIQAQ%253D%253D")
    page, _ = fetch_text(url, 4 * 1024 * 1024)
    m = re.search(r"var ytInitialData\s*=\s*(\{.*?\})\s*;\s*</script>", page, re.S)
    if not m:
        m = re.search(r'window\["ytInitialData"\]\s*=\s*(\{.*?\})\s*;', page, re.S)
    if not m:
        log("[youtube] no ytInitialData found")
        return []
    try:
        data = json.loads(m.group(1))
    except Exception:
        return []

    renderers = []

    def walk(o):
        if isinstance(o, dict):
            if "videoRenderer" in o and isinstance(o["videoRenderer"], dict):
                renderers.append(o["videoRenderer"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    out = []
    ids_for_prefetch = []
    for vr in renderers:
        vid = str(vr.get("videoId") or "")
        if not vid or len(out) >= limit:
            continue
        title = ""
        try:
            title = html_mod.unescape(vr["title"]["runs"][0]["text"])[:120]
        except Exception:
            pass
        dur = parse_duration((vr.get("lengthText") or {}).get("simpleText"))
        out.append({
            "url": "http://127.0.0.1:%d/ytdl?id=%s" % (PORT, vid),
            "title": title,
            "thumb": ("https://i.ytimg.com/vi/%s/mqdefault.jpg" % vid),
            "duration": dur,
            "source": "YouTube",
        })
        ids_for_prefetch.append(vid)
    if out:
        _yt_prefetch([e["url"].split("id=")[-1] for e in out])
    return out


def fetch_text(url, limit=3 * 1024 * 1024):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    resp = urllib.request.urlopen(req, timeout=25)
    data = resp.read(limit)
    final_url = resp.geturl()
    resp.close()
    return data.decode("utf-8", "ignore"), final_url


def parse_attr_json(fragment):
    try:
        return json.loads(html_mod.unescape(html_mod.unescape(fragment)))
    except Exception:
        return None


def parse_duration(v):
    if not v:
        return 0.0
    v = str(v)
    if ":" in v:
        try:
            parts = [float(x) for x in v.split(":")]
            if len(parts) == 3:
                return parts[0] * 3600 + parts[1] * 60 + parts[2]
            if len(parts) == 2:
                return parts[0] * 60 + parts[1]
        except ValueError:
            return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


def pexels_scrape(q):
    page = fetch_text("https://www.pexels.com/search/videos/" + urllib.parse.quote(q) + "/")[0]
    found = {}
    for m in re.finditer(r'https://videos\.pexels\.com/video-files/(\d+)/([^"\']+\.mp4)', page):
        vid, fname = m.group(1), m.group(2)
        nums = re.findall(r"(\d{3,4})", fname)
        score = int(nums[0]) * int(nums[1]) if len(nums) >= 2 else 0
        if vid not in found or score > found[vid][0]:
            found[vid] = (score, "https://videos.pexels.com/video-files/%s/%s" % (vid, fname))
    out = []
    for vid, (_, url) in sorted(found.items(), key=lambda x: -x[1][0]):
        out.append({"url": url, "title": "", "thumb": "", "source": "Pexels"})
        if len(out) >= 12:
            break
    return out


def pixabay_scrape(q):
    page = fetch_text("https://pixabay.com/videos/search/" + urllib.parse.quote(q) + "/")[0]
    out = []
    seen = set()
    for m in re.finditer(r'(https://cdn\.pixabay\.com/video/[^"]+\.mp4)', page):
        url = m.group(1)
        key = re.sub(r"_\w+\.mp4$", "", url)
        if key in seen:
            continue
        seen.add(key)
        out.append({"url": url, "title": "", "thumb": "", "source": "Pixabay"})
        if len(out) >= 10:
            break
    return out


def mixkit_scrape(q):
    slug = urllib.parse.quote(q.replace(" ", "-"))
    page = fetch_text("https://mixkit.co/free-stock-video/" + slug + "/")[0]
    ids = []
    for m in re.finditer(r'https://assets\.mixkit\.co/videos/(\d+)/\d+-\d+\.mp4', page):
        if m.group(1) not in ids:
            ids.append(m.group(1))
    out = []
    for vid in ids[:8]:
        chosen = None
        for size in ("720", "360"):
            url = "https://assets.mixkit.co/videos/%s/%s-%s.mp4" % (vid, vid, size)
            try:
                req = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-1"})
                resp = urllib.request.urlopen(req, timeout=6)
                resp.read(2)
                resp.close()
                chosen = url
                break
            except Exception:
                continue
        if chosen:
            out.append({"url": chosen, "title": "", "thumb": "", "source": "Mixkit"})
    return out


def bing_videos(q):
    url = "https://www.bing.com/videos/search?q=" + urllib.parse.quote(q) + "&count=40"
    page, _ = fetch_text(url)
    out = []
    for m in re.finditer(r'vrhm="([^"]+)"', page):
        obj = parse_attr_json(m.group(1))
        if not isinstance(obj, dict):
            continue
        media = str(obj.get("murl") or "")
        title = html_mod.unescape(str(obj.get("t") or ""))[:120]
        thumb = ""
        for key in ("thu", "turl", "mthu", "imgurl", "thurl"):
            v = obj.get(key)
            if isinstance(v, str) and v.startswith("http"):
                thumb = v
                break
        if media.startswith("http") and re.search(r"\.(mp4|webm|mov)(\?|$)", media, re.I):
            if not any(x["url"] == media for x in out):
                out.append({"url": media, "title": title, "thumb": thumb,
                            "duration": parse_duration(obj.get("du"))})
    return out[:24]


def get_vqd(q):
    url = "https://duckduckgo.com/?q=" + urllib.parse.quote(q) + "&iax=images&ia=images"
    page, _ = fetch_text(url, 2 * 1024 * 1024)
    m = re.search(r"vqd=[\'\"]([\d-]+)[\'\"]", page)
    if not m:
        raise RuntimeError("no vqd token")
    return m.group(1)


def ddg_images(q):
    vqd = get_vqd(q)
    url = ("https://duckduckgo.com/i.js?l=us-en&o=json&q=" + urllib.parse.quote(q)
           + "&vqd=" + vqd + "&f=,,size:Large,,&p=1")
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://duckduckgo.com/",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    })
    resp = urllib.request.urlopen(req, timeout=25)
    d = json.loads(resp.read())
    resp.close()
    out = []
    for r in d.get("results", []):
        img = r.get("image") or ""
        if not img.startswith("http"):
            continue
        out.append({
            "url": img,
            "title": str(r.get("title") or "")[:120],
            "thumb": r.get("thumbnail") or "",
            "width": int(r.get("width") or 0),
            "height": int(r.get("height") or 0),
        })
        if len(out) >= 30:
            break
    return out


def log(msg):
    print(msg, flush=True)


def split_chunks(text, max_len):
    text = text.strip()
    if len(text) <= max_len:
        return [text] if text else []
    parts = re.split(r"(?<=[.!?])\s+", text)
    chunks = []
    buf = ""
    for p in parts:
        if len(buf) + len(p) + 1 <= max_len:
            buf = (buf + " " + p).strip()
        else:
            if buf:
                chunks.append(buf)
            while len(p) > max_len:
                cut = p.rfind(" ", 0, max_len)
                if cut < max_len // 2:
                    cut = max_len
                chunks.append(p[:cut].strip())
                p = p[cut:].strip()
            buf = p
    if buf:
        chunks.append(buf)
    return [c for c in chunks if c]


SAPI_PS_TEMPLATE = """
param([string]$TextPath, [string]$WavPath, [string]$Gender)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$g = [System.Speech.Synthesis.VoiceGender]::Male
if ($Gender -eq 'female') { $g = [System.Speech.Synthesis.VoiceGender]::Female }
$s.SelectVoiceByHints($g)
$text = [System.IO.File]::ReadAllText($TextPath)
$s.SetOutputToWaveFile($WavPath)
$s.Speak($text)
$s.Dispose()
"""


def sapi_tts(text, gender):
    tmpdir = tempfile.gettempdir()
    token = uuid.uuid4().hex[:10]
    txt_path = os.path.join(tmpdir, "vga_" + token + ".txt")
    wav_path = os.path.join(tmpdir, "vga_" + token + ".wav")
    ps_path = os.path.join(tmpdir, "vga_" + token + ".ps1")
    try:
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(text[:5000])
        with open(ps_path, "w", encoding="utf-8") as f:
            f.write(SAPI_PS_TEMPLATE)
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", ps_path, "-TextPath", txt_path, "-WavPath", wav_path,
             "-Gender", ("female" if gender == "female" else "male")],
            capture_output=True, timeout=90)
        if not os.path.exists(wav_path) or os.path.getsize(wav_path) < 200:
            err = proc.stderr.decode("utf-8", "ignore")[-180:]
            raise RuntimeError("sapi failed: " + (err or "no output"))
        with open(wav_path, "rb") as f:
            return f.read()
    finally:
        for p in (txt_path, wav_path, ps_path):
            try:
                os.remove(p)
            except OSError:
                pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def reply_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _origin_allowed(self):
        origin = (self.headers.get("Origin") or "").strip()
        if origin == "" or origin == "null":
            return True
        low = origin.lower()
        return low.startswith("http://127.0.0.1") or low.startswith("http://localhost")

    def load_env_vars(self):
        import os
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        out = {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    v = v.strip().strip('"').strip("'")
                    if k and v:
                        out[k.strip()] = v
        except Exception:
            pass
        return out

    def do_GET(self):
        if not self._origin_allowed():
            try:
                body = b'{"ok":false,"error":"forbidden origin"}'
                self.send_response(403)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                pass
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if path == "/ping":
                self.reply_json({"ok": True, "name": "Script2Video Fetcher", "version": 4})
                return

            if path == "/fetch":
                target = (query.get("url") or [""])[0].strip()
                if not re.match(r"^https?://", target):
                    self.reply_json({"ok": False, "error": "bad url"}, 400)
                    return
                req = urllib.request.Request(target, headers={
                    "User-Agent": UA,
                    "Accept": "*/*",
                    "Referer": target,
                })
                try:
                    upstream = urllib.request.urlopen(req, timeout=30)
                except urllib.error.HTTPError as e:
                    self.reply_json({"ok": False, "error": "upstream HTTP %s" % e.code}, 502)
                    return
                except Exception as e:
                    self.reply_json({"ok": False, "error": str(e)}, 502)
                    return
                with upstream:
                    self.send_response(200)
                    ctype = upstream.headers.get("Content-Type", "application/octet-stream")
                    clen = upstream.headers.get("Content-Length")
                    self.send_header("Content-Type", ctype)
                    if clen:
                        self.send_header("X-Original-Length", clen)
                    else:
                        self.send_header("X-Original-Length", "0")
                    self.send_cors()
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    sent = 0
                    while True:
                        chunk = upstream.read(65536)
                        if not chunk:
                            break
                        sent += len(chunk)
                        if sent > MAX_BYTES:
                            break
                        self.wfile.write(("%x\r\n" % len(chunk)).encode())
                        self.wfile.write(chunk)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                log("[download] %s (%.1f MB)" % (target[:90], sent / 1048576))
                return

            if path == "/envfile":
                self.reply_json({"ok": True, "vars": self.load_env_vars()})
                return

            if path == "/ytdl":
                if not _ensure_ytdlp():
                    self.reply_json({"ok": False, "error": "yt-dlp not installed"}, 501)
                    return
                vid = re.sub(r"[^\w\-]", "", (query.get("id") or [""])[0])
                if not vid or len(vid) > 16:
                    self.reply_json({"ok": False, "error": "bad video id"}, 400)
                    return
                try:
                    fpath = _yt_download_cached(vid)
                except Exception as e:
                    self.reply_json({"ok": False, "error": str(e)[:150]}, 502)
                    return
                try:
                    with open(fpath, "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_cors()
                    self.end_headers()
                    self.wfile.write(data)
                    log("[ytdl] served %s (%.1f MB)" % (vid, len(data) / 1048576))
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    pass
                return

            if path == "/sapi":
                text = urllib.parse.unquote((query.get("text") or [""])[0])
                gender = (query.get("gender") or ["male"])[0].lower()
                if not text:
                    self.reply_json({"ok": False, "error": "missing text"}, 400)
                    return
                try:
                    wav = sapi_tts(text, gender)
                except Exception as e:
                    self.reply_json({"ok": False, "error": str(e)}, 502)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.send_cors()
                self.end_headers()
                self.wfile.write(wav)
                log("[sapi] gender=%s chars=%d -> %d bytes" % (gender, len(text), len(wav)))
                return

            if path == "/tts":
                text = urllib.parse.unquote((query.get("text") or [""])[0])
                lang = re.sub(r"[^a-z\-]", "", (query.get("lang") or ["en"])[0].lower()) or "en"
                if not text:
                    self.reply_json({"ok": False, "error": "missing text"}, 400)
                    return
                chunks = split_chunks(text[:3000], 190)
                mp3 = b""
                try:
                    for c in chunks:
                        gtts = ("https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl="
                                + urllib.parse.quote(lang) + "&q=" + urllib.parse.quote(c))
                        req = urllib.request.Request(gtts, headers={"User-Agent": UA, "Referer": "https://translate.google.com/"})
                        resp = urllib.request.urlopen(req, timeout=25)
                        mp3 += resp.read()
                        time.sleep(0.18)
                except Exception as e:
                    self.reply_json({"ok": False, "error": str(e)}, 502)
                    return
                if len(mp3) < 100:
                    self.reply_json({"ok": False, "error": "empty audio"}, 502)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(mp3)))
                self.send_cors()
                self.end_headers()
                self.wfile.write(mp3)
                log("[tts] lang=%s chars=%d -> %d bytes" % (lang, len(text), len(mp3)))
                return

            if path == "/vsearch":
                q = (query.get("q") or [""])[0].strip()
                if not q:
                    self.reply_json({"ok": False, "error": "missing q"}, 400)
                    return
                results = []
                seen = set()

                def add_all(items):
                    for r in items:
                        if r["url"] not in seen:
                            seen.add(r["url"])
                            results.append(r)

                try:
                    yt_results = youtube_search(q)
                    add_all(yt_results)
                except Exception as e:
                    log("[vsearch] youtube failed: %s" % str(e)[:60])
                try:
                    add_all(bing_videos(q)[:8])
                except Exception as e:
                    log("[vsearch] bing failed: %s" % str(e)[:60])
                try:
                    add_all(pexels_scrape(q))
                except Exception as e:
                    log("[vsearch] pexels failed: %s" % str(e)[:60])
                try:
                    add_all(mixkit_scrape(q))
                except Exception as e:
                    log("[vsearch] mixkit failed: %s" % str(e)[:60])
                try:
                    add_all(pixabay_scrape(q))
                except Exception as e:
                    log("[vsearch] pixabay failed: %s" % str(e)[:60])

                log("[vsearch] %r -> %d result(s)" % (q[:60], len(results)))
                self.reply_json({"ok": True, "results": results})
                return

            if path == "/isearch":
                q = (query.get("q") or [""])[0].strip()
                if not q:
                    self.reply_json({"ok": False, "error": "missing q"}, 400)
                    return
                try:
                    results = ddg_images(q)
                except Exception as e:
                    self.reply_json({"ok": False, "error": str(e)}, 502)
                    return
                log("[isearch] %r -> %d result(s)" % (q[:60], len(results)))
                self.reply_json({"ok": True, "results": results})
                return

            if path == "/extract":
                target = (query.get("url") or [""])[0].strip()
                if not re.match(r"^https?://", target):
                    self.reply_json({"ok": False, "error": "bad url"}, 400)
                    return
                req = urllib.request.Request(target, headers={"User-Agent": UA})
                try:
                    resp = urllib.request.urlopen(req, timeout=25)
                    raw = resp.read(4 * 1024 * 1024)
                    final_url = resp.geturl()
                    resp.close()
                except Exception as e:
                    self.reply_json({"ok": False, "error": str(e)}, 502)
                    return
                html = raw.decode("utf-8", "ignore")

                found = []

                def add(u):
                    if not u:
                        return
                    u = urllib.parse.urljoin(final_url, u.strip().strip("\"'"))
                    u = u.replace("\\u0026", "&").replace("\\/", "/")
                    if not u.startswith("http"):
                        return
                    if u not in found:
                        found.append(u)

                for m in re.finditer(
                    r'<meta[^>]+(?:property|name)=["\']og:video(?::secure_url|:url)?["\'][^>]+content=["\']([^"\']+)',
                    html, re.I,
                ):
                    add(m.group(1))
                for m in re.finditer(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']og:video(?::secure_url|:url)?["\']', html, re.I):
                    add(m.group(1))
                for m in re.finditer(r'<video[^>]+src=["\']([^"\']+)', html, re.I):
                    add(m.group(1))
                for m in re.finditer(r'<source[^>]+src=["\']([^"\']+)', html, re.I):
                    add(m.group(1))
                for m in re.finditer(r'"(https?:[^"]+\.(?:mp4|webm|m3u8)[^"]*)"', html):
                    add(m.group(1))

                good = [u for u in found if re.search(r"\.(mp4|webm|mov)(\?|$)", u, re.I)]
                order = {".mp4": 0, ".webm": 1, ".mov": 2}
                good.sort(key=lambda u: order.get("." + u.rsplit(".", 1)[1].lower(), 9))
                log("[extract] %s -> %d candidate(s)" % (target[:80], len(good)))
                self.reply_json({"ok": True, "results": good[:8]})
                return

            self.reply_json({"ok": False, "error": "unknown endpoint"}, 404)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self.reply_json({"ok": False, "error": str(e)}, 500)
            except Exception:
                pass

    def log_message(self, fmt, *args):
        pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log("=" * 52)
    log("  Script2Video Fetcher is running")
    log("  Keep this window open while you use the app.")
    log("  Browser mode unlocked at http://127.0.0.1:%d" % PORT)
    log("  Press Ctrl+C (or close this window) to stop.")
    log("=" * 52)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopped.")
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except OSError as e:
        if "10048" in str(e) or "in use" in str(e).lower():
            print("Port %d already in use - fetcher is probably already running." % PORT)
        else:
            print("Could not start:", e)
        if sys.platform == "win32":
            input("Press Enter to close...")
