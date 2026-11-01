# Build context: this directory (runner/).  docker build -t loom-sandbox-runner runner/
# Python standard library only: nothing is pip-installed, so the image has no packages to patch.
FROM python:3.12-slim

# No root, no home, no shell login: the runner and the child it spawns share this user.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin sandbox
COPY --chown=root:root --chmod=0444 server.py /app/server.py

USER sandbox
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    BIND_HOST=0.0.0.0 \
    EXIT_AFTER_EACH_REQUEST=1
# Cloud Run sets $PORT; the runner reads it.
CMD ["python3", "-I", "/app/server.py"]
