"""Firebase entry point: serves the yt-dlp bridge as one HTTPS function.

Cloud Functions hands us a WSGI request, so the ASGI app is adapted rather
than rewritten. The function answers the same /api/* routes the front-end
already speaks; SYNC_ONLY steers the client to the single-request path,
because a serverless instance cannot be relied on to keep job state.
"""

import os

from a2wsgi import ASGIMiddleware
from firebase_functions import https_fn, options
from werkzeug.wrappers import Response

os.environ.setdefault("SYNC_ONLY", "1")
os.environ.setdefault("WORK_DIR", "/tmp")

from bridge import app as asgi_app  # noqa: E402 - env must be set before import

wsgi_app = ASGIMiddleware(asgi_app)


@https_fn.on_request(
    region="us-central1",
    memory=options.MemoryOption.GB_1,
    timeout_sec=540,
    cpu=1,
    max_instances=10,
    concurrency=4,
)
def api(request: https_fn.Request) -> https_fn.Response:
    return Response.from_app(wsgi_app, request.environ)
