# Memory hub and spokes

One machine (the hub) serves its archive to authenticated remote machines
(spokes) and accepts their pushed Pi sessions. Root doc:
[`memory.md`](memory.md). How pushed sessions are ingested:
[`memory-ingestion.md`](memory-ingestion.md).

## The hub service

`pi-memory-hub` serves the archive to authenticated remote spokes and accepts
pushed Pi sessions. It uses plain `node:http`, Bearer authentication, and JSON
responses. The endpoints are:

- `GET /status` — service version, archive schema, per-source session counts,
  uptime in seconds, and the calling token's spoke identity.
- `POST /search` — JSON fields `query`, optional `cues`, `limit` (1–10),
  `mode`, `cosineFloor`, `source`, `session`, `scope`, and optional `project`.
  Optional `currentSession` excludes the active spoke session and its timestamp
  from `archive.latest`, matching local extension search. Response fields match
  local memory search (`results`, `retrieval`, and `archive.latest`). When both
  `scope` and `project` are absent, hub search defaults to `all`; use
  `scope: "project"` with the archive's project value
  to restrict results. Semantic/hybrid retrieval uses the hub's configured
  vector services just like local retrieval.
- `POST /expand` — JSON fields `id`, optional `source`, `scope`, `project`,
  `maxChars`, `offset`, `direction`, `branchId`, and `includeReplies`; returns
  the local expansion result shape.
- `POST /ingest` — JSON `{ "source": "pi", "filename": "session.jsonl",
  "content_base64": "..." }`. It stores the payload as a content-addressed
  blob and ingests it with the authenticated spoke name as its origin. An
  updated push from the same spoke and filename replaces that prior session
  snapshot; an exact re-push is deduplicated. Pushes are serialized
  in-process. OpenCode push is not supported.
- `GET|HEAD|POST /git/wiki.git/...` — Git smart-HTTP, authenticated with that
  same Bearer token. The hub delegates CGI requests to `git http-backend`; only
  the single `wiki.git` repository is served. It is created lazily under
  `$PI_CODING_AGENT_DIR/wiki-git/wiki.git` (normally
  `~/.pi/agent/wiki-git/wiki.git`).

The hub binds to `127.0.0.1:6342` by default. Configure `PI_HUB_BIND` /
`PI_HUB_PORT` or `--bind` / `--port`; `resolveBindAddress` accepts only literal
IPv4/IPv6 addresses. The same token authorizes memory API calls and Git clone,
fetch, and push. Do not expose the plain-HTTP listener directly to an untrusted
network: use a trusted private network or a TLS-terminating reverse proxy, and
protect the bearer token as a credential. Search and expansion can return
archived conversation text to any holder of a valid spoke token.

Install the user service alongside the other units with `make install-systemd`;
it is enabled immediately. Override its bind and port at install time, for
example `make install-systemd PI_HUB_BIND=0.0.0.0 PI_HUB_PORT=6342`. The service
uses the normal writable archive opener at startup, applying supported schema
migrations before opening a separate exact-schema read-only connection for
search/expand. It creates an empty archive if none exists; the first successful
push registers Pi as an import-backed blob source. Once that happens, regular
`memory ingest` reconciles the registered blob root rather than the local live
sessions directory. Imported Pi blobs are retained until explicitly forgotten;
normal watch-source pruning semantics remain unchanged for live session roots.

## Spoke onboarding

The operator's goal is exactly two actions on a new computer: install the
project, then generate and paste one key to the hub. No account provisioning or
privileged setup is required on either machine. The hub must already be
reachable over the trusted private network — including its host firewall:
the hub's input rules must accept the API port (default 6342) from the
overlay subnet on the overlay interface, the same way SSH is typically
allowed. A firewall REJECT surfaces on the spoke as an instant "could not
connect"; `pi-memory enroll` cannot distinguish that from an unregistered
token and will keep polling, so verify reachability first with
`curl http://<hub>:6342/status` (expect a `Bearer token required` reply).
The hub's
wiki clone must be connected to the local bare repository once:

```sh
pi-memory hub-git-init
```

That command creates the bare repository if needed and points the hub's working
`~/.pi/agent/wiki` clone's `origin` at it. Run it after deploying the hub and
before enrolling spokes; install the CLI on the hub with `make install-bin` if
it is not already available.

On the new spoke:

1. Clone this repository and install its executable:

   ```sh
   git clone <dirac-pi-tools-repository>
   cd dirac-pi-tools
   make install-bin
   ```

   `make install-bin` installs npm dependencies (`npm ci`; several pi
   extensions need them, and pi cannot load those extensions on a bare
   clone), installs the `pi-memory`/`pi-wiki`/`pi-dream` shims
   under `~/.local/bin` (ensure that directory is on `PATH`) and, when `pi`
   is available, registers this checkout as a pi package so `memory_search`
   and the other extension tools exist in pi sessions. If pi is not
   installed yet it prints a skip note; run `pi install <checkout>` after
   installing pi. Re-running is safe: an already-registered checkout is
   left alone, and a registration pointing at a moved or deleted checkout
   is reported rather than rewritten.

2. Enroll against the hub's private-network IP. The command generates a
   32-byte secret locally and prints one command containing it exactly once:

   ```sh
   pi-memory enroll 100.64.0.12
   ```

   Copy/paste the printed `pi-memory hub-token register <spoke> '<secret>'`
   command on the hub. Enrollment polls about every five seconds for up to
   fifteen minutes until that token is accepted, then writes private `hub.json`,
   clones the wiki over HTTP, persists the Bearer
   header in the clone's private `.git/config`, and runs `make install-spoke`
   to enable the 15-minute push timer. The secret is not written to `hub.json`
   until registration succeeds. `--no-push` skips timer installation when the
   spoke has no usable `systemctl --user` manager; use `pi-memory push` manually.

`hub.json` is stored at `~/.pi/agent/memory/hub.json` (or beneath
`PI_CODING_AGENT_DIR`) with mode 0600. The wiki checkout directory is mode 0700
and its `.git/config` is mode 0600 because that file retains the Bearer header
needed for later Git fetch/push. Protect the spoke account accordingly. An
empty hub repository is expected on first clone; Git's standard empty-repository
warning is not a failure.

For headless or pre-minted enrollment, use `pi-memory join` with a raw token
(`--token` or `--token-stdin`) or the `pih1` bundle emitted by `hub-token add`:

```sh
pi-memory join <hub-host> --token-stdin --no-push
# or
pi-memory join 'pih1.<base64url-hub-payload>.<secret>' --no-push
```

The bundle carries both the hub origin and token. Existing `hub.json` is never
overwritten implicitly; `--force` backs it up before replacement. Existing wiki
checkouts are accepted only when their HTTP origin matches the selected hub,
then fetched and fast-forwarded. `pi-memory join --status` verifies API access
and spoke identity.

## Remote extension mode

If `$PI_CODING_AGENT_DIR/memory/hub.json` exists (normally
`~/.pi/agent/memory/hub.json`), `memory_search` and `memory_expand` send their
requests to that hub's `/search` and `/expand` endpoints using the configured
Bearer token. The file must be a regular private file (mode 0600 or stricter)
containing `{"hub":"http://host:port","token":"<spoke-token>"}`; the hub
must be an HTTP(S) origin without a path, query, fragment, or embedded
credentials. `memory join` creates this file. The extension validates the
configuration on each tool call, uses a 30-second request/response timeout,
and does not open or ingest a local archive while the pointer exists.

Remote requests preserve the local tools' parameters, project/current-session
scope, result details, and successful output shape. Search additionally ends
with `hub archive latest: <timestamp>` (or `unknown`) because the hub reports
its archive timestamp. Network failures, HTTP errors (including revoked or
invalid tokens), and invalid configuration are returned as tool errors naming
the hub or configuration path. There is deliberately no fallback to a local
archive when a hub pointer is present. If `hub.json` is absent, the extension
uses local mode unchanged.

## Spoke push

On a spoke, `memory push` sends recursively discovered `*.jsonl` files from
`~/.pi/agent/sessions/` to the configured hub with one authenticated `POST
/ingest` per file. The `pi` source only is supported; OpenCode, Claude, and Grok
exports are not pushed. The hub assigns the authenticated spoke identity as
origin, so the spoke does not send or choose `origin`.

The command reads `~/.pi/agent/memory/hub.json` (under
`PI_CODING_AGENT_DIR` when set), in the form
`{"hub":"http://<host>:<port>","token":"..."}`. It reports that `memory
enroll` or `memory join` must be run first when the file is absent. Hub URLs must
be an HTTP(S) origin without a path; redirects are rejected so the bearer token
is not forwarded elsewhere. The file is not changed by `memory push`.

Incrementality is tracked in `~/.pi/agent/memory/push-state.json`, mode 0600.
Each relative session path has its byte size, modification time, and full
SHA-256 fingerprint. The full hash is intentional: session files are
append-mostly and hashing each file also detects same-size rewrites or restored
mtimes, which a size/mtime-only check would silently miss. Unchanged files are
not uploaded. Successful files advance their own watermark even if another
file fails; failed files retain their old fingerprint and will be retried on
the next run. The spoke tags the basename with a stable hash of its relative
session path, so same-named files in different subdirectories stay distinct.
The hub treats that uploaded filename as the snapshot key within the spoke,
replacing earlier content when an append-mostly session changes. The last-run
timestamp advances only after a wholly successful run. Failures are logged per
file, processing continues, and any failure makes
the command exit nonzero. There is no durable spool; hub-side content hashing
makes an upload repeated after a crash safe.

To install just the spoke timer (without installing or enabling hub services),
run `make install-spoke`. It runs `memory push` every 15 minutes, starting two
minutes after boot; configure the hub file first. Remove it with
`make uninstall-spoke`. The timer is optional; run `npm run memory -- push` to
push manually.

## Token administration

Tokens are administered only on the hub host with the local memory CLI:

```sh
# Generate a token and a pih1 bundle for headless bootstrap:
pi-memory hub-token add laptop --advertise http://100.64.0.1:6342
# Adopt the secret generated by `pi-memory enroll` on a spoke:
pi-memory hub-token register laptop '<43-character-base64url-secret>'
pi-memory hub-token list
pi-memory hub-token revoke laptop
```

`add` prints the generated token and a `pih1.<base64url-json>.<secret>` bundle
once; JSON payload `{"hub":"http://host:port"}` carries the advertised address.
Supply `--advertise` when the hub's listen address is not the address spokes use;
otherwise the command uses `PI_HUB_BIND` / `PI_HUB_PORT`, then
`127.0.0.1:6342`. A loopback address prints a warning because that bundle is
useful only on the hub itself. `join <bundle>` accepts the bundle directly;
raw-token `--token` and `--token-stdin` remain available for automation.
`register` accepts only a 32-byte canonical base64url secret and refuses a
second active token for the same spoke; revoke before replacing it. `list`
prints spoke names and creation times only. The private token map is
`~/.pi/agent/memory/hub-tokens.json` (or beneath `PI_CODING_AGENT_DIR`), mode
0600. Revocation takes effect on the next request and disables that spoke's
memory and Git access. Tokens are never managed over HTTP.
