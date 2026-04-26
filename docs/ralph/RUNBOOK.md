# Quay Slice Runbook

This document drives the Quay TDD implementation plan as a controlled
chain of slice attempts. The driver is a bash script; each "Ralph-style"
loop is a sequence of headless `claude -p` invocations gated by a
machine-checkable contract.

## Source of truth

- Behavior: [`../quay-spec.md`](../quay-spec.md) — read-only.
- Build order: [`../quay-tdd-implementation-plan.md`](../quay-tdd-implementation-plan.md) — read-only.
- Per-slice prompts: [`./slice-N.md`](./).
- Per-slice gate contracts: [`./gates/slice-N.json`](./gates/).
- Driver: [`../../scripts/run-overnight.sh`](../../scripts/run-overnight.sh).
- Single-slice gate: [`../../scripts/gate.sh`](../../scripts/gate.sh).

If a prompt and the spec disagree, the spec wins.

## Operating model

For each slice 0..10, the driver:

1. Branches off `main`: `slice-N-<name>`.
2. Runs up to `max_iterations` attempts. Each attempt is one
   non-interactive `claude -p` call that reads
   `docs/ralph/slice-N.md` plus any prior-attempt gate feedback.
3. After each attempt, runs `scripts/gate.sh N`, which checks:
   - `bun test` is green (full suite).
   - `bun run typecheck` is green.
   - Every test name in `gates/slice-N.json:expected_tests` exists in
     `tests/`.
   - `docs/quay-spec.md` is unchanged vs `main`.
   - `docs/quay-tdd-implementation-plan.md` is unchanged vs `main`.
   - `docs/ralph/` outside `blockers/` is unchanged.
   - `scripts/` is unchanged.
   - Diff does not touch any path in
     `gates/slice-N.json:forbidden_paths`.
4. On gate pass: ff-merge to `main`, advance to slice N+1.
5. On exhaustion: write
   `docs/ralph/blockers/CHAIN-STOPPED-slice-N.md` and exit
   non-zero. Earlier merged slices remain on `main`.

The "loop" is in the driver, not in the agent's session. Each attempt
starts with a clean Claude context — no long-context drift between
attempts within a slice. Memory between attempts is the file system
(committed code) plus appended gate feedback.

## Launch

Pre-flight: clean working tree, on `main`, `claude`/`bun`/`jq` on PATH.

```bash
bash scripts/run-overnight.sh 2>&1 | tee docs/ralph/runs/last.log
```

Run a subset by setting `QUAY_SLICES`:

```bash
QUAY_SLICES="0 1" bash scripts/run-overnight.sh
```

Per-slice manual run (single attempt, useful while iterating on a
prompt):

```bash
git switch -c slice-0-skeleton main
claude -p --dangerously-skip-permissions \
  --max-budget-usd 5 \
  --output-format stream-json --verbose \
  --add-dir "$PWD" \
  < docs/ralph/slice-0.md
scripts/gate.sh 0
```

## Costs and caps

`docs/ralph/gates/slice-N.json` controls per-slice budget:

- `max_iterations`: hard cap on attempts before the chain stops.
- `max_budget_usd_per_iteration`: per-attempt cap passed to
  `claude --max-budget-usd`.

Worst-case for one slice ≈ `max_iterations * max_budget_usd_per_iteration`.
The defaults total roughly ~$2k worst-case across all 11 slices, but
real cost is typically a fraction of that because most slices pass
within the first few attempts.

Tune the JSON before running. The driver reads it at slice start.

## Slice index

| # | Branch | Prompt | Gate | Promise |
|---|---|---|---|---|
| 0 | `slice-0-skeleton` | [slice-0.md](./slice-0.md) | [slice-0.json](./gates/slice-0.json) | `SLICE_0_COMPLETE` |
| 1 | `slice-1-repo` | [slice-1.md](./slice-1.md) | [slice-1.json](./gates/slice-1.json) | `SLICE_1_COMPLETE` |
| 2 | `slice-2-enqueue` | [slice-2.md](./slice-2.md) | [slice-2.json](./gates/slice-2.json) | `SLICE_2_COMPLETE` |
| 3 | `slice-3-tick` | [slice-3.md](./slice-3.md) | [slice-3.json](./gates/slice-3.json) | `SLICE_3_COMPLETE` |
| 4 | `slice-4-classifier` | [slice-4.md](./slice-4.md) | [slice-4.json](./gates/slice-4.json) | `SLICE_4_COMPLETE` |
| 5 | `slice-5-retries` | [slice-5.md](./slice-5.md) | [slice-5.json](./gates/slice-5.json) | `SLICE_5_COMPLETE` |
| 6 | `slice-6-claims` | [slice-6.md](./slice-6.md) | [slice-6.json](./gates/slice-6.json) | `SLICE_6_COMPLETE` |
| 7 | `slice-7-cancel` | [slice-7.md](./slice-7.md) | [slice-7.json](./gates/slice-7.json) | `SLICE_7_COMPLETE` |
| 8 | `slice-8-slack` | [slice-8.md](./slice-8.md) | [slice-8.json](./gates/slice-8.json) | `SLICE_8_COMPLETE` |
| 9 | `slice-9-pr-poll` | [slice-9.md](./slice-9.md) | [slice-9.json](./gates/slice-9.json) | `SLICE_9_COMPLETE` |
| 10 | `slice-10-cli-adapters` | [slice-10.md](./slice-10.md) | [slice-10.json](./gates/slice-10.json) | `SLICE_10_COMPLETE` |

The completion-promise tag (`<promise>SLICE_N_COMPLETE</promise>`) is
not what gates the merge — `scripts/gate.sh` is. The promise is just a
hint for an interactive operator who's watching the run.

## Spec-gap protocol

If an attempt finds a missing product decision, the agent writes
`docs/ralph/blockers/SPEC-GAP-slice-N-<slug>.md` describing the
ambiguity and stops without progressing. The driver does not auto-stop
on this — but the gate will fail (no spec edits allowed; tests likely
won't pass). Operators reviewing the run see the SPEC-GAP file and:

1. Update `docs/quay-spec.md`.
2. `git checkout main`, commit the spec change.
3. Re-run `bash scripts/run-overnight.sh` (which restarts at slice 0
   on a clean tree). For partial reruns, `QUAY_SLICES=N ...` skips
   ahead — but only after manually verifying earlier slices still
   build.

## Chain-stopped recovery

When the driver writes `CHAIN-STOPPED-slice-N.md`:

- The slice's branch (`slice-N-<name>`) still exists with the agent's
  WIP commits. Inspect with `git log slice-N-<name>` and
  `git diff main..slice-N-<name>`.
- The blocker file contains the last gate output and accumulated
  feedback across attempts. Read this first.
- Either fix manually on the slice branch and `git merge --ff-only`
  to `main`, or delete the branch and re-run the slice with
  `QUAY_SLICES=N bash scripts/run-overnight.sh`.

## Hard rules (enforced by every gate)

- `docs/quay-spec.md` is read-only inside slices.
- `docs/quay-tdd-implementation-plan.md` is read-only inside slices.
- `docs/ralph/` outside `blockers/` is read-only inside slices.
- `scripts/` is read-only inside slices.
- Slices 0–9 do not touch `src/cli/`. (CLI is Slice 10.)
- All previously merged slices' tests must continue to pass.
- Test names declared in the gate config are the contract — the agent
  may not silently rename or delete them.

## Logs

Each `run-overnight.sh` invocation creates
`docs/ralph/runs/<UTC-timestamp>/` containing per-attempt prompt
files, raw `stream-json` output, stderr, and gate logs. Useful for
post-mortem when something goes sideways.
