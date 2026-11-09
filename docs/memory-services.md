# Local durable-memory services

These services are an optional local dependency for semantic memory. Lexical memory remains usable without them. They contain no archive mounts and the embedding API does not persist submitted text.

## What runs

- **Qdrant `qdrant/qdrant:v1.15.4`** listens on `127.0.0.1:6333` from the host. Its storage is the named Docker volume `pi-memory_qdrant-data` (Compose project `pi-memory`). Qdrant has a 1 GiB memory limit and one-CPU limit. Its image does not provide a dependable `curl` healthcheck client, so this Compose file does not declare a Qdrant healthcheck.
- **FastEmbed CPU service** listens on `127.0.0.1:6335`; `GET /health` reports ready only after the local model and tokenizer are initialized. It is limited to 2 GiB and four CPUs, runs as an unprivileged UID, drops Linux capabilities, and processes requests serially. `EMBEDDING_THREADS` defaults to 4; configure it via Compose interpolation, e.g. `PI_MEMORY_THREADS=2 docker compose -f services/memory/compose.yaml up -d --build`.
- The model is `BAAI/bge-small-en-v1.5`, FastEmbed `0.7.4`, with 384-dimensional vectors and a 512-token model limit. The ONNX model is roughly 67 MB, with tokenizer/config files and Python runtime dependencies in addition. The container memory limit is a ceiling, not a measured resident-memory claim.

The Compose project declares a dedicated bridge network, publishes only the two loopback-bound ports, and mounts no host directories. Docker 29 on the tested host did not publish ports for an internal-only network, so this configuration does **not** provide firewall-enforced outbound isolation. No ports on unrelated services are touched. Qdrant intentionally retains its normal image user/volume initialization behavior rather than imposing a potentially incompatible UID or capability restriction.

## Build, start, stop, and remove

Run these commands from the repository root. The Compose file explicitly names project `pi-memory`, so the volume name stays predictable:

```sh
docker compose -f services/memory/compose.yaml config
docker compose -f services/memory/compose.yaml up -d --build
docker compose -f services/memory/compose.yaml ps
curl --fail http://127.0.0.1:6335/health
curl --fail http://127.0.0.1:6333/healthz
```

The embedder image build downloads the model artifacts from Hugging Face; a working network is required for the first build. If Docker's default build bridge cannot resolve package hosts on Linux, build explicitly with `docker build --network host --tag pi-memory-embedder services/memory`, then use `docker compose -f services/memory/compose.yaml up -d --no-build`. This changes only build networking, not the dedicated runtime bridge or loopback port bindings. It fingerprints the bytes and relative paths of the actual downloaded model/tokenizer/config artifacts in deterministic sorted order, excluding HF locks and FastEmbed metadata. That SHA-256 digest is returned as `revision` by both service endpoints. The build also warms the model to catch incomplete downloads. At runtime, FastEmbed is explicitly `local_files_only`; `HF_HUB_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`, and `TRANSFORMERS_OFFLINE=1` are set. Model use does not require a runtime model download; Qdrant telemetry is explicitly disabled. Runtime networking permits outbound traffic, although embedding uses local ONNX inference and the API implementation makes no remote inference calls.

To stop the containers but retain them and the data volume:

```sh
docker compose -f services/memory/compose.yaml stop
```

To remove containers and the private network while retaining the named Qdrant volume:

```sh
docker compose -f services/memory/compose.yaml down
```

To permanently delete the Qdrant collection data as well, explicitly remove the volume:

```sh
docker compose -f services/memory/compose.yaml down --volumes
```

That last command is destructive. Rebuilding/recreating the embedder alone does not delete Qdrant data. If model artifact bytes change, the reported revision changes; vectors made with the old revision must not be mixed with the new model. Rebuild/re-embed the semantic index (or its collection) before using it with the changed model. For example:

```sh
docker compose -f services/memory/compose.yaml build --no-cache embedder
docker compose -f services/memory/compose.yaml up -d --force-recreate embedder
```

Do not delete the Qdrant volume merely to refresh the embedder image unless intentionally rebuilding all semantic index state.

## HTTP contract

`GET /health` returns JSON of the form:

```json
{"status":"ok","model":"BAAI/bge-small-en-v1.5","revision":"<artifact sha256>","dimension":384,"max_tokens":512,"service_version":1}
```

`POST /embed` requires `Content-Type: application/json` and a bounded, non-chunked request body:

```json
{"texts":["one or more strings"],"input_type":"query"}
```

`input_type` must be `query` or `passage`. Between 1 and 32 nonempty strings are accepted, each no longer than 8,000 Unicode characters. Query calls explicitly prepend BGE's `Represent this sentence for searching relevant passages: ` instruction before calling FastEmbed's `query_embed` (version 0.7.4 does not add it for this model). Passage calls use `passage_embed` without a prefix. Responses close their HTTP connection so an idle keep-alive client cannot monopolize the serial server. The response contains the model, artifact revision, dimension, and ordered 384-value finite vectors. Invalid requests receive a 4xx response; inference/model failures receive a generic 500 response. Request lines and submitted text are not logged, and error responses do not echo input or exception details. A client disconnect during inference is handled without logging the submitted text.

The embedding service is intended for local clients only. The API has no authentication, so do not change the loopback port bindings or expose it to an untrusted network. Keep raw archive text in the local archive: Qdrant should hold vectors and non-text source references/content hashes/offsets, not archive text. Search should dereference the archive and recheck scope and content hashes.
