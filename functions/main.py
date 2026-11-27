"""Firebase entry point: serves the yt-dlp bridge as one HTTPS function.

The bridge is a WSGI application, which is what this runtime speaks, so the
request is handed straight to it. The function answers the same /api/* routes
the front-end already speaks; SYNC_ONLY steers the client to the
single-request path, because a serverless instance cannot be relied on to
keep job state.
"""

import os

from firebase_functions import https_fn, options, scheduler_fn
from werkzeug.wrappers import Response

os.environ.setdefault("SYNC_ONLY", "1")
os.environ.setdefault("WORK_DIR", "/tmp")
# /tmp is memory here, and a video sits in it twice while its two streams are
# joined (the parts, then the result). Kept well under the instance's 1 GB.
os.environ.setdefault("MAX_VIDEO_MB", "400")

from bridge import app as flask_app  # noqa: E402 - env must be set before import

wsgi_app = flask_app.wsgi_app


def normalize(environ: dict) -> dict:
    """Present every route to the app under a single /api prefix.

    The same function is reached two ways: through a Hosting rewrite, which
    forwards /api/... untouched, and through its own URL, where the function
    name is itself "api". Collapsing a doubled prefix and adding a missing one
    keeps both callers on the same routes.
    """
    path = environ.get("PATH_INFO", "") or "/"
    while path.startswith("/api/api/"):
        path = path[4:]
    if path == "/api/api":
        path = "/api"
    if not (path == "/api" or path.startswith("/api/")):
        path = "/api" + path
    environ["PATH_INFO"] = path
    return environ


@https_fn.on_request(
    region="us-central1",
    # The PWA calls this anonymously from the browser; without an explicit
    # public invoker Google answers unauthenticated requests with 403.
    invoker="public",
    memory=options.MemoryOption.GB_1,
    timeout_sec=540,
    cpu=1,
    max_instances=10,
    concurrency=4,
)
def api(request: https_fn.Request) -> https_fn.Response:
    return Response.from_app(wsgi_app, normalize(dict(request.environ)))


# --- self test -------------------------------------------------------------
#
# Nothing outside Google's network can be reached from the machine this was
# developed on, so the deployment has to report on itself: this runs the same
# extraction the API does and writes the result to the logs, which tells us
# whether YouTube is challenging this IP range or refusing it outright.

SELFTEST_URL = os.getenv("SELFTEST_URL", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")


@scheduler_fn.on_schedule(
    schedule="*/10 * * * *",
    region="us-central1",
    memory=options.MemoryOption.GB_1,
    timeout_sec=300,
)
def selftest(event: scheduler_fn.ScheduledEvent) -> None:
    import json

    from bridge import INFO_DEADLINE, base_opts, extract_info, ffmpeg_exe, single_entry

    report: list[dict] = []
    title = None
    error = None
    try:
        title = single_entry(extract_info(SELFTEST_URL, base_opts(), False, INFO_DEADLINE, report)).get("title")
    except Exception as exc:  # noqa: BLE001 - the failure is what we came to record
        error = str(exc)[:600]

    print("SELFTEST " + json.dumps(
        {"ok": title is not None, "title": title, "error": error,
         "ffmpeg": bool(ffmpeg_exe()), "attempts": report},
        ensure_ascii=False,
    ))


# --- temporary: which region's addresses does YouTube still answer? ---------

LAB_URL = "https://www.youtube.com/watch?v=pyMQ3OOrov4"
LAB_CLIENTS = ["default", "tv_embedded", "web_safari", "web_embedded", "mweb", "tv_simply", "android_vr"]


def _lab(region: str) -> None:
    import json
    import time

    from yt_dlp import YoutubeDL

    from bridge import base_opts

    for client in LAB_CLIENTS:
        opts = base_opts()
        if client != "default":
            opts["extractor_args"] = {"youtube": {"player_client": [client]}}
        t0 = time.monotonic()
        try:
            with YoutubeDL(opts) as ydl:
                data = ydl.extract_info(LAB_URL, download=False)
            heights = sorted({f.get("height") for f in data.get("formats") or [] if f.get("height")})
            result = {"ok": True, "top": heights[-1] if heights else None}
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)[25:90]}
        result.update({"region": region, "client": client, "s": round(time.monotonic() - t0, 1)})
        print("REGIONLAB " + json.dumps(result))


@scheduler_fn.on_schedule(schedule="0 0 1 1 *", region="europe-west1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def lab_euw1(event: scheduler_fn.ScheduledEvent) -> None:
    _lab("europe-west1")


@scheduler_fn.on_schedule(schedule="0 0 1 1 *", region="me-west1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def lab_mew1(event: scheduler_fn.ScheduledEvent) -> None:
    _lab("me-west1")


@scheduler_fn.on_schedule(schedule="0 0 1 1 *", region="asia-northeast1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def lab_asne1(event: scheduler_fn.ScheduledEvent) -> None:
    _lab("asia-northeast1")


@scheduler_fn.on_schedule(schedule="0 0 1 1 *", region="us-east1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def lab_use1(event: scheduler_fn.ScheduledEvent) -> None:
    _lab("us-east1")


@scheduler_fn.on_schedule(schedule="0 0 1 1 *", region="southamerica-east1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def lab_sae1(event: scheduler_fn.ScheduledEvent) -> None:
    _lab("southamerica-east1")


@scheduler_fn.on_schedule(schedule="0 0 1 1 *", region="australia-southeast1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def lab_ause1(event: scheduler_fn.ScheduledEvent) -> None:
    _lab("australia-southeast1")
