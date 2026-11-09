FROM python:3.12-slim

# Keep the build online so FastEmbed can fetch the model in the explicit prefetch step.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FASTEMBED_CACHE_PATH=/opt/fastembed

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY prefetch_model.py server.py ./
RUN python prefetch_model.py && \
    groupadd --system --gid 10001 memory && \
    useradd --system --uid 10001 --gid memory --home-dir /nonexistent --shell /usr/sbin/nologin memory && \
    chown -R 10001:10001 /opt/fastembed /app

# Enforce offline-only behavior in the final runtime image, not during model prefetch.
ENV HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TRANSFORMERS_OFFLINE=1

USER 10001:10001
EXPOSE 6335
HEALTHCHECK --interval=15s --timeout=3s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:6335/health', timeout=2).read()" || exit 1
CMD ["python", "server.py"]
