#!/usr/bin/env bash
# Boots the yt-dlp bridge in a local virtualenv.
set -euo pipefail
cd "$(dirname "$0")"

[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt

command -v ffmpeg >/dev/null || echo "note: no system ffmpeg — falling back to the bundled build"

echo "→ http://localhost:${PORT:-8000}"
exec python app.py
