#!/usr/bin/env bash
# Boots the yt-dlp bridge in a local virtualenv.
set -euo pipefail
cd "$(dirname "$0")"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg / apt install ffmpeg)"; exit 1; }

[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt

echo "→ http://localhost:${PORT:-8000}"
exec python app.py
