"""Download and fingerprint the exact FastEmbed model artifacts at image build time."""

import hashlib
import os
from pathlib import Path

from fastembed import TextEmbedding

MODEL = "BAAI/bge-small-en-v1.5"
CACHE = Path(os.environ.get("FASTEMBED_CACHE_PATH", "/opt/fastembed"))
SNAPSHOTS = CACHE / "models--qdrant--bge-small-en-v1.5-onnx-q" / "snapshots"


def artifact_files(snapshot: Path) -> list[Path]:
    # Hash model/tokenizer/config artifacts only: omit FastEmbed metadata, HF locks,
    # timestamps, and cache bookkeeping so the identity is reproducible.
    files = [
        path
        for path in snapshot.rglob("*")
        if path.is_file()
        and not any(part.startswith(".") for part in path.relative_to(snapshot).parts)
        and path.name not in {"files_metadata.json"}
        and not path.name.endswith(".lock")
    ]
    return sorted(files, key=lambda item: item.relative_to(snapshot).as_posix())


def main() -> None:
    # Construction downloads the supported model files to CACHE. A warmup forces
    # tokenizer/ONNX loading as well, failing the image build if the cache is unusable.
    model = TextEmbedding(model_name=MODEL, cache_dir=str(CACHE), threads=4)
    vectors = list(model.passage_embed(["build-time model availability check"]))
    if len(vectors) != 1 or len(vectors[0]) != 384:
        raise RuntimeError("Unexpected model output shape")

    snapshots = sorted(path for path in SNAPSHOTS.iterdir() if path.is_dir())
    if len(snapshots) != 1:
        raise RuntimeError("Expected exactly one downloaded model snapshot")
    snapshot = snapshots[0]
    files = artifact_files(snapshot)
    if not files or not any(path.name.endswith(".onnx") for path in files):
        raise RuntimeError("Downloaded model artifacts are incomplete")

    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(snapshot).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    revision = digest.hexdigest()
    (CACHE / "model-revision.sha256").write_text(revision + "\n", encoding="ascii")
    print(f"Prefetched {MODEL}; artifact SHA-256: {revision}")


if __name__ == "__main__":
    main()
