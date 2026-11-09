"""Small, serial HTTP wrapper around the local FastEmbed model."""

from __future__ import annotations

import json
import math
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Iterable

MODEL = "BAAI/bge-small-en-v1.5"
DIMENSION = 384
MAX_TEXTS = 32
MAX_TEXT_CHARS = 8000
MAX_BODY_BYTES = 1_050_000
SERVICE_VERSION = 1
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


class MemoryService:
    def __init__(self, engine: Any, revision: str):
        self.engine = engine
        self.revision = revision

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "model": MODEL,
            "revision": self.revision,
            "dimension": DIMENSION,
            "max_tokens": 512,
            "service_version": SERVICE_VERSION,
        }

    def embed(self, texts: list[str], input_type: str) -> dict[str, Any]:
        method = self.engine.query_embed if input_type == "query" else self.engine.passage_embed
        # FastEmbed 0.7.4's BGE query_embed delegates to embed without this instruction.
        inputs = [QUERY_PREFIX + text for text in texts] if input_type == "query" else texts
        vectors = [list(vector) for vector in method(inputs)]
        if len(vectors) != len(texts):
            raise RuntimeError("Invalid model output")
        checked: list[list[float]] = []
        for vector in vectors:
            if len(vector) != DIMENSION:
                raise RuntimeError("Invalid model output")
            row = [float(value) for value in vector]
            if not all(math.isfinite(value) for value in row):
                raise RuntimeError("Invalid model output")
            checked.append(row)
        return {
            "model": MODEL,
            "revision": self.revision,
            "dimension": DIMENSION,
            "vectors": checked,
        }


def make_handler(service: MemoryService) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, format: str, *args: Any) -> None:
            # BaseHTTPRequestHandler's default request log is intentionally disabled.
            return

        def log_error(self, format: str, *args: Any) -> None:
            return

        def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
            # BaseHTTPRequestHandler otherwise returns an HTML 501 for unknown verbs.
            status = 405 if code == 501 else code
            self._error(status, "Method not allowed" if status == 405 else "Bad request", close=True)

        def _json(self, status: int, payload: dict[str, Any], *, close: bool = True) -> None:
            body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
            if close:
                self.close_connection = True
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                if close:
                    self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                # A client may disconnect while inference runs; don't emit text or tracebacks.
                self.close_connection = True

        def _error(self, status: int, message: str, *, close: bool = True) -> None:
            self._json(status, {"error": message}, close=close)

        def do_GET(self) -> None:
            if self.path != "/health":
                self._error(404, "Not found")
                return
            self._json(200, service.health())

        def do_POST(self) -> None:
            if self.path != "/embed":
                self._error(404, "Not found", close=True)
                return
            if self.headers.get("Transfer-Encoding") is not None:
                self._error(400, "Chunked transfer encoding is not supported", close=True)
                return
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1:
                self._error(411, "Content-Length is required", close=True)
                return
            raw_length = lengths[0]
            if not raw_length.isascii() or not raw_length.isdecimal():
                self._error(400, "Invalid Content-Length", close=True)
                return
            length = int(raw_length)
            if length > MAX_BODY_BYTES:
                self._error(413, "Request body too large", close=True)
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                self._error(415, "Content-Type must be application/json", close=True)
                return
            try:
                body = self.rfile.read(length)
            except (OSError, TimeoutError):
                self._error(400, "Could not read request body", close=True)
                return
            if len(body) != length:
                self._error(400, "Incomplete request body", close=True)
                return
            try:
                request = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
                self._error(400, "Invalid JSON")
                return
            if not isinstance(request, dict):
                self._error(400, "Request must be a JSON object")
                return
            texts = request.get("texts")
            input_type = request.get("input_type")
            if input_type not in ("query", "passage"):
                self._error(400, "input_type must be query or passage")
                return
            if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_TEXTS:
                self._error(400, "texts must contain 1 to 32 strings")
                return
            if any(not isinstance(text, str) or not text or len(text) > MAX_TEXT_CHARS for text in texts):
                self._error(400, "Each text must be a nonempty string of at most 8000 characters")
                return
            try:
                result = service.embed(texts, input_type)
            except Exception:
                self._error(500, "Embedding failed", close=True)
                return
            self._json(200, result)

        def _method_not_allowed(self) -> None:
            if self.command == "HEAD":
                self.close_connection = True
                self.send_response(405)
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                return
            self._error(405, "Method not allowed", close=True)

        do_HEAD = _method_not_allowed
        do_PUT = _method_not_allowed
        do_DELETE = _method_not_allowed
        do_PATCH = _method_not_allowed
        do_OPTIONS = _method_not_allowed

    return Handler


def load_engine() -> tuple[Any, str]:
    cache = Path(os.environ.get("FASTEMBED_CACHE_PATH", "/opt/fastembed"))
    revision = (cache / "model-revision.sha256").read_text(encoding="ascii").strip()
    if len(revision) != 64 or any(character not in "0123456789abcdef" for character in revision):
        raise RuntimeError("Model artifact fingerprint is invalid")

    thread_setting = os.environ.get("EMBEDDING_THREADS", "4")
    try:
        threads = int(thread_setting)
    except ValueError as exc:
        raise RuntimeError("EMBEDDING_THREADS must be a positive integer") from exc
    if not 1 <= threads <= 64:
        raise RuntimeError("EMBEDDING_THREADS must be between 1 and 64")

    from fastembed import TextEmbedding

    engine = TextEmbedding(
        model_name=MODEL,
        cache_dir=str(cache),
        threads=threads,
        local_files_only=True,
    )
    # Make readiness contingent on actual local ONNX/tokenizer initialization.
    warmup = list(engine.passage_embed(["readiness check"]))
    if len(warmup) != 1 or len(warmup[0]) != DIMENSION:
        raise RuntimeError("Model initialization returned an unexpected shape")
    return engine, revision


def main() -> None:
    engine, revision = load_engine()
    server = HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "6335"))), make_handler(MemoryService(engine, revision)))
    server.timeout = 1

    def stop(_signum: int, _frame: Any) -> None:
        # shutdown() must run off the serve_forever thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
