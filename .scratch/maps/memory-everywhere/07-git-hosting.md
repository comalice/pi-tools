# Git hosting on the hub

**Type:** research
**Status:** closed
**Blocked by:** None

## Question

How does the canonical wiki remote live on the hub so spokes can clone/push over the Nebula? Survey the options (bare repo + per-spoke SSH keys + restricted shell; git daemon; lightweight hosting like Gitea/Forgejo), pick one, and document the setup including key enrollment. sshd is already enabled on the hub.

## Resolution

**Decision: bare repo over SSH, dedicated `git` user with `git-shell`, per-spoke ed25519 keys, spokes address the hub by an SSH `Host` alias — never by IP.**

Surveyed four options:

1. **Bare repo + per-spoke SSH keys + `git-shell` (chosen).** sshd is already enabled on the hub. A dedicated `git` user whose shell is `git-shell` can run git operations and nothing else; each spoke gets its own keypair, so revocation is "delete one line of `authorized_keys`". Zero new daemons, standard git semantics, hooks available. Works unchanged over the Nebula.
2. **git daemon (`git://`)** — rejected: anonymous and read-only; spokes push, so a second transport would be needed anyway. All cost, no win.
3. **Gitea/Forgejo** — rejected: users/PRs/web UI for a one-user system; another stateful service (own DB, config) that the hub-export bundle would have to carry. If the managed-service fog ever graduates, a real hosting layer is decided there, not here.
4. **Smart-HTTP inside `pi-memory-hub`** — rejected for v1: `git http-backend` behind our node server is workable but weird, and reusing the hub token was the only attraction. Keeping the hub service small beats consolidating transports. Revisit if SSH key management ever becomes the pain point.

Setup (documented for ticket 06 and the runbook):

- Hub: `useradd -m -s /usr/bin/git-shell git`; canonical remote at `/home/git/wiki.git` (bare). The hub's working clone `~/.pi/agent/wiki` gets `origin` pointing at the bare repo; librarian commits push as today.
- Spoke addressing: `memory join` writes a `Host memory-hub` entry (with the hub's current Nebula IP) into the spoke's `~/.ssh/config`; the git remote is `git@memory-hub:wiki.git`. No IPs in remotes, no sudo — this is the v1 answer to hub mobility for git, matching the `hub.json` pointer for the API. A hub move = re-run `memory join` (rewrites both pointers).
- Key enrollment is HITL: spoke generates an ed25519 keypair if absent; the human appends the pubkey to `/home/git/.ssh/authorized_keys` on the hub (one line per spoke, comment = spoke hostname).
- Migration: the bare repo is a plain directory and rides the `hub-export` bundle; `authorized_keys` goes in the bundle as hub config (public material only). `hub-init` recreates the `git` user and repo path.

**Superseded (2026-11-10) by [ticket 11](11-git-over-http-enroll.md):** git-shell hosting was abandoned after the first live onboarding attempt — the account/keys/sudo overhead was the worst part of the flow. Git moves into `pi-memory-hub` as token-gated smart-HTTP; no unix accounts, no SSH keys. The `wikigit` account created during the aborted run was removed. The per-spoke-key model survives only as the future Forgejo path (cluster-orchestration decision 15).

**Amendment (2026-11): hosting account renamed `git` → `wikigit`.** The host-level transitional Forgejo on the hub runs as the distro `git` user (home `/`), so the originally planned account collides with a live service account. The dedicated hosting account is now `wikigit` (home `/home/wikigit`, repo `/home/wikigit/wiki.git`, remote `wikigit@memory-hub:wiki.git`); `join`, the onboarding wizard, docs, and tests were updated to match. This hosting layer remains interim either way: cluster-orchestration decision 15 (Forgejo as the forge) supersedes git-shell hosting when the Forgejo remote is stood up.