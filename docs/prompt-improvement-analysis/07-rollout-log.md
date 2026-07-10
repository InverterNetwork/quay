# Prompt-improvement analysis — 07: rollout log

**2026-07-10 ~08:55 UTC** — shipped on Kostia via `quay preamble create` (decision: ship all
at once; combined human-CR rate is the primary metric, worker CR-cycles metric accepted as
confounded this round).

| preamble_id | kind | content | effective for |
|---|---|---|---|
| 7 | code | worker v4 (`proposed-preamble-code-v4.md`) | all repos (latest, no worker pins) |
| 8 | review | orphan duplicate of 11 (ordering mishap, unused) | — |
| 9 | review | v7 + `## Repo-specific guidance (iTRY-monorepo)` | iTRY-monorepo (pinned) |
| 10 | review | v7 + `## Repo-specific guidance (brix-landing)` | brix-landing (pinned) |
| 11 | review | reviewer v7 (`proposed-preamble-review-v7.md`) | all other repos (latest) |

iTRY-monorepo's stale worker pin (3) cleared → tracks latest code. The two reviewer pins are
temporary fork-and-extend until BRIX-1887 (appendix layer); fork body = v7 + trailing repo
section, so migration is mechanical.

Ops details + rollback: `/srv/shared/runbooks/quay/preamble-rollout.md` (Kostia-side).
Measurement (gate 6): re-run 03 baseline queries filtering `attempts.preamble_id IN (7)` for
worker and `(9,10,11)` for reviewer after ~50 samples each; compare vs 0.64 CR-cycles and
25–33% human-CR rate.
