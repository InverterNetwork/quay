#!/usr/bin/env bash
# Gate check for one Quay slice.
# Usage: scripts/gate.sh <slice-number>
# Exit codes:
#   0 — all checks passed; slice is mergeable.
#   1 — at least one check failed; details in docs/ralph/blockers/GATE-slice-N-*.md.
#   2 — usage / setup error (missing config, not in repo, etc).

set -euo pipefail

SLICE="${1:?slice number required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="docs/ralph/gates/slice-${SLICE}.json"
[[ -f "$CONFIG" ]] || { echo "Missing gate config: $CONFIG" >&2; exit 2; }
command -v jq >/dev/null  || { echo "jq not on PATH" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun not on PATH" >&2; exit 2; }

mkdir -p docs/ralph/blockers
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FAIL_LOG="docs/ralph/blockers/GATE-slice-${SLICE}-${TS}.md"

reasons=()
add_reason() { reasons+=("$1"); }

emit_fail() {
  {
    echo "# Gate failure: slice ${SLICE}"
    echo
    echo "**At:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "**Branch:** $(git rev-parse --abbrev-ref HEAD)"
    echo "**HEAD:** $(git rev-parse --short HEAD 2>/dev/null || echo '(none)')"
    echo
    echo "## Failures"
    for r in "${reasons[@]}"; do
      echo
      echo "$r"
    done
  } > "$FAIL_LOG"
  echo "GATE FAIL slice ${SLICE} — see ${FAIL_LOG}" >&2
  exit 1
}

# 1. bun test (full suite, not filtered)
TEST_LOG="$(mktemp)"
echo "[gate] bun test"
if ! bun test > "$TEST_LOG" 2>&1; then
  add_reason "### \`bun test\` failed

\`\`\`
$(tail -80 "$TEST_LOG")
\`\`\`"
fi

# 2. typecheck
TC_LOG="$(mktemp)"
echo "[gate] bun run typecheck"
if ! bun run typecheck > "$TC_LOG" 2>&1; then
  add_reason "### \`bun run typecheck\` failed

\`\`\`
$(tail -80 "$TC_LOG")
\`\`\`"
fi

# 3. expected tests present (each named test must appear in tests/)
missing_tests=()
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if ! grep -rq -- "$name" tests/ 2>/dev/null; then
    missing_tests+=("$name")
  fi
done < <(jq -r '.expected_tests[]' "$CONFIG")
if (( ${#missing_tests[@]} > 0 )); then
  formatted=""
  for t in "${missing_tests[@]}"; do
    formatted+="- \`$t\`
"
  done
  add_reason "### Expected tests missing from \`tests/\`

The slice prompt names these tests as required. They were not found by grep:

${formatted}"
fi

# 4. spec is unchanged vs main
if git rev-parse --verify main >/dev/null 2>&1; then
  if ! git diff --quiet main -- docs/quay-spec.md; then
    add_reason "### \`docs/quay-spec.md\` was modified

The spec is read-only inside slices. Use a SPEC-GAP blocker instead.

\`\`\`
$(git diff --stat main -- docs/quay-spec.md)
\`\`\`"
  fi
  if ! git diff --quiet main -- docs/quay-tdd-implementation-plan.md; then
    add_reason "### \`docs/quay-tdd-implementation-plan.md\` was modified

The plan is read-only inside slices."
  fi
  if ! git diff --quiet main -- docs/ralph/; then
    # Only blockers/ may be added; everything else under docs/ralph/
    # is read-only. Use --relative so output is cwd-rooted.
    bad="$(git diff --relative --name-only main -- docs/ralph/ | grep -v '^docs/ralph/blockers/' || true)"
    if [[ -n "$bad" ]]; then
      add_reason "### Files under \`docs/ralph/\` were modified outside \`blockers/\`

\`\`\`
${bad}
\`\`\`"
    fi
  fi
  if ! git diff --quiet main -- scripts/; then
    add_reason "### \`scripts/\` was modified

Driver scripts are read-only inside slices.

\`\`\`
$(git diff --stat main -- scripts/)
\`\`\`"
  fi
fi

# 5. forbidden paths from gate config (slice-specific).
# Check committed diff vs main AND untracked files in the working tree —
# untracked files do not appear in `git diff` but are still present and
# could violate the slice's path restrictions.
if git rev-parse --verify main >/dev/null 2>&1; then
  # Scope to the quay/ subtree so unrelated changes elsewhere in the
  # enclosing repo don't show up as forbidden-path drift. Use
  # --relative so output paths match cwd-relative gate-config patterns
  # (e.g. "src/cli/" instead of "quay/src/cli/").
  committed_changed="$(git diff --relative --name-only main..HEAD -- . || true)"
  untracked="$(git ls-files --others --exclude-standard -- . || true)"
  changed="$(printf '%s\n%s\n' "$committed_changed" "$untracked" | awk 'NF && !seen[$0]++')"
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      hit=0
      if [[ "$path" == "$pattern" ]]; then hit=1; fi
      if [[ "$pattern" == */ && "$path" == "$pattern"* ]]; then hit=1; fi
      if (( hit )); then
        add_reason "### Diff touches forbidden path \`$path\`

Matched gate-config pattern \`$pattern\`. This slice should not be modifying that area."
      fi
    done <<< "$changed"
  done < <(jq -r '.forbidden_paths[]?' "$CONFIG")
fi

# 5b. Refuse to pass if the working tree is dirty (under quay/).
# The driver commits WIP before invoking the gate; a dirty tree here
# means the gate is being run manually before commit, or the driver
# is misbehaving.
if [[ -n "$(git status --porcelain -- .)" ]]; then
  add_reason "### Working tree is dirty

The gate evaluates committed branch state. Uncommitted changes are
ambiguous: tests may pass on the working tree but \`git merge\` would
not include them. Commit (or stash) before re-running.

\`\`\`
$(git status --short | head -40)
\`\`\`"
fi

if (( ${#reasons[@]} > 0 )); then
  emit_fail
fi

echo "[gate] PASS slice ${SLICE}"
exit 0
