"""yt-dlp bridge — the single implementation behind every deploy target.

Runs as a plain server (``server/app.py``), inside a container, or wrapped in a
Firebase Cloud Function (``main.py``). Endpoints:

    GET  /api/health           -> liveness + which mode the client should use
    POST /api/info             -> metadata for a URL
    GET  /api/diag             -> what each player client said, for a human
    GET  /api/download         -> convert and return the mp3 in one request
    POST /api/jobs             -> start a background job (progress mode)
    GET  /api/jobs/{id}        -> poll job status
    GET  /api/jobs/{id}/events -> job status as Server-Sent Events
    GET  /api/jobs/{id}/file   -> download a finished job's mp3

Serverless hosts throttle CPU between requests and spread traffic over
instances, so they use the single-request ``/api/download`` path; a server you
run yourself keeps the job endpoints and their live progress.

This is a plain WSGI application on purpose. An ASGI framework behind a
WSGI adapter runs its event loop on a side thread, which does not survive the
threaded gunicorn worker the Functions runtime uses: every request hung
forever, with nothing logged. Matching the runtime beats adapting to it.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_file
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

# --- configuration ----------------------------------------------------------

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "1800"))
MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", "0"))  # 0 = unlimited
SYNC_ONLY = os.getenv("SYNC_ONLY", "").lower() in ("1", "true", "yes")
PUBLIC_API_URL = os.getenv("PUBLIC_API_URL", "").rstrip("/")
WORK_DIR = Path(os.getenv("WORK_DIR") or tempfile.gettempdir()) / "ytmp3-jobs"
ALLOWED_BITRATES = {"64", "96", "128", "192", "256", "320"}

# YouTube answers as several different "clients". Some of them are the ones a
# bot check tends to interrogate; others (tv_simply, android_vr, ios) do not
# carry an account at all and usually sail past it. On a bot check we retry
# down this list before asking anyone for cookies. Which entries work shifts
# over time, so the list is an env var rather than a constant in the code.
PLAYER_CLIENTS = [
    c.strip()
    for c in os.getenv("YTDLP_PLAYER_CLIENTS", "default,tv_simply,android_vr,ios,web_safari").split(",")
    if c.strip()
]

WORK_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("ytmp3")

# How long metadata lookup may spend before giving the caller a real answer.
# It has to land well inside the client's patience and any proxy's own cap.
INFO_DEADLINE = int(os.getenv("INFO_DEADLINE_SECONDS", "25"))

app = Flask(__name__)


class ApiError(Exception):
    """A failure with a status code and a message meant for the screen."""

    def __init__(self, status: int, message: str, reason: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.reason = reason


@app.errorhandler(ApiError)
def handle_api_error(exc: ApiError):
    return jsonify({"detail": {"message": exc.message, "reason": exc.reason}}), exc.status


@app.after_request
def cors(response: Response) -> Response:
    response.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGINS
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Expose-Headers"] = "Content-Disposition"
    # Chrome's Private Network Access preflight needs this opt-in to let an
    # HTTPS page reach a server running on a private address.
    if request.headers.get("Access-Control-Request-Private-Network"):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


# --- ffmpeg -----------------------------------------------------------------


def ffmpeg_exe() -> str | None:
    """Prefer a system ffmpeg; fall back to the wheel-bundled static build."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - absence is a normal, reportable state
        return None


def transcode(src: Path, dst: Path, bitrate: str, meta: dict[str, Any], cover: Path | None) -> None:
    """Encode `src` to an mp3, embedding tags and (when possible) cover art.

    Driving ffmpeg directly keeps this working where ffprobe is unavailable,
    which is what yt-dlp's own audio postprocessor needs.
    """
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("ffmpeg לא זמין בשרת")

    def build(with_cover: bool) -> list[str]:
        cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src)]
        if with_cover:
            cmd += ["-i", str(cover)]
            cmd += ["-map", "0:a:0", "-map", "1:v:0", "-c:v", "mjpeg", "-disposition:v", "attached_pic"]
        else:
            cmd += ["-map", "0:a:0", "-vn"]
        cmd += ["-c:a", "libmp3lame", "-b:a", f"{bitrate}k", "-id3v2_version", "3"]
        for key, value in meta.items():
            if value:
                cmd += ["-metadata", f"{key}={value}"]
        cmd.append(str(dst))
        return cmd

    attempts = [True, False] if cover and cover.is_file() else [False]
    last = None
    for with_cover in attempts:
        done = subprocess.run(build(with_cover), capture_output=True, text=True)
        if done.returncode == 0 and dst.is_file() and dst.stat().st_size:
            return
        last = done.stderr.strip()
        dst.unlink(missing_ok=True)
    raise RuntimeError(f"ההמרה ל-MP3 נכשלה: {(last or '')[:200]}")


# --- job bookkeeping --------------------------------------------------------


@dataclass
class Job:
    id: str
    url: str
    bitrate: str
    status: str = "queued"  # queued | downloading | converting | done | error
    progress: float = 0.0
    speed: float | None = None
    eta: int | None = None
    title: str | None = None
    thumbnail: str | None = None
    duration: int | None = None
    filename: str | None = None
    filesize: int | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "progress": round(self.progress, 2),
            "speed": self.speed,
            "eta": self.eta,
            "title": self.title,
            "thumbnail": self.thumbnail,
            "duration": self.duration,
            "filename": self.filename,
            "filesize": self.filesize,
            "error": self.error,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()


def sweep_jobs() -> None:
    """Drop finished jobs (and their files) once they age out."""
    cutoff = time.time() - JOB_TTL_SECONDS
    with JOBS_LOCK:
        stale = [j for j in JOBS.values() if j.created < cutoff]
        for job in stale:
            JOBS.pop(job.id, None)
    for job in stale:
        shutil.rmtree(WORK_DIR / job.id, ignore_errors=True)


# --- helpers ----------------------------------------------------------------

URL_RE = re.compile(r"^https?://", re.I)
UNSAFE_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def check_url(url: str) -> str:
    url = (url or "").strip()
    if not URL_RE.match(url):
        raise ApiError(400, "נדרשת כתובת http/https תקינה")
    return url


def check_bitrate(bitrate: str) -> str:
    return bitrate if bitrate in ALLOWED_BITRATES else "192"


def safe_name(title: str) -> str:
    """A filename that survives Content-Disposition and every common filesystem."""
    name = unicodedata.normalize("NFC", title or "audio")
    name = UNSAFE_RE.sub("", name).strip(" .") or "audio"
    return name[:120] + ".mp3"


def cookie_file() -> str | None:
    """Locate a cookies file, accepting the contents straight from the env.

    A serverless instance has no persistent disk to put a file on, so
    YTDLP_COOKIES may carry the file's text itself (optionally "b64:"-prefixed
    to survive single-line env formats).
    """
    path = os.getenv("YTDLP_COOKIES_FILE")
    if path and Path(path).is_file():
        return path

    blob = os.getenv("YTDLP_COOKIES", "").strip()
    if not blob:
        return None
    if blob.startswith("b64:"):
        import base64

        try:
            blob = base64.b64decode(blob[4:]).decode("utf-8")
        except Exception:  # noqa: BLE001 - a malformed value must not kill the request
            return None

    blob = blob.rstrip("\n") + "\n"  # the cookie jar must end on a newline either way
    target = Path(tempfile.gettempdir()) / "ytmp3-cookies.txt"
    try:
        if not target.is_file() or target.read_text(encoding="utf-8") != blob:
            target.write_text(blob, encoding="utf-8")
    except OSError:
        return None
    return str(target)


def base_opts() -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "geo_bypass": True,
        "retries": 1,
        "extractor_retries": 1,
        "socket_timeout": 10,
        "cachedir": False,   # the filesystem is read-only except /tmp
    }
    cookies = cookie_file()
    if cookies:
        opts["cookiefile"] = cookies
    proxy = os.getenv("YTDLP_PROXY")
    if proxy:
        opts["proxy"] = proxy
    return opts


BOT_CHECK_RE = re.compile(
    r"sign in to confirm|not a bot|confirm your age|failed to extract any player response|"
    r"requested format is not available|please sign in",
    re.I,
)


def extract_info(
    url: str,
    opts: dict[str, Any],
    download: bool,
    deadline: float | None = None,
    report: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Extract (and optionally download), working through the client list.

    Only a bot check moves on to the next client — a private or deleted video
    fails on the first attempt, because trying it four more ways would only be
    slower. `deadline` stops the walk before the caller gives up on us, so a
    stuck lookup returns a real message instead of a hung request.
    """
    started = time.monotonic()
    last: Exception | None = None

    for client in PLAYER_CLIENTS:
        spent = time.monotonic() - started
        if deadline is not None and spent >= deadline:
            log.warning("deadline reached after %.1fs, stopping at client=%s", spent, client)
            break

        attempt = dict(opts)
        if client != "default":
            attempt["extractor_args"] = {"youtube": {"player_client": [client]}}

        t0 = time.monotonic()
        try:
            with YoutubeDL(attempt) as ydl:
                data = ydl.extract_info(url, download=download)
            took = time.monotonic() - t0
            log.info("client=%s ok in %.1fs", client, took)
            if report is not None:
                report.append({"client": client, "ok": True, "seconds": round(took, 1)})
            return data
        except DownloadError as exc:
            took = time.monotonic() - t0
            message = str(exc)
            log.warning("client=%s failed in %.1fs: %s", client, took, message[:400])
            if report is not None:
                report.append(
                    {"client": client, "ok": False, "seconds": round(took, 1), "error": message[:400]}
                )
            last = exc
            if not BOT_CHECK_RE.search(message):
                raise

    raise last if last else RuntimeError("ההורדה נכשלה")


def friendly_error(exc: Exception) -> str:
    text = str(exc).replace("ERROR: ", "").strip()
    low = text.lower()
    if "private" in low:
        return "הסרטון פרטי ולא ניתן להורדה"
    if "unavailable" in low or "removed" in low:
        return "הסרטון לא זמין"
    if "sign in" in low or "bot" in low or "cookies" in low:
        return "יוטיוב דורש אימות לסרטון הזה, וגם ניסיון בכל סוגי הנגנים לא עזר. נדרש קובץ cookies בשרת"
    if "unsupported url" in low:
        return "הקישור הזה לא נתמך"
    return text[:300] or "ההורדה נכשלה"


def run_bounded(fn, *args, timeout: float):
    """Run blocking work and stop waiting after `timeout`.

    A thread running yt-dlp cannot be cancelled, so the wait is simply
    abandoned: the daemon thread finishes on its own and dies with the
    process, while the caller gets an answer on time.
    """
    box: dict[str, Any] = {}

    def target() -> None:
        try:
            box["value"] = fn(*args)
        except BaseException as exc:  # noqa: BLE001 - re-raised on the calling thread
            box["error"] = exc

    worker = threading.Thread(target=target, daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise TimeoutError
    if "error" in box:
        raise box["error"]
    return box["value"]


def first_reason(report: list[dict[str, Any]]) -> str | None:
    """The raw text of the first failure, trimmed to something a person can read."""
    for entry in report:
        if not entry.get("ok") and entry.get("error"):
            text = re.sub(r"\s+", " ", entry["error"]).replace("ERROR: ", "")
            text = re.sub(r"; please report.*$", "", text)
            return f"[{entry['client']}] {text[:180]}"
    return None


def pick_thumbnail(info: dict[str, Any]) -> str | None:
    if info.get("thumbnail"):
        return info["thumbnail"]
    thumbs = info.get("thumbnails") or []
    if thumbs:
        return thumbs[-1].get("url")
    return None


def single_entry(data: dict[str, Any]) -> dict[str, Any]:
    """Collapse a playlist result down to its first real video."""
    if data.get("_type") == "playlist":
        entries = [e for e in (data.get("entries") or []) if e]
        if not entries:
            raise ApiError(422, "לא נמצאו סרטונים בקישור")
        return entries[0]
    return data


# --- the actual work --------------------------------------------------------


def convert(job: Job, out_dir: Path) -> Path:
    """Fetch the best audio for `job` and return the finished mp3."""
    out_dir.mkdir(parents=True, exist_ok=True)

    def hook(d: dict[str, Any]) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            job.status = "downloading"
            job.progress = min(99.0, done / total * 100) if total else 0.0
            job.speed = d.get("speed")
            job.eta = d.get("eta")
        elif d.get("status") == "finished":
            job.status = "converting"
            job.progress = 100.0
            job.speed = None
            job.eta = None

    opts = base_opts()
    opts.update(
        {
            "format": "bestaudio/best",
            "outtmpl": str(out_dir / "source.%(ext)s"),
            "progress_hooks": [hook],
            "writethumbnail": True,
            "postprocessors": [],  # ffmpeg is driven directly, see transcode()
        }
    )

    data = single_entry(extract_info(job.url, opts, download=True))

    job.title = data.get("title") or "audio"
    job.duration = int(data.get("duration") or 0) or None
    job.thumbnail = pick_thumbnail(data)

    sources = [p for p in out_dir.glob("source.*") if p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp")]
    if not sources:
        raise RuntimeError("לא הורד קובץ אודיו")
    covers = [p for p in out_dir.glob("source.*") if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]

    job.status = "converting"
    job.progress = 100.0

    target = out_dir / safe_name(job.title)
    transcode(
        sources[0],
        target,
        job.bitrate,
        {
            "title": data.get("track") or data.get("title"),
            "artist": data.get("artist") or data.get("uploader") or data.get("channel"),
            "album": data.get("album"),
            "comment": data.get("webpage_url"),
        },
        covers[0] if covers else None,
    )

    sources[0].unlink(missing_ok=True)
    for cover in covers:
        cover.unlink(missing_ok=True)

    job.filename = target.name
    job.filesize = target.stat().st_size
    job.status = "done"
    return target


# --- routes -----------------------------------------------------------------


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": "yt-mp3-bridge",
            "ffmpeg": bool(ffmpeg_exe()),
            "mode": "sync" if SYNC_ONLY else "jobs",
            "cookies": bool(cookie_file()),
            "clients": PLAYER_CLIENTS,
            "direct_url": PUBLIC_API_URL or None,
            "bitrates": sorted(ALLOWED_BITRATES, key=int),
        }
    )


@app.post("/api/info")
def info():
    payload = request.get_json(silent=True) or {}
    url = check_url(payload.get("url", ""))
    report: list[dict[str, Any]] = []

    try:
        data = single_entry(
            run_bounded(extract_info, url, base_opts(), False, INFO_DEADLINE, report,
                        timeout=INFO_DEADLINE + 5)
        )
    except TimeoutError as exc:
        log.error("info timed out for %s", url)
        raise ApiError(504, "יוטיוב לא ענה בזמן", first_reason(report)) from exc
    except ApiError:
        raise
    except DownloadError as exc:
        raise ApiError(422, friendly_error(exc), first_reason(report) or str(exc)[:200]) from exc
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as a message
        raise ApiError(500, friendly_error(exc), first_reason(report) or str(exc)[:200]) from exc

    duration = int(data.get("duration") or 0)
    if MAX_DURATION_SECONDS and duration > MAX_DURATION_SECONDS:
        raise ApiError(413, f"הסרטון ארוך מהמותר ({MAX_DURATION_SECONDS // 60} דקות)")

    return jsonify(
        {
            "id": data.get("id"),
            "title": data.get("title") or "ללא שם",
            "uploader": data.get("uploader") or data.get("channel"),
            "duration": duration or None,
            "thumbnail": pick_thumbnail(data),
            "webpage_url": data.get("webpage_url") or url,
            "is_live": bool(data.get("is_live")),
        }
    )


@app.get("/api/diag")
def diag():
    """Report what each player client actually said. Read by a human, not the app."""
    target = check_url(request.args.get("url", ""))
    report: list[dict[str, Any]] = []
    started = time.monotonic()
    title = None
    try:
        data = run_bounded(extract_info, target, base_opts(), False, INFO_DEADLINE, report,
                           timeout=INFO_DEADLINE + 5)
        title = single_entry(data).get("title")
    except Exception as exc:  # noqa: BLE001 - the failure is the point of this endpoint
        log.warning("diag failed: %s", exc)

    return jsonify(
        {
            "url": target,
            "title": title,
            "succeeded": title is not None,
            "total_seconds": round(time.monotonic() - started, 1),
            "attempts": report,
            "ffmpeg": bool(ffmpeg_exe()),
            "cookies": bool(cookie_file()),
            "yt_dlp": __import__("yt_dlp").version.__version__,
        }
    )


@app.get("/api/download")
def download():
    """Convert and hand back the mp3 within a single request."""
    sweep_jobs()
    job = Job(
        id=uuid.uuid4().hex[:12],
        url=check_url(request.args.get("url", "")),
        bitrate=check_bitrate(request.args.get("bitrate", "192")),
    )
    out_dir = WORK_DIR / job.id

    try:
        target = convert(job, out_dir)
    except ApiError:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    except DownloadError as exc:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise ApiError(422, friendly_error(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as a message
        shutil.rmtree(out_dir, ignore_errors=True)
        raise ApiError(500, friendly_error(exc)) from exc

    with JOBS_LOCK:
        JOBS[job.id] = job  # keeps the sweeper responsible for the file
    return send_file(target, mimetype="audio/mpeg", as_attachment=True, download_name=target.name)


def run_job(job: Job) -> None:
    try:
        convert(job, WORK_DIR / job.id)
    except Exception as exc:  # noqa: BLE001 - reported back through the API
        job.error = friendly_error(exc)
        job.status = "error"


@app.post("/api/jobs")
def create_job():
    sweep_jobs()
    payload = request.get_json(silent=True) or {}
    url = check_url(payload.get("url", ""))

    if not ffmpeg_exe():
        raise ApiError(503, "ffmpeg לא מותקן בשרת")

    job = Job(id=uuid.uuid4().hex[:12], url=url, bitrate=check_bitrate(payload.get("bitrate", "192")))
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return jsonify({"id": job.id})


def get_job(job_id: str) -> Job:
    job = JOBS.get(job_id)
    if not job:
        raise ApiError(404, "העבודה לא נמצאה או שפג תוקפה")
    return job


@app.get("/api/jobs/<job_id>")
def job_status(job_id: str):
    return jsonify(get_job(job_id).public())


@app.get("/api/jobs/<job_id>/events")
def job_events(job_id: str):
    job = get_job(job_id)

    def stream():
        last = None
        while True:
            payload = job.public()
            if payload != last:
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                last = payload
            if job.status in ("done", "error"):
                break
            time.sleep(0.4)

    return Response(
        stream(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/jobs/<job_id>/file")
def job_file(job_id: str):
    job = get_job(job_id)
    if job.status != "done" or not job.filename:
        raise ApiError(409, "הקובץ עדיין לא מוכן")
    path = WORK_DIR / job.id / job.filename
    if not path.is_file():
        raise ApiError(410, "הקובץ נמחק מהשרת")
    return send_file(path, mimetype="audio/mpeg", as_attachment=True, download_name=job.filename)
