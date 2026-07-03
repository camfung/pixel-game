#!/usr/bin/env bash
# Pixel Reveal — start the server. First run creates a venv + installs deps.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "· creating venv + installing deps…"
  uv venv
  uv pip install -r requirements.txt
fi

PORT="${PORT:-8777}"
echo "· Pixel Reveal on http://127.0.0.1:${PORT}"
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$PORT" "$@"
