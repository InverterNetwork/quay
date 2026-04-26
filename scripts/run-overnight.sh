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

# pre-flight
[[ -z "$(git status --porcelain)" ]] || { echo "Working tree dirty; commit or stash first." >&2; exit 2; }
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "Not on main." >&2; exit 2; }
command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun not on PATH" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not on PATH" >&2; exit 2; }

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
  local budget; budget="$(jq -r '.max_budget_usd_per_iteration' "$config")"

  echo
  echo "═══════════════════════════════════════════════════════════"
  echo "SLICE ${slice} → ${branch}  (max ${max_iter} attempts, \$${budget}/attempt)"
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

    if ! claude -p \
        --dangerously-skip-permissions \
        --max-budget-usd "${budget}" \
        --output-format stream-json \
        --verbose \
        --add-dir "${ROOT}" \
        < "${prompt_path}" \
        > "${out_path}" 2> "${err_path}"; then
      echo "[${branch}] claude exited non-zero on attempt ${i} (continuing to gate)"
    fi

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

  # Gate passed. ff-merge to main.
  echo "[${branch}] gate passed; ff-merging to main"
  git switch main
  git merge --ff-only "${branch}"
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
