"""Minimal yt-dlp bridge for the YT-MP3 PWA.

Exposes a tiny JSON API the static front-end can talk to:

    POST /api/info          -> metadata for a URL (title, channel, thumbnail...)
    POST /api/jobs          -> start a conversion job, returns {"id": ...}
    GET  /api/jobs/{id}     -> poll job status
    GET  /api/jobs/{id}/events -> same status as a Server-Sent Events stream
    GET  /api/jobs/{id}/file   -> download the finished mp3
    GET  /api/health        -> liveness + capability probe

Run it with:  python app.py   (see README.md for details)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

# --- configuration ----------------------------------------------------------

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "1800"))
MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", "0"))  # 0 = unlimited
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


def check_url(url: str) -> str:
    url = (url or "").strip()
    if not URL_RE.match(url):
        raise HTTPException(status_code=400, detail="נדרשת כתובת http/https תקינה")
    return url


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
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "bitrates": sorted(ALLOWED_BITRATES, key=int),
    }


@app.post("/api/info")
async def info(req: InfoRequest) -> dict[str, Any]:
    url = check_url(req.url)

    def extract() -> dict[str, Any]:
        with YoutubeDL(base_opts()) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        data = await asyncio.to_thread(extract)
    except DownloadError as exc:
        raise HTTPException(status_code=422, detail=friendly_error(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as a message
        raise HTTPException(status_code=500, detail=friendly_error(exc)) from exc

    if data.get("_type") == "playlist":
        entries = [e for e in (data.get("entries") or []) if e]
        if not entries:
            raise HTTPException(status_code=422, detail="לא נמצאו סרטונים בקישור")
        data = entries[0]

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


def run_job(job: Job) -> None:
    """Download + transcode in a worker thread, updating job state as it goes."""
    out_dir = WORK_DIR / job.id
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
            "outtmpl": str(out_dir / "%(title).150B.%(ext)s"),
            "progress_hooks": [hook],
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": job.bitrate,
                },
                {"key": "FFmpegMetadata", "add_metadata": True},
                {"key": "EmbedThumbnail", "already_have_thumbnail": False},
            ],
            "writethumbnail": True,
        }
    )

    try:
        with YoutubeDL(opts) as ydl:
            data = ydl.extract_info(job.url, download=True)
        if data.get("_type") == "playlist":
            data = [e for e in (data.get("entries") or []) if e][0]

        job.title = data.get("title") or job.title
        job.duration = int(data.get("duration") or 0) or None
        job.thumbnail = pick_thumbnail(data)

        mp3s = sorted(out_dir.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
        if not mp3s:
            raise RuntimeError("ההמרה ל-MP3 נכשלה (בדקו שה-ffmpeg מותקן)")

        final = mp3s[-1]
        job.filename = final.name
        job.filesize = final.stat().st_size
        job.progress = 100.0
        job.status = "done"
    except Exception as exc:  # noqa: BLE001 - reported back through the API
        job.error = friendly_error(exc)
        job.status = "error"


@app.post("/api/jobs")
async def create_job(req: JobRequest) -> dict[str, str]:
    sweep_jobs()
    url = check_url(req.url)
    bitrate = req.bitrate if req.bitrate in ALLOWED_BITRATES else "192"

    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=503, detail="ffmpeg לא מותקן בשרת")

    job = Job(id=uuid.uuid4().hex[:12], url=url, bitrate=bitrate)
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        log_level="info",
    )
