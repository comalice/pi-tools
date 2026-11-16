#!/usr/bin/env bash
# run-axis.sh <fixed-point> <brief-file> <output-file>
#
# Runs one review axis as an isolated headless pi process: fresh context, no
# session, no skills (the sub-agent cannot rediscover the code-review skill),
# no extensions or MCP servers, no context files (the reviewed repo's
# AGENTS.md/CLAUDE.md must not reach the reviewer's system context), tools
# restricted to read+bash, capped at $AXIS_TIMEOUT_SECONDS (default 30
# minutes) when a coreutils timeout binary is available. This is the
# harness-level guard against recursive agent fan-out.
#
# PI_REVIEW_MODEL overrides the model for axis processes.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: run-axis.sh <fixed-point> <brief-file> <output-file>" >&2
  exit 2
fi

POINT="$1"
BRIEF="$2"
OUT="$3"

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

git -C "$REPO_ROOT" diff "$POINT"...HEAD > "$WORKDIR/diff.patch"
git -C "$REPO_ROOT" log "$POINT"..HEAD --oneline > "$WORKDIR/commits.txt"

{
  cat "$BRIEF"
  printf '\n## Inputs\n\n'
  printf -- '- Repo root: %s\n' "$REPO_ROOT"
  printf -- '- Diff (%s...HEAD): %s/diff.patch\n' "$POINT" "$WORKDIR"
  printf -- '- Commit list: %s/commits.txt\n' "$WORKDIR"
  printf '\nRead the diff and commit list first, then review. Write your report to stdout and nothing else.\n'
} > "$WORKDIR/prompt.md"

# Single command array, always non-empty: no empty-array expansion, so this
# is safe on bash 3.2 under `set -u` with or without PI_REVIEW_MODEL.
CMD=(pi --print --no-session --no-skills --no-extensions --no-context-files --tools read,bash)
if [ -n "${PI_REVIEW_MODEL:-}" ]; then
  CMD+=(--model "$PI_REVIEW_MODEL")
fi
# Cap the run at $AXIS_TIMEOUT_SECONDS (default 30 minutes) when a timeout
# binary exists; run uncapped when neither exists. macOS ships neither
# `timeout` nor `gtimeout` — gtimeout comes from `brew install coreutils`.
TIMEOUT_SECONDS="${AXIS_TIMEOUT_SECONDS:-1800}"
if command -v timeout >/dev/null 2>&1; then
  CMD=(timeout "$TIMEOUT_SECONDS" "${CMD[@]}")
elif command -v gtimeout >/dev/null 2>&1; then
  CMD=(gtimeout "$TIMEOUT_SECONDS" "${CMD[@]}")
fi
"${CMD[@]}" "Read $WORKDIR/prompt.md and follow its instructions exactly." > "$OUT"
