# Quay Spec: Prompt-Improvement Signals (worker + reviewer preambles)

**Status:** Draft / reference. Not locked. Defines the *goal*, the *signals*, and *how to
retrieve them* for a later data-analysis task that proposes concrete edits to the Quay
worker and reviewer preambles. This document deliberately stops at data collection — it
does **not** perform the clustering/analysis or propose prompt edits. That is a separate
downstream task.

**Audience:** whoever runs the analysis next (human or agent). Read this first, then pull
the data with the recipes in §5–§6 and apply the gates in §7 before touching any prompt.

**Required reading:**
- `docs/quay-spec-pr-review.md` — the `pr-review` state, Quay-spawned reviewer, synthetic
  vs Quay-owned task kinds, and the `waiting_external_changes` state.
- `docs/quay-reviewer-preamble-default.md` — the shipped reviewer guidance (one of the
  prompts we're improving; `kind = 'review'` in the `preambles` table).

---

## 1. Goal

Use Quay's own history of **change requests** to improve the **worker** preamble and the
**reviewer** preamble, subject to a hard constraint: **the preambles must not grow without
bound.** Every candidate instruction must clear a high bar (§7) before it earns a line.

Two lenses, because not every finding generalises:
- **Global** — patterns that recur across many repos → belong in the shared preamble.
- **Repo-specific** — patterns concentrated in one repo → belong in that repo's guidance
  (reviewer guidance catalog / repo `AGENTS.md`), not the global prompt.

Success is measurable, not aesthetic: because every attempt records the `preamble_id` it
ran under (§6), a prompt change becomes a new preamble version whose effect can be measured
(human-CR rate on approved PRs for the reviewer; review cycles-to-merge for the worker).

## 2. Core principle — the signal→prompt mapping is asymmetric

A **change request** (CR) is the atomic signal: someone looked at produced code and said
"this needs to change." Who requested it, and against what, determines which prompt it
informs.

| CR source | Worker prompt | Reviewer prompt |
|---|---|---|
| **Human** requested changes | **Tier 1** — subtle/high-value mistakes (bad enough to slip past review) | **The** signal — a human CR means the reviewer **missed** something (false negative) |
| **Quay reviewer** requested changes | **Tier 2** — high-volume recurring mistakes | **None** — the reviewer *succeeded*; a true positive is not a defect of the reviewer |

Two consequences that are easy to get wrong:

1. **The reviewer prompt has exactly one signal: human-requested changes.** A Quay-reviewer
   CR is the reviewer doing its job and carries no information about how to improve it. Do
   **not** feed Quay-CR content into the reviewer analysis (beyond, at most, deduping a
   proposed new rule against what the reviewer already catches).
2. **Assumption behind "human CR = reviewer miss":** on a bot-reviewed PR, humans engage
   selectively, so a human CR is a good proxy for a gap the reviewer missed. This holds
   well for Quay-authored PRs (Signal A). It is *weaker* for human-authored PRs (Signal C),
   where humans do full normal review — there the miss must be established by a direct
   content diff, not assumed (§4).

## 3. Staggered signal priority

Highest signal first; work down only as far as the budget/bar allows.

1. **Human-requested changes** (Signals A + C) — highest signal for both prompts.
2. **Quay-reviewer-requested changes** (Signal B) — worker prompt only, and only as the
   second tier.

## 4. The three signals (definitions)

### Signal A — Human CR on a Quay-authored PR  *(worker Tier 1 + reviewer miss)*
On a PR written by a Quay worker (`authoring_mode = 'quay_owned'`), a **human** posted a
`CHANGES_REQUESTED` review. The worker shipped a defect (worker signal); the Quay reviewer
had approved or would have to have missed it (reviewer signal).
- Precision: *inferred* miss (we rely on the §2.2 assumption).
- Note: the in-DB `changes_requested` event with `from_state = 'done'` captures only the
  **post-approval** subset (human objected after the task already reached `done`). The
  **complete** Signal-A set requires the GitHub review sweep (§6.3), because a human CR that
  lands while the task is still in the review loop does not surface as that event.

### Signal B — Quay-reviewer CR on a Quay-authored PR  *(worker Tier 2 only)*
The Quay reviewer posted `CHANGES_REQUESTED` on a `quay_owned` PR. Recurring, high-volume
worker mistakes. **Not** a reviewer signal.

### Signal C — Human CR on a synthetic-review PR  *(reviewer miss — highest precision)*
A `review-pr` task (`authoring_mode = 'synthetic_review'`): Quay reviewed a **human-authored**
PR it did not write. If another human requested changes on the same PR, that is a candidate
reviewer miss — and the **highest-precision** one, because Quay's own review output is on
record at a known `head_sha`. You can therefore **diff directly**: at the same commit, what
did the human flag that Quay's review did **not** mention?
- No Quay worker → **no worker-prompt signal**; reviewer-only.
- The §2.2 assumption does **not** apply (humans review human PRs fully). The miss must come
  from the content diff at the same `head_sha`, not from the mere existence of a human CR.
- Exclude the PR author and the `quay-reviewer` bot from "human reviewer".
- `adopted_external_pr` tasks are a hybrid (human-authored branch + a Quay worker); keep them
  separate from the clean synthetic-review set.

## 5. Data sources & access

Everything lives on **Kostia** (`krustentier`; `ssh krustentier`), plus the GitHub API.

- **Quay CLI** (runs the quay CLI as the `hermes` user):
  `sudo /usr/local/bin/quay-as-hermes <cmd>` — `task list|get|events`,
  `artifact get <task_id> <kind> [--path]`.
- **Quay DB** (source of truth): `/home/hermes/.hermes/quay/quay.db` (SQLite).
  There is **no `sqlite3` binary on the host** — open it read-only from Python:
  `sqlite3.connect("file:/home/hermes/.hermes/quay/quay.db?mode=ro&immutable=1", uri=True)`.
- **Artifact store** (large blobs referenced by `artifacts.file_path`):
  `/home/hermes/.hermes/quay/artifacts/<task_id>/...`.
- **GitHub**: `gh api` / `gh api graphql` (authenticated in `/srv/shared/repos`). The Quay
  reviewer posts as the GitHub **App bot `quay-reviewer`** — exclude that login to isolate
  humans.

### Key tables
- `tasks` — `task_id`, `authoring_mode` (`quay_owned` | `synthetic_review` | `adopted_external_pr`),
  `state`, `repo_id`, `external_ref`, `pr_url`, `head_sha`, `base_sha`,
  `last_review_id_acted_on`.
- `attempts` — one row per worker/reviewer run: `reason`, `exit_kind`, `review_verdict`
  (`approved` | `changes_requested` | `errored` | `superseded`), `preamble_id`, `review_id`,
  `agent_name`, `agent_model`, `attempt_number`.
- `events` — `event_type`, `from_state`, `to_state`, `payload_artifact_id`, `occurred_at`.
- `artifacts` — `kind`, `file_path`, `task_id`, `attempt_id`.
- `review_findings` / `review_finding_locations` — structured findings (`severity`,
  `title`, `body_markdown`, `principle_text`, file+line). Newer protocol; sparse historically.
- `preambles` — **the prompts themselves**: `kind = 'code'` (worker) and `kind = 'review'`
  (reviewer), versioned by `preamble_id` + `created_at`.

### Relevant artifact `kind`s
- Task description: `brief`, `task_objective`, `ticket_snapshot`.
- Exact rendered worker prompt: `final_prompt`.
- Quay's review output: `review_comments` (JSON: `decision`, `body`, `review_id`, `comments`),
  `review_result`, plus structured `review_findings`.

## 6. Retrieval recipes

Numbers below are a point-in-time snapshot (~2026-07-10, 402 tasks / 295 merged) — treat as
illustrative and **re-run to refresh**.

### 6.1 Quay-reviewer CR (Signal B — worker Tier 2)
```sql
-- All tasks where the Quay reviewer requested changes (any authoring_mode): 151
SELECT DISTINCT task_id FROM attempts WHERE review_verdict = 'changes_requested';
-- Equivalent via events (cross-validates to the same 151):
SELECT DISTINCT task_id FROM events
WHERE event_type = 'changes_requested' AND from_state = 'pr-review';
-- For the WORKER prompt, restrict to Quay-authored code:
--   join tasks and keep authoring_mode = 'quay_owned'.
```
Review content: `review_comments` / `review_result` artifacts on the reviewer attempt.

### 6.2 Human CR after approval (Signal A — in-DB subset only)
```sql
-- Human objected after the task reached `done`: 41 tasks (all verified human).
SELECT DISTINCT task_id FROM events
WHERE event_type = 'changes_requested' AND from_state = 'done';
```
This is a **subset** of Signal A. For the complete set use the sweep (§6.3).

### 6.3 Complete human-CR set via GitHub sweep (Signal A full + Signal C)
For each candidate PR, list reviews and keep `state = CHANGES_REQUESTED` where the author is
**not** the `quay-reviewer` bot (for Signal C also exclude the **PR author**).
```bash
# REST per PR:
gh api "repos/{owner}/{repo}/pulls/{n}/reviews?per_page=100" \
  --jq '.[] | select(.state=="CHANGES_REQUESTED") | {author: .user.login, type: .user.type, submitted: .submitted_at, id: .node_id}'
```
```graphql
# Or resolve specific review node-ids in bulk (author + type + state):
query { node(id: "PRR_...") { ... on PullRequestReview {
  state url submittedAt author { login __typename }
  pullRequest { number repository { nameWithOwner } } } } }
```
`__typename = "User"` and `login != "quay-reviewer"` ⇒ human. (Snapshot human reviewers on
the 41: `lafawnduh1966` ×37, `marvinkruse` ×20, `aminlatifi` ×8, `johnshift` ×2.)

### 6.4 Synthetic-review set (Signal C)
```sql
-- 187 tasks. Quay reviewed a PR it did not author.
SELECT task_id, external_ref, repo_id, pr_url, head_sha
FROM tasks WHERE authoring_mode = 'synthetic_review';
```
Then: pull Quay's `review_comments`/`review_findings` at `head_sha`, sweep the PR's human
`CHANGES_REQUESTED` reviews (§6.3, excluding bot + author), and **diff at the same
`head_sha`** — the reviewer miss is what the human raised and Quay's review did not.

## 7. The high bar — gates every candidate instruction must pass

Applied **before** any preamble edit. These are what keep the prompts from bloating.

1. **Already-in-prompt?** Diff the finding against the current preamble body
   (`preambles` rows, `kind = 'code'` / `'review'`). If the prompt already says it and the
   mistake still happened, it is a *salience/adherence* problem, not a missing instruction —
   another line will not help and only grows the prompt. Reject.
2. **Prompt-shaped?** Keep only **objective, reviewable defects**. Drop preference/nitpick
   and scope/product disagreements (the latter is a *task-brief* problem, a different lever).
   Route repo idioms / lint-enforceable rules to the repo's `AGENTS.md` or CI, not the prompt.
3. **Recurring?** Require support across ≥ N distinct tasks. One-offs earn nothing.
4. **Global vs repo-specific.** Recurs across ≥ K repos → global preamble; concentrated in
   one repo → repo-specific guidance.
5. **Overfitting guard.** Weight findings by **cross-reviewer agreement**; a rule learned
   from a single reviewer's taste (note the reviewer concentration above) is suspect.
6. **Close the loop.** Land each change as a new preamble version and measure it
   (§1): reviewer = human-CR rate on approved PRs; worker = review cycles-to-merge, by
   `preamble_id`.

## 8. Output of the downstream task (not done here)

For each surviving candidate: the proposed preamble line(s); target (global worker / global
reviewer / repo-X guidance); the evidence (task ids, PR review links, `head_sha` diffs); the
support count and repo spread; and the metric that should move. Nothing merges into a
preamble without clearing §7.

## 9. Caveats

- Counts in §6 are point-in-time; re-run against live `quay.db`.
- Structured `review_findings` is sparse historically; `review_comments` artifacts +
  `attempts.review_verdict` are the dense signal.
- `events` is ~90% `tick_error` noise — filter it out.
- Signal C's "human CR" includes reviews of code the human authored's collaborators; the
  content diff at `head_sha` is what makes it a real reviewer miss, not the CR count.
