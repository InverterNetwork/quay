#!/usr/bin/env bash
# Drive Quay slices 0..10 unattended.
#
# For each slice:
#   1. Branch off main → slice-N-<name>.
#   2. Up to N attempts of `claude -p < prompt`. Between attempts, append
#      gate failure feedback so the next attempt sees what blocked the last.
#   3. After each attempt, run scripts/gate.sh <N>.
#   4. On gate pass: ff-merge to main, continue.
#   5. On exhaustion: write CHAIN-STOPPED note, exit non-zero.
#
# Pre-flight: clean working tree on main, claude/bun/jq available.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SLICES=(${QUAY_SLICES:-0 1 2 3 4 5 6 7 8 9 10})

# pre-flight (scope dirty-tree check to the quay/ subtree — the
# enclosing git repo may have unrelated changes at higher levels)
[[ -z "$(git status --porcelain -- .)" ]] || { echo "Working tree dirty under $(pwd); commit or stash first." >&2; exit 2; }
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "Not on main." >&2; exit 2; }
command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun not on PATH" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not on PATH" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh CLI not on PATH" >&2; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "gh CLI not authenticated; run 'gh auth login'" >&2; exit 2; }
git remote get-url origin >/dev/null 2>&1 || { echo "no 'origin' remote configured; cannot open PRs" >&2; exit 2; }

# Portable wall-clock timeout for the headless attempt.
# Linux: GNU coreutils `timeout`. macOS via Homebrew coreutils:
# `gtimeout`. Otherwise a pure-bash watchdog using a backgrounded
# killer. Exits 124 on overrun (matching GNU `timeout` semantics)
# and 137 if SIGKILL was needed after the grace period.
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
  # Pure-bash fallback (macOS without coreutils).
  # Background jobs in non-interactive bash read from /dev/null unless stdin is
  # explicitly preserved. Keep the caller's prompt redirection attached to the
  # child process.
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

LOG_DIR="docs/ralph/runs/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$LOG_DIR"
echo "[driver] log dir: $LOG_DIR"

run_slice() {
  local slice="$1"
  local config="docs/ralph/gates/slice-${slice}.json"
  local prompt_file="docs/ralph/slice-${slice}.md"
  [[ -f "$config" ]] || { echo "Missing $config" >&2; return 2; }
  [[ -f "$prompt_file" ]] || { echo "Missing $prompt_file" >&2; return 2; }

  local name; name="$(jq -r '.name' "$config")"
  local branch="slice-${slice}-${name}"
  local promise; promise="$(jq -r '.completion_promise' "$config")"
  local max_iter; max_iter="$(jq -r '.max_iterations' "$config")"
  # Per-attempt wall-clock cap (seconds). Subscription billing has no
  # dollar cap; the only safety we need is "kill an attempt that hangs"
  # so the driver can move on to the next attempt or the gate.
  local timeout_s; timeout_s="$(jq -r '.attempt_timeout_seconds // 1800' "$config")"

  echo
  echo "═══════════════════════════════════════════════════════════"
  echo "SLICE ${slice} → ${branch}  (max ${max_iter} attempts, ${timeout_s}s wall-clock per attempt)"
  echo "═══════════════════════════════════════════════════════════"

  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    echo "[driver] branch ${branch} already exists; deleting" >&2
    git branch -D "${branch}"
  fi
  git switch -c "${branch}" main

  local feedback_file=".quay-attempt-feedback.md"
  rm -f "${feedback_file}"

  local ok=0
  local i
  for ((i=1; i<=max_iter; i++)); do
    echo "[${branch}] attempt ${i} / ${max_iter}"

    local prompt_path="${LOG_DIR}/slice-${slice}-attempt-${i}.prompt.md"
    {
      cat "${prompt_file}"
      if [[ -f "${feedback_file}" ]]; then
        echo
        echo "## Prior attempt feedback (gate output)"
        echo
        cat "${feedback_file}"
      fi
      echo
      echo "## Required final output"
      echo
      echo "When (and only when) every check above is true, end your turn"
      echo "with this exact line:"
      echo
      echo "    <promise>${promise}</promise>"
    } > "${prompt_path}"

    local out_path="${LOG_DIR}/slice-${slice}-attempt-${i}.out.jsonl"
    local err_path="${LOG_DIR}/slice-${slice}-attempt-${i}.err.log"

    # Wall-clock-bounded headless attempt. We intentionally do NOT pass
    # --max-budget-usd: that flag is for API-key billing and on a
    # subscription it is dead weight. Worse, when it does fire (we've
    # observed it) the headless process hangs instead of exiting,
    # blocking the driver indefinitely. The wall-clock guard is the
    # real safety: if claude hangs for any reason, SIGTERM lands at
    # +timeout_s and the driver moves on to commit + gate the
    # partial work.
    set +e
    run_with_timeout "${timeout_s}" claude -p \
        --permission-mode bypassPermissions \
        --output-format stream-json \
        --verbose \
        --add-dir "${ROOT}" \
        < "${prompt_path}" \
        > "${out_path}" 2> "${err_path}"
    local rc=$?
    set -e
    case "$rc" in
      0)   ;;
      124) echo "[${branch}] claude hit ${timeout_s}s wall-clock cap on attempt ${i} (continuing to gate)";;
      137) echo "[${branch}] claude SIGKILL'd after grace period on attempt ${i} (continuing to gate)";;
      *)   echo "[${branch}] claude exited ${rc} on attempt ${i} (continuing to gate)";;
    esac

    # Commit WIP BEFORE the gate so the gate evaluates committed branch
    # state, not a dirty working tree. This is what gets ff-merged to
    # main when the gate passes.
    git add -A
    if ! git diff --cached --quiet; then
      git -c user.email=quay-driver@local -c user.name='quay driver' \
        commit -q -m "slice-${slice}: attempt ${i}"
    fi

    # Run the gate.
    local gate_log="${LOG_DIR}/slice-${slice}-attempt-${i}.gate.log"
    if scripts/gate.sh "${slice}" > "${gate_log}" 2>&1; then
      cat "${gate_log}"
      ok=1
      break
    fi
    cat "${gate_log}"

    # Find the most recent GATE-slice-N-*.md created by this gate run and
    # surface its body as feedback to the next attempt.
    local latest_blocker
    latest_blocker="$(ls -t docs/ralph/blockers/GATE-slice-${slice}-*.md 2>/dev/null | head -n1 || true)"
    {
      echo
      echo "### Attempt ${i} — gate failed"
      if [[ -n "${latest_blocker}" ]]; then
        cat "${latest_blocker}"
      else
        tail -50 "${gate_log}"
      fi
    } >> "${feedback_file}"
  done

  if (( ok == 0 )); then
    {
      echo "# Chain stopped at slice ${slice}"
      echo
      echo "**At:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "**Branch:** ${branch}"
      echo "**Attempts used:** ${max_iter}"
      echo
      echo "## Last gate output"
      echo
      echo '```'
      tail -120 "${LOG_DIR}/slice-${slice}-attempt-${max_iter}.gate.log" 2>/dev/null || echo '(none)'
      echo '```'
      echo
      echo "## Accumulated feedback"
      echo
      cat "${feedback_file}" 2>/dev/null || echo '(empty)'
    } > "docs/ralph/blockers/CHAIN-STOPPED-slice-${slice}.md"
    echo "[driver] CHAIN STOPPED at slice ${slice} — see docs/ralph/blockers/CHAIN-STOPPED-slice-${slice}.md" >&2
    return 1
  fi

  # Gate passed. Push slice branch, open PR, merge via gh, sync main.
  # Each slice gets one PR on origin for review/audit; the merge style
  # is squash so main stays linear and per-slice.
  echo "[${branch}] gate passed; pushing branch and opening PR"

  # Push (force-with-lease in case we re-ran the slice and the remote
  # branch already exists from a previous attempt).
  git push --force-with-lease -u origin "${branch}"

  local pr_title="slice ${slice}: ${name}"
  local pr_body
  pr_body="$(printf 'Slice %s of the Quay TDD chain.\n\n## Spec coverage\n\n%s\n\n## Tests added\n\n%s\n\n_Created by `scripts/run-overnight.sh` after `scripts/gate.sh %s` passed._' \
    "${slice}" \
    "$(jq -r '.spec_coverage' "${config}")" \
    "$(jq -r '.expected_tests | map("- `" + . + "`") | join("\n")' "${config}")" \
    "${slice}")"

  # Idempotent PR creation: if a PR already exists for this branch
  # (re-run case), reuse it. Otherwise create.
  local pr_url
  pr_url="$(gh pr view "${branch}" --json url -q .url 2>/dev/null || true)"
  if [[ -z "${pr_url}" ]]; then
    pr_url="$(gh pr create --base main --head "${branch}" \
      --title "${pr_title}" --body "${pr_body}")"
  fi
  echo "[${branch}] PR: ${pr_url}"

  # Merge the PR. Squash collapses the per-attempt commits (if any)
  # into a single slice commit on main. --delete-branch removes the
  # remote branch after merge so origin stays tidy.
  gh pr merge "${branch}" --squash --delete-branch

  # Pull main so the local repo reflects the merged state before the
  # next slice branches off it.
  git switch main
  git pull --ff-only origin main
  # Local slice branch is now stale (its tip != main's history).
  git branch -D "${branch}" 2>/dev/null || true
  rm -f "${feedback_file}"
}

for s in "${SLICES[@]}"; do
  if ! run_slice "$s"; then
    exit 1
  fi
done

echo
echo "═══════════════════════════════════════════════════════════"
echo "ALL SLICES COMPLETE"
echo "═══════════════════════════════════════════════════════════"
