"""Run the yt-dlp bridge as a plain HTTP server.

The implementation lives in ../functions/bridge.py so that the server, the
container image and the Firebase function all serve identical behaviour.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "functions"))

from bridge import app  # noqa: E402,F401 - re-exported for `uvicorn app:app`

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        log_level="info",
    )
