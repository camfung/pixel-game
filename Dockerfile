FROM python:3.12-slim

# Pillow needs no build toolchain for the slim wheels, but keep the image lean.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install deps first so the layer caches across code changes.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY static ./static

# SQLite db + uploaded/cached images live here; mount a volume to persist them.
RUN mkdir -p data
VOLUME ["/app/data"]

EXPOSE 8777

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8777"]
