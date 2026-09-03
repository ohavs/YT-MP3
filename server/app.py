"""Run the yt-dlp bridge as a plain HTTP server.

The implementation lives in ../functions/bridge.py so that the server, the
container image and the Firebase function all serve identical behaviour.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "functions"))

from bridge import app  # noqa: E402,F401 - re-exported for any WSGI server

if __name__ == "__main__":
    from werkzeug.serving import run_simple

    run_simple(
        os.getenv("HOST", "0.0.0.0"),
        int(os.getenv("PORT", "8000")),
        app,
        threaded=True,
    )
