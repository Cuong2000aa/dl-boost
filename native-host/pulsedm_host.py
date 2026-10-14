#!/usr/bin/env python3
"""
PulseDM Native Host (macOS / Windows) — IDM-style helper outside the browser sandbox.

Talks to the extension via Chrome/Edge Native Messaging.
Optional: uses user-installed yt-dlp for site downloads (YouTube/Facebook/…).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
from pathlib import Path

HOST_NAME = "com.pulsedm.host"
VERSION = "1.2.0"  # keep in sync with Go host; Windows ships Go .exe


def _configure_stdio_binary() -> None:
    """Native Messaging requires binary length-prefixed frames (critical on Windows)."""
    try:
        if sys.platform == "win32":
            import msvcrt

            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except Exception:
        pass


_configure_stdio_binary()


def log(msg: str) -> None:
    try:
        sys.stderr.write(f"[pulsedm-host] {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = sys.stdin.buffer.read(length)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


def send_message(msg: dict) -> None:
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def which_ytdlp() -> str | None:
    for name in ("yt-dlp", "yt_dlp"):
        path = shutil.which(name)
        if path:
            return path
    candidates = [
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
        str(Path.home() / ".local/bin/yt-dlp"),
    ]
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        candidates += [
            str(Path.home() / "AppData/Local/Programs/Python/Python312/Scripts/yt-dlp.exe"),
            str(Path.home() / "AppData/Local/Programs/Python/Python311/Scripts/yt-dlp.exe"),
            str(Path(local) / "Programs" / "yt-dlp" / "yt-dlp.exe") if local else "",
            r"C:\Windows\yt-dlp.exe",
        ]
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    return None


def default_download_dir() -> str:
    if sys.platform == "win32":
        user_dl = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Downloads" / "PulseDM"
    else:
        user_dl = Path.home() / "Downloads" / "PulseDM"
    try:
        user_dl.mkdir(parents=True, exist_ok=True)
        return str(user_dl)
    except OSError:
        fallback = Path.home() / "PulseDM-Downloads"
        try:
            fallback.mkdir(parents=True, exist_ok=True)
            return str(fallback)
        except OSError:
            return str(Path.home())


def status_payload() -> dict:
    ytdlp = which_ytdlp()
    ytdlp_ver = None
    if ytdlp:
        try:
            out = subprocess.check_output([ytdlp, "--version"], text=True, timeout=8)
            ytdlp_ver = out.strip().splitlines()[0]
        except Exception as e:
            ytdlp_ver = f"error: {e}"
    return {
        "type": "status",
        "ok": True,
        "hostVersion": VERSION,
        "hostName": HOST_NAME,
        "python": sys.version.split()[0],
        "ytdlpPath": ytdlp,
        "ytdlpVersion": ytdlp_ver,
        "ytdlpReady": bool(ytdlp),
        "downloadDir": default_download_dir(),
        "platform": sys.platform,
    }


def http_download(url: str, dest: Path, connections: int = 8, job_id: str = "") -> dict:
    """Simple multi-connection Range download to disk."""
    req = urllib.request.Request(url)
    req.get_method = lambda: "HEAD"  # type: ignore
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            size = int(res.headers.get("Content-Length") or 0)
            accept = (res.headers.get("Accept-Ranges") or "").lower()
            cd = res.headers.get("Content-Disposition") or ""
    except Exception:
        size = 0
        accept = ""
        cd = ""

    if size <= 0 or "bytes" not in accept or connections <= 1:
        return _http_single(url, dest, job_id)

    part = (size + connections - 1) // connections
    tmp_parts = []
    errors: list[str] = []
    loaded = [0] * connections
    lock = threading.Lock()
    stop = threading.Event()

    def worker(i: int, start: int, end: int) -> None:
        if stop.is_set():
            return
        part_path = dest.with_suffix(dest.suffix + f".part{i}")
        tmp_parts.append((i, part_path))
        try:
            r = urllib.request.Request(url)
            r.add_header("Range", f"bytes={start}-{end}")
            with urllib.request.urlopen(r, timeout=120) as res, open(part_path, "wb") as f:
                while True:
                    if stop.is_set():
                        return
                    chunk = res.read(256 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    with lock:
                        loaded[i] += len(chunk)
                        send_message(
                            {
                                "type": "progress",
                                "jobId": job_id,
                                "loaded": sum(loaded),
                                "total": size,
                                "mode": "native-helper",
                            }
                        )
        except Exception as e:
            errors.append(str(e))
            stop.set()

    threads = []
    for i in range(connections):
        start = i * part
        if start >= size:
            break
        end = min(size - 1, start + part - 1)
        t = threading.Thread(target=worker, args=(i, start, end), daemon=True)
        threads.append(t)
        t.start()
    for t in threads:
        t.join()

    if errors:
        for _, p in tmp_parts:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass
        raise RuntimeError(errors[0])

    tmp_parts.sort(key=lambda x: x[0])
    with open(dest, "wb") as out:
        for _, p in tmp_parts:
            with open(p, "rb") as f:
                shutil.copyfileobj(f, out)
            p.unlink(missing_ok=True)

    return {"path": str(dest), "size": dest.stat().st_size, "mode": "native-helper"}


def _http_single(url: str, dest: Path, job_id: str) -> dict:
    loaded = 0
    total = 0
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=120) as res, open(dest, "wb") as f:
        total = int(res.headers.get("Content-Length") or 0)
        while True:
            chunk = res.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            loaded += len(chunk)
            send_message(
                {
                    "type": "progress",
                    "jobId": job_id,
                    "loaded": loaded,
                    "total": total or loaded,
                    "mode": "native-helper",
                }
            )
    return {"path": str(dest), "size": dest.stat().st_size, "mode": "native-helper"}


SITE_RE = re.compile(
    r"(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|"
    r"instagram\.com|tiktok\.com|x\.com|twitter\.com|vimeo\.com)($|\.)",
    re.I,
)


def looks_like_site_page(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return False
    return bool(SITE_RE.search(host))


def run_ytdlp(url: str, out_dir: str, job_id: str, extra_args: list | None = None) -> dict:
    ytdlp = which_ytdlp()
    if not ytdlp:
        raise RuntimeError(
            "Chưa cài yt-dlp. Chạy: brew install yt-dlp   (hoặc pip install yt-dlp)"
        )

    out_dir_p = Path(out_dir or default_download_dir())
    out_dir_p.mkdir(parents=True, exist_ok=True)
    template = str(out_dir_p / "%(title).180B [%(id)s].%(ext)s")

    cmd = [
        ytdlp,
        "--no-playlist",
        "--newline",
        "-o",
        template,
        "--no-mtime",
        url,
    ]
    if extra_args:
        cmd[1:1] = list(extra_args)

    send_message(
        {
            "type": "progress",
            "jobId": job_id,
            "loaded": 0,
            "total": 0,
            "mode": "ytdlp",
            "message": "Đang gọi yt-dlp…",
        }
    )

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    last_path = None
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        # yt-dlp progress lines: [download]  12.3% of ...
        m = re.search(r"\[download\]\s+([\d.]+)%", line)
        if m:
            pct = float(m.group(1))
            send_message(
                {
                    "type": "progress",
                    "jobId": job_id,
                    "percent": pct,
                    "mode": "ytdlp",
                    "message": line[:200],
                }
            )
        if "Destination:" in line:
            last_path = line.split("Destination:", 1)[-1].strip()
        if line.startswith("[download] Destination:"):
            last_path = line.split("Destination:", 1)[-1].strip()
        # already downloaded
        m2 = re.search(r"has already been downloaded(?::\s*(.+))?$", line)
        if m2 and m2.group(1):
            last_path = m2.group(1).strip()

    code = proc.wait(timeout=3600)
    if code != 0:
        raise RuntimeError(f"yt-dlp thoát mã {code}. Kiểm tra URL / cập nhật: yt-dlp -U")

    if not last_path:
        # pick newest file in out dir as fallback
        files = sorted(out_dir_p.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
        files = [f for f in files if f.is_file()]
        if files:
            last_path = str(files[0])

    if not last_path or not os.path.isfile(last_path):
        raise RuntimeError("yt-dlp xong nhưng không tìm thấy file output")

    size = os.path.getsize(last_path)
    return {
        "path": last_path,
        "size": size,
        "mode": "ytdlp",
        "filename": os.path.basename(last_path),
    }


def safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "download")
    return name[:180] or f"download-{int(time.time())}"


def handle(msg: dict) -> None:
    mtype = msg.get("type")
    job_id = msg.get("jobId") or f"job_{int(time.time())}"

    if mtype in ("ping", "status"):
        send_message(status_payload())
        return

    if mtype == "download":
        url = msg.get("url") or ""
        if not url.startswith("http"):
            raise RuntimeError("URL không hợp lệ")
        out_dir = Path(msg.get("outDir") or default_download_dir())
        out_dir.mkdir(parents=True, exist_ok=True)
        filename = safe_name(msg.get("filename") or f"file-{int(time.time())}")
        dest = out_dir / filename
        connections = max(1, min(16, int(msg.get("connections") or 8)))

        # Site pages → yt-dlp
        prefer = msg.get("engine") or "auto"
        if prefer == "ytdlp" or (prefer == "auto" and looks_like_site_page(url)):
            result = run_ytdlp(url, str(out_dir), job_id, msg.get("ytdlpArgs"))
        else:
            result = http_download(url, dest, connections, job_id)
            result["filename"] = filename

        send_message(
            {
                "type": "done",
                "jobId": job_id,
                "ok": True,
                **result,
            }
        )
        return

    if mtype == "ytdlp":
        url = msg.get("url") or ""
        result = run_ytdlp(
            url,
            msg.get("outDir") or default_download_dir(),
            job_id,
            msg.get("ytdlpArgs"),
        )
        send_message({"type": "done", "jobId": job_id, "ok": True, **result})
        return

    raise RuntimeError(f"Unknown type: {mtype}")


def main() -> int:
    # Native messaging: one message at a time, keep reading
    while True:
        msg = read_message()
        if msg is None:
            break
        try:
            handle(msg)
        except Exception as e:
            log(str(e))
            send_message(
                {
                    "type": "error",
                    "jobId": msg.get("jobId"),
                    "ok": False,
                    "error": str(e),
                }
            )
    return 0


if __name__ == "__main__":
    # Allow CLI status check: python3 pulsedm_host.py --status
    if len(sys.argv) > 1 and sys.argv[1] in ("--status", "status"):
        print(json.dumps(status_payload(), indent=2, ensure_ascii=False))
        raise SystemExit(0)
    raise SystemExit(main())
