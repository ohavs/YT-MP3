# Build from the repo root: docker build -t ytmp3 .
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY functions/bridge.py ./functions/bridge.py
COPY server/app.py ./server/app.py

ENV PORT=8000 HOST=0.0.0.0
EXPOSE 8000
CMD ["python", "server/app.py"]
