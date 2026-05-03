#!/usr/bin/env bash
# Run multiple Quay slices in sequence on the CURRENT branch.
#
# Differs from scripts/run-overnight.sh in two ways:
#   1. Stays on a single branch (no per-slice branch-off-main, no
#      per-slice PR open + squash-merge to main). Each slice's
#      implementation lands as one commit on whatever branch is
#      currently checked out. The final merge to main is one PR for
#      the whole branch, opened manually.
#   2. Sets BASE_REF for the gate to the commit immediately before
#      the slice's implementation started. This means the gate's
#      "spec / ralph / scripts unchanged" assertions compare against
#      the prior slice's commit, not against main. Slice docs +
#      driver scripts that already exist on the branch are not
#      flagged as drift.
#
# Pre-flight: clean working tree on a non-main branch with the
# slice prompts and gate JSONs already committed. claude / bun /
# jq on PATH.
#
# Usage:
#   QUAY_SLICES="11 12 13 14 15 16 17 18 19" bash scripts/run-on-branch.sh
#
# Override the default slice set via the QUAY_SLICES env var. With no
# override, runs slices 11..19.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SLICES=(${QUAY_SLICES:-11 12 13 14 15 16 17 18 19})

# pre-flight (scope dirty-tree check to the quay/ subtree)
[[ -z "$(git status --porcelain -- .)" ]] || { echo "Working tree dirty under $(pwd); commit or stash first." >&2; exit 2; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "main" ]] || { echo "Refusing to run on main; check out a feature branch first." >&2; exit 2; }
[[ "$BRANCH" != "HEAD" ]] || { echo "Detached HEAD; check out a named branch first." >&2; exit 2; }
command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun not on PATH" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not on PATH" >&2; exit 2; }

echo "[driver] running slices on branch: $BRANCH"

# Portable wall-clock timeout (mirrors run-overnight.sh).
if command -v timeout >/dev/null; then
  TIMEOUT_CMD=(timeout --kill-after=30)
elif command -v gtimeout >/dev/null; then
  TIMEOUT_CMD=(gtimeout --kill-after=30)
else
  TIMEOUT_CMD=()
fi

run_with_timeout() {
  local secs=$1; shift
  if (( ${#TIMEOUT_CMD[@]} > 0 )); then
    "${TIMEOUT_CMD[@]}" "$secs" "$@"
    return $?
  fi
  "$@" <&0 &
  local child=$!
  (
    sleep "$secs"
    if kill -0 "$child" 2>/dev/null; then
      kill -TERM "$child" 2>/dev/null
      sleep 30
      kill -KILL "$child" 2>/dev/null
    fi
  ) &
  local watchdog=$!
  set +e
  wait "$child"
  local rc=$?
  set -e
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if (( rc == 143 )); then return 124; fi
  if (( rc == 137 )); then return 137; fi
  return "$rc"
}

LOG_DIR="docs/ralph/runs/$(date -u +%Y%m%dT%H%M%SZ)-on-branch"
mkdir -p "$LOG_DIR"
echo "[driver] log dir: $LOG_DIR"

for SLICE in "${SLICES[@]}"; do
  PROMPT="docs/ralph/slice-${SLICE}.md"
  GATE_CONFIG="docs/ralph/gates/slice-${SLICE}.json"
  [[ -f "$PROMPT" ]] || { echo "[driver] missing $PROMPT" >&2; exit 2; }
  [[ -f "$GATE_CONFIG" ]] || { echo "[driver] missing $GATE_CONFIG" >&2; exit 2; }

  MAX_ITER="$(jq -r '.max_iterations' "$GATE_CONFIG")"
  TIMEOUT_SECS="$(jq -r '.attempt_timeout_seconds' "$GATE_CONFIG")"
  SLICE_NAME="$(jq -r '.name' "$GATE_CONFIG")"
  PROMISE="$(jq -r '.completion_promise' "$GATE_CONFIG")"

  # BASE_REF for this slice = current HEAD before any implementation
  # work begins. Subsequent slices roll forward as their
  # implementations commit.
  BASE_REF="$(git rev-parse HEAD)"
  echo
  echo "============================================================"
  echo "[driver] slice $SLICE ($SLICE_NAME)"
  echo "[driver] base ref:        $BASE_REF"
  echo "[driver] max attempts:    $MAX_ITER"
  echo "[driver] attempt timeout: ${TIMEOUT_SECS}s"
  echo "============================================================"

  PROMPT_WORK="$(mktemp)"
  cp "$PROMPT" "$PROMPT_WORK"

  PASSED=0
  for (( ATTEMPT = 1; ATTEMPT <= MAX_ITER; ATTEMPT++ )); do
    ATTEMPT_LOG="$LOG_DIR/slice-${SLICE}-attempt-${ATTEMPT}.log"
    echo "[driver] slice $SLICE attempt $ATTEMPT → $ATTEMPT_LOG"

    set +e
    run_with_timeout "$TIMEOUT_SECS" \
      claude -p --dangerously-skip-permissions \
        --output-format stream-json --verbose \
        --add-dir "$ROOT" \
        < "$PROMPT_WORK" \
        > "$ATTEMPT_LOG" 2>&1
    CLAUDE_RC=$?
    set -e

    if (( CLAUDE_RC == 124 || CLAUDE_RC == 137 )); then
      echo "[driver] slice $SLICE attempt $ATTEMPT timed out ($CLAUDE_RC)" >&2
    elif (( CLAUDE_RC != 0 )); then
      echo "[driver] slice $SLICE attempt $ATTEMPT exited $CLAUDE_RC" >&2
    fi

    set +e
    BASE_REF="$BASE_REF" bash scripts/gate.sh "$SLICE" \
      > "$LOG_DIR/slice-${SLICE}-attempt-${ATTEMPT}.gate.log" 2>&1
    GATE_RC=$?
    set -e

    if (( GATE_RC == 0 )); then
      # Gate passed. The gate refuses dirty trees, so the agent
      # already committed (or there was nothing to commit). Either
      # way, lift everything new into one squashed slice commit so
      # the branch keeps one-commit-per-slice.
      if git rev-parse "$BASE_REF" >/dev/null 2>&1 && [[ "$(git rev-parse HEAD)" != "$BASE_REF" ]]; then
        echo "[driver] slice $SLICE: squashing $(git rev-list --count "$BASE_REF"..HEAD) attempt commits into one"
        git reset --soft "$BASE_REF"
        git commit -m "slice ${SLICE}: ${SLICE_NAME}

Implements docs/ralph/slice-${SLICE}.md.

Completion promise: ${PROMISE}.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
      else
        echo "[driver] slice $SLICE: no commits made; nothing to squash"
      fi
      echo "[driver] slice $SLICE: PASS"
      PASSED=1
      break
    fi

    # Gate failed. Append the latest GATE-slice-N-* blocker as
    # feedback for the next attempt's prompt.
    LATEST_BLOCKER="$(ls -t docs/ralph/blockers/GATE-slice-${SLICE}-*.md 2>/dev/null | head -1 || true)"
    if [[ -n "$LATEST_BLOCKER" ]]; then
      {
        echo
        echo "---"
        echo
        echo "## Prior attempt $ATTEMPT gate feedback (from $LATEST_BLOCKER)"
        echo
        cat "$LATEST_BLOCKER"
      } >> "$PROMPT_WORK"
    fi
    echo "[driver] slice $SLICE attempt $ATTEMPT: gate FAIL — feedback appended for next attempt"
  done

  rm -f "$PROMPT_WORK"

  if (( PASSED == 0 )); then
    STOP_FILE="docs/ralph/blockers/CHAIN-STOPPED-slice-${SLICE}.md"
    {
      echo "# Chain stopped at slice ${SLICE}"
      echo
      echo "**At:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "**Branch:** $BRANCH"
      echo "**Last HEAD:** $(git rev-parse --short HEAD)"
      echo "**Base ref:** $BASE_REF"
      echo
      echo "Exhausted $MAX_ITER attempts. Earlier slices' commits remain on this branch."
      echo "Inspect the per-attempt logs under \`$LOG_DIR/\` and the latest gate failure"
      echo "under \`docs/ralph/blockers/GATE-slice-${SLICE}-*.md\` for diagnosis."
    } > "$STOP_FILE"
    git add "$STOP_FILE" || true
    git commit -m "chain stopped at slice ${SLICE}: max attempts exhausted" || true
    echo "[driver] chain stopped at slice ${SLICE}; see $STOP_FILE" >&2
    exit 1
  fi
done

echo
echo "============================================================"
echo "[driver] all slices passed: ${SLICES[*]}"
echo "[driver] branch state:"
git log --oneline "$(git merge-base HEAD main)..HEAD"
echo
echo "Open a PR to merge $BRANCH → main when ready:"
echo "  gh pr create --base main --head $BRANCH"
echo "============================================================"
