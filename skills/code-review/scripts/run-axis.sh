#!/usr/bin/env bash
# run-axis.sh <fixed-point> <brief-file> <output-file>
#
# Runs one review axis as an isolated headless pi process: fresh context, no
# session, no skills (the sub-agent cannot rediscover the code-review skill),
# no extensions or MCP servers, tools restricted to read+bash. This is the
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

MODEL_ARGS=()
if [ -n "${PI_REVIEW_MODEL:-}" ]; then
  MODEL_ARGS=(--model "$PI_REVIEW_MODEL")
fi

pi --print --no-session --no-skills --no-extensions --no-mcp \
  --tools read,bash \
  "${MODEL_ARGS[@]}" \
  "Read $WORKDIR/prompt.md and follow its instructions exactly." \
  > "$OUT"
