"""yt-dlp bridge — the single implementation behind every deploy target.

Runs as a plain server (``server/app.py``), inside a container, or wrapped in a
Firebase Cloud Function (``main.py``). Endpoints:

    GET  /api/health           -> liveness + which mode the client should use
    POST /api/info             -> metadata for a URL
    GET  /api/download         -> convert and return the mp3 in one request
    POST /api/jobs             -> start a background job (progress mode)
    GET  /api/jobs/{id}        -> poll job status
    GET  /api/jobs/{id}/events -> job status as Server-Sent Events
    GET  /api/jobs/{id}/file   -> download a finished job's mp3

Serverless hosts throttle CPU between requests and spread traffic over
instances, so they use the single-request ``/api/download`` path; a server you
run yourself keeps the job endpoints and their live progress.
"""

from __future__ import annotations

import asyncio
import json
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

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

# --- configuration ----------------------------------------------------------

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "1800"))
MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", "0"))  # 0 = unlimited
SYNC_ONLY = os.getenv("SYNC_ONLY", "").lower() in ("1", "true", "yes")
PUBLIC_API_URL = os.getenv("PUBLIC_API_URL", "").rstrip("/")
WORK_DIR = Path(os.getenv("WORK_DIR") or tempfile.gettempdir()) / "ytmp3-jobs"
ALLOWED_BITRATES = {"64", "96", "128", "192", "256", "320"}

WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="YT-MP3 bridge", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


@app.middleware("http")
async def private_network_access(request, call_next):
    """Let an HTTPS page reach this server when it runs on a private address.

    Chrome's Private Network Access preflight needs this opt-in header, which
    the stock CORS middleware does not send.
    """
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network"):
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
        raise HTTPException(status_code=400, detail="נדרשת כתובת http/https תקינה")
    return url


def check_bitrate(bitrate: str) -> str:
    return bitrate if bitrate in ALLOWED_BITRATES else "192"


def safe_name(title: str) -> str:
    """A filename that survives Content-Disposition and every common filesystem."""
    name = unicodedata.normalize("NFC", title or "audio")
    name = UNSAFE_RE.sub("", name).strip(" .") or "audio"
    return name[:120] + ".mp3"


def base_opts() -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "geo_bypass": True,
        "retries": 3,
        "socket_timeout": 20,
    }
    cookies = os.getenv("YTDLP_COOKIES_FILE")
    if cookies and Path(cookies).is_file():
        opts["cookiefile"] = cookies
    proxy = os.getenv("YTDLP_PROXY")
    if proxy:
        opts["proxy"] = proxy
    return opts


def friendly_error(exc: Exception) -> str:
    text = str(exc).replace("ERROR: ", "").strip()
    low = text.lower()
    if "private" in low:
        return "הסרטון פרטי ולא ניתן להורדה"
    if "unavailable" in low or "removed" in low:
        return "הסרטון לא זמין"
    if "sign in" in low or "bot" in low or "cookies" in low:
        return "יוטיוב ביקש אימות. הוסיפו קובץ cookies לשרת ונסו שוב"
    if "unsupported url" in low:
        return "הקישור הזה לא נתמך"
    return text[:300] or "ההורדה נכשלה"


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
            raise HTTPException(status_code=422, detail="לא נמצאו סרטונים בקישור")
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

    with YoutubeDL(opts) as ydl:
        data = single_entry(ydl.extract_info(job.url, download=True))

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


# --- API models -------------------------------------------------------------


class InfoRequest(BaseModel):
    url: str


class JobRequest(BaseModel):
    url: str
    bitrate: str = Field(default="192")


# --- routes -----------------------------------------------------------------


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "yt-mp3-bridge",
        "ffmpeg": bool(ffmpeg_exe()),
        "mode": "sync" if SYNC_ONLY else "jobs",
        "direct_url": PUBLIC_API_URL or None,
        "bitrates": sorted(ALLOWED_BITRATES, key=int),
    }


@app.post("/api/info")
async def info(req: InfoRequest) -> dict[str, Any]:
    url = check_url(req.url)

    def extract() -> dict[str, Any]:
        with YoutubeDL(base_opts()) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        data = single_entry(await asyncio.to_thread(extract))
    except DownloadError as exc:
        raise HTTPException(status_code=422, detail=friendly_error(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as a message
        raise HTTPException(status_code=500, detail=friendly_error(exc)) from exc

    duration = int(data.get("duration") or 0)
    if MAX_DURATION_SECONDS and duration > MAX_DURATION_SECONDS:
        raise HTTPException(
            status_code=413,
            detail=f"הסרטון ארוך מהמותר ({MAX_DURATION_SECONDS // 60} דקות)",
        )

    return {
        "id": data.get("id"),
        "title": data.get("title") or "ללא שם",
        "uploader": data.get("uploader") or data.get("channel"),
        "duration": duration or None,
        "thumbnail": pick_thumbnail(data),
        "webpage_url": data.get("webpage_url") or url,
        "is_live": bool(data.get("is_live")),
    }


@app.get("/api/download")
async def download(
    url: str = Query(...),
    bitrate: str = Query("192"),
) -> FileResponse:
    """Convert and hand back the mp3 within a single request."""
    sweep_jobs()
    job = Job(id=uuid.uuid4().hex[:12], url=check_url(url), bitrate=check_bitrate(bitrate))
    out_dir = WORK_DIR / job.id

    try:
        target = await asyncio.to_thread(convert, job, out_dir)
    except DownloadError as exc:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=friendly_error(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as a message
        shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=friendly_error(exc)) from exc

    with JOBS_LOCK:
        JOBS[job.id] = job  # keeps the sweeper responsible for the file
    return FileResponse(target, media_type="audio/mpeg", filename=target.name)


def run_job(job: Job) -> None:
    try:
        convert(job, WORK_DIR / job.id)
    except Exception as exc:  # noqa: BLE001 - reported back through the API
        job.error = friendly_error(exc)
        job.status = "error"


@app.post("/api/jobs")
async def create_job(req: JobRequest) -> dict[str, str]:
    sweep_jobs()
    url = check_url(req.url)

    if not ffmpeg_exe():
        raise HTTPException(status_code=503, detail="ffmpeg לא מותקן בשרת")

    job = Job(id=uuid.uuid4().hex[:12], url=url, bitrate=check_bitrate(req.bitrate))
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return {"id": job.id}


def get_job(job_id: str) -> Job:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="העבודה לא נמצאה או שפג תוקפה")
    return job


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    return get_job(job_id).public()


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    job = get_job(job_id)

    async def stream():
        last = None
        while True:
            payload = job.public()
            if payload != last:
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                last = payload
            if job.status in ("done", "error"):
                break
            await asyncio.sleep(0.4)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/jobs/{job_id}/file")
def job_file(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if job.status != "done" or not job.filename:
        raise HTTPException(status_code=409, detail="הקובץ עדיין לא מוכן")
    path = WORK_DIR / job.id / job.filename
    if not path.is_file():
        raise HTTPException(status_code=410, detail="הקובץ נמחק מהשרת")
    return FileResponse(path, media_type="audio/mpeg", filename=job.filename)
