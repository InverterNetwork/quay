# Orchestrator design notes — ticket schema & PR-review learning loop

**Status:** Brainstorm notes, not a spec. Captures conclusions from a design conversation about how the orchestrator (Hermes) creates tickets, how PR review findings feed back into future briefs, and the two small Quay-side additions (`task_tags`, `review_findings`) that make the cross-task query cheap.

These ideas sit on top of the locked v1 spec (`quay-spec.md`); nothing here changes the v1 substrate boundary. The work is orchestrator-side except where called out.

### Spec docs graduated from this design

Two feature specs have been extracted from this notes doc and live as standalone, lockable documents. **They are the contracts.** This notes doc continues to capture the broader design conversation — including v2+ shape and rationale that the specs deliberately defer.

- **`docs/quay-spec-ticket-validation.md`** — `quay validate-ticket` library/CLI (the ticket-shape validator). Spec status: Draft. Covers §2 of these notes.
- **`docs/quay-spec-pr-review.md`** — `quay review-pr` + reviewer worker + `review_findings` storage. Spec status: Draft. Covers §3.1, §3.2, §5, and the v1 subset of §7. **The v1 cut deliberately ships only the input pipeline (CI trigger → reviewer → findings stored), not the output pipeline (loop closing / brief enrichment).** Whoever wants to close the loop builds it as an external consumer over Quay's stored data.

Sections of these notes that did *not* graduate to a v1 spec (§3.3 brief enrichment, §4 the closed loop, the parts of §7 covering panel review / blocking mode / Hermes RPC / reviewer-improvement loop) describe **deferred work** with full design captured here. They graduate to their own spec docs when the trigger conditions in §9's deferred table are met.

---

## 1. Context

The starting question was whether agent-driven PR review should live inside Quay. **Initial conclusion was no** — file the reviewer as a CI workflow, gate merges in CI, capture findings via the existing `review_comments` artifact path. **Revised conclusion (see §7) is yes** — bring the reviewer inside Quay as a worker with a Quay-owned preamble. Reasons: drift-proof contract enforcement, full task context for the reviewer, reuse of the existing substrate, and a natural seat for a reviewer-improvement loop. CI remains the trigger event; an orchestrator fallback path handles human-authored PRs that have no originating Quay task.

That covers three related design areas:

- **Ticket creation.** How does a Linear issue become a Quay task with minimal orchestrator runtime work?
- **Learning loop.** How do PR review findings get folded into future briefs?
- **Reviewer-as-worker.** How does the reviewer itself live inside Quay, and how does it improve over time?

The first two are coupled by **tagging**: precise tags at ticket creation time make downstream retrieval (and the learning loop) almost-deterministic. The third reuses Quay's substrate to make the reviewer a first-class actor with the same observability and improvement properties as a code worker.

---

## 2. Ticket schema (orchestrator-authored)

### Premise

Most tickets are authored by the orchestrator on behalf of a human (e.g. *"Hermes, please file a ticket for X"*). Schema enforcement happens at ticket-creation time inside the Hermes skill, not as a runtime validation pass at enqueue. The LLM is structurally incapable of producing a ticket missing required fields if the skill prompt won't let it.

### Required fields

A ticket is "well-formed" iff it carries all of:

1. **Body.** Free-form prose describing what the task is.
2. **Tags.** Deterministic, opaque-to-Quay strings used for classification (component, flow, etc.). Granularity matters — see §4 on why precise tags are load-bearing for the learning loop.
3. **Originating Slack thread.** `<channel_id>:<message_ts>`. The thread the work originated from (typically a request, bug report, or discussion). Used as the default `--slack-thread-ref` for any future `quay escalate-human` calls on the resulting task.
4. **Involved people.** A list of `{name, slack_handle}` for the requester and any other stakeholders. Used so escalation messages and follow-up questions can `@`-tag the right people directly.

### Why these specific fields

- **Slack thread + involved people** are what make `escalate-human` mechanical instead of an orchestrator decision. Today the orchestrator has to figure out *which* thread to escalate into and whom to tag; if the ticket carries that, the escalation flow is a deterministic substitution.
- **Tags** are what the learning loop retrieves against. See §4.
- **Body** is the brief seed.

### Validation

For load-bearing fields (Slack thread, originator handle), back the prompt with a deterministic check:

1. Skill produces a draft ticket.
2. Code-level validator confirms required fields are present.
3. Only then does the Linear API write happen.

Trust the LLM for prose; don't trust it alone for fields that downstream substrate code reads as required. The validator is cheap.

#### `quay validate-ticket` — schema validator as a Quay-shipped library

Rather than have every orchestrator implementation re-implement the validator, **Quay ships the validator as a CLI command (and/or library)**: `quay validate-ticket --body ... --tag ... --slack-thread ... --originator ...` returns pass/fail with structured field-level error messages. The Hermes ticket-creation skill calls it on every draft before writing to Linear. A draft that fails validation is reworked in-process by the LLM (the validator's structured errors feed back into the next iteration of the draft); only validated drafts ever reach Linear.

The schema itself lives in Quay's deployment config (e.g., `~/.quay/ticket_schema.toml`) — a list of required fields, charset rules, length limits. Deployments can customize: one team requires `service` tags; another requires a compliance label; another runs the lowest-common-denominator default. Quay validates against the configured schema; it doesn't define what fields *should* be required at any given org.

Properties:

- **Substrate boundary preserved.** Quay validates *ticket-shaped input* against a declared schema. It still doesn't know what Linear is, what fields mean semantically, or what to do when validation fails — the orchestrator decides.
- **Symmetric with the `quay-principle` fenced-block convention** (§5). In both cases, Quay codifies a small declarative contract (a fenced block format / a schema) and provides parsing/validation. Interpretation lives outside Quay.
- **Enqueue path unchanged.** `quay enqueue` still accepts the opaque `--brief-file` / `--ticket-snapshot-file` form. The validator is a separate tool the orchestrator chooses to use. Validation happens *upstream* of enqueue, not at enqueue time, so Quay never has to comment back on Linear about malformed tickets — that case can't reach it.
- **Multi-orchestrator forward-compat.** A future Jira-driven orchestrator (or a different team's Hermes deployment) calls the same validator with the same schema config. Schema gets versioned per deployment, not per orchestrator.

When the validator's schema needs to grow (new required field, new format), it's a Quay config change; orchestrator skills adapt to the new error messages. Lockstep release pressure stays minimal.

### Hand-filed tickets

The 5% case where a human files a ticket directly in Linear. v1 punt: the adapter logs and skips malformed tickets; the human notices their ticket isn't moving and fixes it manually. No automated comment-back-to-Linear flow needed initially.

### Linear → Quay adapter

A separate process from the LLM-driven Hermes orchestrator. Roles:

- **`linear-adapter`** (cron, **deterministic**, no LLM): polls Linear for ready tickets, validates the schema (`quay validate-ticket`), calls `quay enqueue --enrich-principles --tag <each>...` with the raw ticket body. Quay performs the past-findings retrieval, ranking, and templated splice internally — see §3.3. The adapter never reads `review_findings` directly.
- **`hermes`** (cron, **LLM-driven**): pulls `awaiting-next-brief` tasks, composes follow-up briefs, decides escalations.

Both are "callers of Quay's CLI" from the spec's §11 perspective. Quay sees no difference. The factoring isolates the only deterministic part of the orchestrator from the only LLM-heavy parts (ticket creation upstream, retry-brief composition downstream).

---

## 3. Quay-side changes

Two small additions to Quay. Both follow the same pattern: opaque-to-Quay structured data, stored and indexed for the orchestrator's benefit, never interpreted by Quay's logic.

### 3.1 `task_tags`

Many-to-many table for the orchestrator-supplied classification tags described in §2.

#### Schema

```sql
CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE INDEX task_tags_by_tag ON task_tags(tag);
```

#### CLI surface

- `quay enqueue ... --tag <name>` (repeatable) at task creation.
- `quay task tag-add <task_id> <name>` and `quay task tag-remove <task_id> <name>` for post-enqueue mutation.
- `quay task list --tag <name>` (repeatable, AND-semantics) joins through `task_tags`.
- Tags also embedded in the `ticket_snapshot` artifact so the historical record is preserved if a tag is later removed from the live row.

#### Boundary preservation

Quay treats tags as **opaque strings**. Quay does not interpret, validate (beyond charset), or take action on tag values. This is the same shape as `external_ref` today: stored for the orchestrator's benefit, indexed for queries, never interpreted. The spec's §3 substrate boundary holds as long as nothing in Quay tries to *do* anything with tags beyond store/filter/return.

What would cross the boundary (resist these): auto-cancelling tasks tagged `experimental`, routing tagged tasks to specific worker pools, etc. Anything that requires Quay to "know what `auth` means" is out.

### 3.2 `review_findings`

A **pure structured index** over agent (and human) review feedback. Populated by tick at the same moment it writes a `review_comments` artifact today. The `review_comments` JSON snapshot remains the **source of truth for prose and history**; `review_findings` is just the queryable view that points back at it.

#### Schema

```sql
CREATE TABLE review_findings (
  finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id INTEGER REFERENCES attempts(attempt_id),
  review_id TEXT NOT NULL,        -- GH review id; aligns with last_review_id_acted_on
  principle TEXT,                  -- parsed prose; NULL when no fenced block was emitted
  file_path TEXT,                  -- from the GH line comment
  line_number INTEGER,             -- from the GH line comment
  source_url TEXT,                 -- deep link to the GH comment
  captured_at TEXT NOT NULL
);
CREATE INDEX review_findings_by_principle ON review_findings(principle);
CREATE INDEX review_findings_by_task ON review_findings(task_id);
```

That's the whole table. **No `comment_body`** (the prose lives in the `review_comments` artifact; follow `source_url` or read the JSON for it). **No `generalizable` boolean** (`principle IS NULL` carries that signal). **No `scope`** (deferred — see "Multi-repo principles" in §7).

#### `principle` is optional — that's the whole signal

`principle IS NULL` ↔ "this is a localized comment, not a generalizable rule." Two cases:

1. **Localized comments.** *"Typo here," "rename this variable," "this import is unused"* — real review feedback that fixes *this* PR but doesn't generalize. The reviewer omits the fenced block. The row still goes into `review_findings` (linked to the task and attempt for review-history display); it just doesn't show up in cross-task queries.
2. **Reviewer omission.** The reviewer could have emitted a principle but didn't (prompt drift, model variance, edge case). Same outcome — the row exists, it just doesn't carry a principle.

Cross-task retrieval filters with `WHERE principle IS NOT NULL`. Per-task display ignores the filter and shows everything.

#### Insertion rule

**One row per GH line comment, regardless of whether a principle was emitted.** The full review's verdict, summary body, and headline metadata are captured in the `review_comments` artifact only — they don't get a row. `review_findings` is line-level by design, because that's the granularity at which the principle annotation lives.

#### CLI surface

- `quay artifact list --kind review_findings --tag <name>` joins through `task_tags` and `review_findings`. (Despite the `--kind` framing this is a SQL-table read, not an artifact-file read; the name keeps the read commands consistent with the existing `artifact get` shape.)
- `quay task review-findings <task_id>` returns all findings for a task (debugging / display); reads the corresponding `review_comments` artifact for the prose context.

#### Boundary preservation

Quay parses one thing — the fenced ` ```quay-principle ` block in the GitHub comment body — and stores its content as opaque text in `principle`. That's the entire interpretation step. Quay never decides whether two principles are "the same," never ranks, never filters by principle content. Those are orchestrator-side operations.

This is the same kind of operation as parsing `bucket` values from `gh pr checks` (spec §5 CI status rules) or extracting fields from `gh pr view` JSON. Codified parse, opaque content. The substrate boundary holds.

#### `principle_slug` — deferred subtlety

Free-text `principle` won't dedup cleanly. The reviewer will emit slightly different prose across PRs even when the rule is identical (*"External API calls must use `withRetries()` because..."* vs *"API calls in service code need to be wrapped with `withRetries()`..."*). Two ways to handle:

- **`principle_slug`** (stable identifier, e.g. `external-api-must-use-with-retries`) + **`principle`** (human prose). The reviewer commits to a stable slug as part of its output. Dedup is on slug. The slug registry is reviewer-side state.
- **Free-text only,** with periodic Hermes-side canonicalization passes assigning slugs after the fact.

Start with **free-text only**. Add a `principle_slug` column once prose variance demonstrably hurts dedup. The schema change is additive, so deferring is cheap.

### 3.3 Brief enrichment (`quay enqueue --enrich-principles`)

The "fold relevant past principles into the new task's brief" step lives **inside `quay enqueue`**, not in the orchestrator. The cron (or any other orchestrator) passes the raw ticket body and tags; Quay runs the enrichment SQL, renders a templated section, and stores the enriched brief. From the orchestrator's perspective the submission is one atomic call.

```
quay enqueue \
  --raw-brief-file ticket.md \
  --tag auth-session --tag database-migration \
  --repo-id repo-foo \
  --enrich-principles                  # default-on; shown for clarity
  ...
```

#### Why inside Quay

The enrichment is mechanical data piping over Quay's own schema: a SQL query (recency × tag-overlap × same-repo-first; same-task prior-attempt findings always included), a text template, a splice step. No reasoning, no LLM, no judgment. Putting it in the orchestrator forces every orchestrator (the deterministic cron, a future LLM-driven composer, any other consumer) to know `review_findings`'s schema, the ranking SQL, and the template format. That's substrate knowledge leaking. Same shape as `quay validate-ticket` (§2) — Quay owns the schema, Quay ships the utility. The orchestrator stays minimal.

#### Default-on, with an opt-out flag

`--enrich-principles` defaults to `true`; `--no-enrich-principles` bypasses it. Three opt-out cases justify the flag rather than making it unconditional:

1. **Future LLM-driven composer.** When/if the cron is later replaced by an LLM composer that weaves principles into the prose itself, it passes `--no-enrich-principles` and reads the raw rows directly. (At v1 the read surface is an internal library function; a public `quay query-principles` CLI is shipped at migration time — see §9 deferred items.)
2. **Per-task noise control.** Trivial chore tasks (a one-line rename, a docs typo) get unhelpful noise from a 15-bullet principles section. Orchestrator policy ("skip enrichment for tasks tagged `chore`") expresses cleanly as a per-task flag.
3. **Test/debug isolation.** Enrichment depends on `review_findings` state, which makes brief-shape assertions flaky in tests and hard to reproduce when reading a stored task months later. Flag-off is the deterministic-input mode.

Per-deployment defaults live in config (`enrich_principles_default = true`, `enrich_principles_skip_tags = [...]`).

#### Submit-time, not spawn-time

Enrichment runs at `enqueue` (and equivalently at synthetic-task creation for human-PR reviews; see §7), **not** when tick promotes `queued → running`. Rationale: `tasks.brief` should be the truthful record of what the worker eventually sees. Spawn-time enrichment would mean the stored brief is raw and the worker brief is enriched, forcing replays to re-run a time-historical query to answer *"why did the agent know about X?"* The audit cost outweighs the marginal-staleness benefit of including newer principles.

#### Mechanics

The enricher is one SQL query, a fixed template, and a single transactional write. Deterministic; defined here so there's no room for "implementation interpretation."

##### The query

```sql
SELECT f.principle, f.source_url, f.captured_at
FROM review_findings f
JOIN tasks ft ON ft.task_id = f.task_id
WHERE f.principle IS NOT NULL
  AND f.panelist_id IS NULL                 -- consolidated findings only
  AND ft.repo_id = :repo_id                 -- v1: same-repo only
  AND EXISTS (SELECT 1 FROM task_tags ftt
                WHERE ftt.task_id = f.task_id
                  AND ftt.tag IN (:tags))
ORDER BY f.captured_at DESC
LIMIT :max;
```

Notes:

- `panelist_id IS NULL` — only the consolidated finding (the one filed on GitHub) feeds the enricher; raw per-panelist rows feed the reviewer-improvement loop only. See §7.
- `principle IS NOT NULL` is the only quality gate. Localized comments (no fenced block) never enter cross-task retrieval. The reviewer contract (§5) is the first-line quality control; the enricher does not second-guess the reviewer's judgment by adding a post-PR-terminal "was this addressed?" filter — see §7's "Why no validation step" for the rationale.
- `repo_id = :repo_id` — v1 is **same-repo only**. Cross-repo behavior is the §8 open question; when it resolves, this clause becomes a deployment-config switch.
- **No `tag_overlap` ranking column.** With precise per-dimension tagging (the §2 norm), most findings overlap by exactly one tag — the column is uniformly 1 and adds no ordering signal at v1 scale. Recency is the ranker. Reintroduce a multi-tag-overlap weighting only if/when production tag distribution makes it meaningful.
- **No same-task carve-out.** Re-surfacing principles from prior attempts of the same task is *retry-brief composition*, which is the orchestrator's job (§2 / spec §11), not the enricher's. The deterministic cron's retry path (or Hermes's, in the LLM-driven case) reads `review_findings` for the same `task_id` directly when composing the next-attempt brief. The enricher's role is *cross-task* retrieval, period.

##### Default cap

`enrich_principles_default_max = 15` in deployment config. Per-call override via `--max <N>`. Tighten if briefs feel noisy; widen if the corpus is sparse.

##### Template

The spliced section is appended after a horizontal-rule separator:

```markdown

---

## Lessons from prior reviews

The findings below were collected from prior PR reviews on tasks
sharing tags with this one. They are advisory context, not requirements.

- {principle prose} ([source]({source_url}))
- {principle prose} ([source]({source_url}))
- ...
```

Position is **always appended** after the raw brief. (Earlier drafts considered making position configurable; rejected as speculative — there's no measurement justifying any other choice.)

**Zero-match behavior.** When the query returns empty, the enricher emits **nothing** — no separator, no heading, no placeholder. `tasks.brief == tasks.raw_brief` in that case.

##### Single transaction, all or nothing

Enrichment-bearing `enqueue` is a single SQLite transaction:

1. `BEGIN`.
2. Run the query.
3. Render the spliced section (skip if zero matches).
4. `INSERT INTO tasks (...) VALUES (..., raw_brief, brief, ...)`.
5. `INSERT INTO task_tags (...)` for each tag.
6. `COMMIT`.

Any step failing rolls back the whole transaction. The orchestrator sees enqueue as atomic — either the task exists (with consistent brief and tags) or it doesn't. No partial state.

#### Forward-compat: store raw and enriched brief separately

```
tasks.raw_brief        -- what the orchestrator submitted (verbatim)
tasks.brief            -- raw + enriched section, what the worker sees
```

Why this is worth doing now (the only forward-compat precaution that survives a pragmatism pass):

- A future LLM composer needs the **raw** brief to do its own work; if we only store enriched, it must parse-and-strip the spliced section, which is ugly and fragile.
- *"What did the orchestrator intend?"* and *"what did the worker see?"* are different questions; both are useful, both should be one column away.
- Cost is rounding-error: doubles the brief column size in the worst case.

A sentinel-marker alternative (delimit the spliced section in a single column) works but is not as clean. Recommend the two-column form.

Earlier drafts proposed two additional precautions (a `task_enrichment_log` audit table and a public `quay query-principles` CLI). Both were defensible-but-speculative — they pay cost now to make a hypothetical future migration smoother. A pragmatism pass moved both to "do at migration time, not now":

- **No `task_enrichment_log` table.** Audit/replay is currently served by `tasks.raw_brief` + `tasks.brief` (you can see what got added). When A/B comparison or drift detection between deterministic and LLM-driven enrichment becomes a real concern, add the table then — additive schema change, no backfill required because there's nothing prior to log.
- **No public `quay query-principles` CLI.** The query lives inside the enricher as an internal helper. When a real external consumer (LLM composer, ops dashboard) arrives, promotion to a public CLI is one small wrapper, not a refactor. The library function exists; the public CLI doesn't.

#### Explicitly *not* building now

Resist designing for the LLM composer that doesn't exist yet, and for v2 features that don't yet have a use case:

- **No "enricher strategy" interface.** One implementation today (deterministic SQL + template). When a second arrives, the call site inside `enqueue` gets a branch and the right abstraction shape becomes obvious. Designing for one imagined consumer is premature.
- **No ranking-DSL config.** The ranker is "recency, capped." If a different ranking is ever needed, write it. Don't generalize until there are at least two real shapes to factor.
- **No `enrich_principles_position` config.** Position is hardcoded "append." If a measurement ever justifies prepending, change the constant.
- **No `tag_overlap` ranking subquery.** With precise per-dimension tags, overlap is uniformly 1 at v1 scale. Add when distribution becomes meaningfully > 1.
- **No LLM-cost tracking columns.** Zero LLM calls at this stage; the right cost-tracking shape depends on what the future composer ends up doing (per-call / per-task / per-batch). Add when there's something to track.
- **No "enrichment version" column on `tasks`.** Versioning of the deterministic enricher's algorithm doesn't need a column when there's only one implementation. Reintroduce when `task_enrichment_log` lands and `injected_by` becomes meaningful.

---

## 4. PR-review learning loop

### What's already free

Quay already captures `review_comments` artifacts on every `CHANGES_REQUESTED` (spec §5 `done` handler, spec §8 artifact kinds). Artifacts persist past terminal. So the *data capture* side of the learning loop is zero-cost — wire up the reviewer (per §7) and Quay starts collecting findings automatically. This is true regardless of whether the reviewer ends up running as a Quay worker (§7 recommendation) or as a CI workflow (the original framing): in both cases tick observes the review on GitHub and ingests the findings the same way.

### What's not free

Three things, roughly in order of necessity:

1. **Cross-task retrieval.** Needs the `review_findings` table from §3.2 plus the `task_tags` join from §3.1. Small.
2. **Structure for ranking.** Raw review comments are free-form prose. To rank/dedup/transfer them across tasks, you want a `principle` field (see §5) populated into `review_findings.principle`. The reviewer agent is the natural place to emit it.
3. **The retrieval-and-fold step.** Lives inside `quay enqueue --enrich-principles` (§3.3) — Quay queries past findings by tag and appends them when the orchestrator submits the task. Mechanical given precise tags; the orchestrator never touches `review_findings` directly.

### Where the intelligence lands

Earlier instinct was *"a smart filter in the middle picks relevant findings."* The conclusion was the opposite: **push intelligence upstream into tag assignment at ticket creation**. If tags are precise (`auth-session`, not `auth`), retrieval is dumb (SQL join + verbatim append). If tags are coarse, retrieval has to be smart.

This is a much cleaner factoring because:

- The classification result is **persisted as tags**, not throwaway reasoning at enqueue time.
- Tags are reused by *future* queries — the cost amortizes.
- The orchestrator producing the ticket has the full context to assign precise tags. A runtime classifier seeing the ticket fresh has less context.

### The brief-folding strategies (graduated)

Build the cheapest one that works, graduate when noise hurts:

1. **Dump-them-all.** Append every finding under matching tags, verbatim. Works while volume per tag is small (≤ ~20 findings). Crude but truly zero-intelligence.
2. **Recency + dedup by principle.** Cluster by principle string, keep most-recent-N per cluster. Still mostly deterministic — sort and string-similarity match. No LLM call.
3. **LLM-driven relevance.** *"Here's the new ticket and 50 candidate findings; pick the 5 most likely to bite."* Build only when (1) and (2) measurably underperform.

Don't pre-build (3). The graduation point is roughly *"the brief gets noisy enough that workers stop reading findings carefully"* — empirically, probably 50+ findings per tag.

### Decay

Findings from 6 months ago against a rewritten part of the codebase are noise. Solutions, in order:

- Recency weight in the ranking (cheap).
- Periodic "is this still relevant?" review pass during a nightly job (more expensive).
- Explicit invalidation (a finding gets marked stale when a related architectural change ships).

Day one: nothing. Just keep timestamps on each occurrence so this is cheap to add later.

### Query shapes

All retrieval is plain SQL against `task_tags` + `review_findings` (with the existing `tasks` / `attempts` / `artifacts` tables for joins as needed). Run from the adapter against `~/.quay/quay.db` directly, or expose as read commands. Three load-bearing shapes:

**(1) Query principles** — *"all generalizable rules we've collected, ranked by recurrence and recency."*

```sql
SELECT principle, COUNT(*) AS occurrences, MAX(captured_at) AS last_seen
FROM review_findings
WHERE principle IS NOT NULL
GROUP BY principle
ORDER BY occurrences DESC, last_seen DESC;
```

**(2) Query tags** — *"all tasks that ever touched `auth-session`."*

```sql
SELECT t.task_id, t.external_ref, t.state
FROM tasks t
JOIN task_tags tt ON t.task_id = tt.task_id
WHERE tt.tag = 'auth-session';
```

**(3) Combined: principles for a tag** — the load-bearing query for the learning loop.

```sql
SELECT f.principle, COUNT(*) AS occurrences, MAX(f.captured_at) AS last_seen
FROM review_findings f
JOIN task_tags tt ON f.task_id = tt.task_id
WHERE tt.tag = 'auth-session'
  AND f.principle IS NOT NULL
GROUP BY f.principle
ORDER BY occurrences DESC, last_seen DESC;
```

Common variations:

- **Multi-tag AND** — *"rules that apply when both `auth-session` and `database-migration` are involved."* Add `HAVING COUNT(DISTINCT tt.tag) = 2` and an `IN` clause on tags.
- **Recency window** — add `AND f.captured_at > datetime('now', '-30 days')`.
- **Reverse lookup** — *"which PRs flagged this principle?"* `SELECT task_id, source_url FROM review_findings WHERE principle = ?`.
- **Per-tag finding density** — `SELECT tt.tag, COUNT(f.finding_id) FROM task_tags tt LEFT JOIN review_findings f ON tt.task_id = f.task_id GROUP BY tt.tag`.

None of these need an LLM call. None need to read artifact files. The original prose is one `source_url` follow away when displaying.

---

## 5. Reviewer contract & the `principle` field

### What the reviewer provides

A standard GitHub PR review (`gh pr review --request-changes` / `--comment` / `--approve`), with line-level comments where applicable. **The only Quay-specific convention** is: when a comment expresses a generalizable rule, the reviewer appends a fenced block to the comment body containing the principle prose:

````
This `fetch` call should be wrapped in `withRetries()`.

```quay-principle
External API calls in service code must use `withRetries()` because
flaky networks cause cascading failures across our async pipeline.
```
````

Rules:

- **One judgment call per comment:** *"is there a transferable rule here, yes/no?"* If yes, write the block. If no, omit it. **No booleans, no scope, no other metadata.**
- **The block is optional.** Localized comments (typos, naming, style) just don't carry one.
- **The principle is prose,** not a slug — free text, sentence-shaped, articulating the rule clearly enough that a future task could act on it.
- **Block content is opaque to Quay.** Quay parses presence/absence and extracts the prose; it doesn't interpret the rule.

Everything else — review verdict, line locations, comment text, summary body — is whatever GitHub already represents. No new wire protocol, no API coupling between CI and Quay.

### What's the principle vs. the comment

- **Comment** (line-specific): *"This `fetch` call should be wrapped in `withRetries()`."* Tells the reviewer *what to fix here*.
- **Principle** (generalizable): *"External API calls in service code must use `withRetries()` because flaky networks cause cascading failures across our async pipeline."* States the *underlying rule* that the comment is an instance of.

The two are not duplicates. The comment is *this PR's todo*; the principle is *the rule that transfers to future tasks*. Worth the reviewer writing both when the rule is generalizable.

### Why the principle field is load-bearing for the learning loop

- **Dedup unit.** The same principle gets violated across many PRs. Without it, you accumulate N comments saying roughly-the-same-thing in slightly-different prose. Group by principle → one entry with a count, not N near-duplicates.
- **Right granularity for cross-task transfer.** When composing a new `auth-session`-tagged brief, you want 5–10 *principles* relevant to auth-session — not every individual review comment ever filed against an auth-session PR (could be hundreds). Principles are the unit of "lesson learned"; comments are the unit of "this PR's todo."
- **Cheap dedup.** String-similarity match on principle text is deterministic and runs in milliseconds. Without principles, you'd need an LLM clustering pass to derive them from raw comment text — exactly the work you're trying to push upstream into the reviewer.
- **Self-documenting codebase rules.** The accumulated principle set is a de-facto living style guide derived from real review activity.

### What tick does at ingestion

When tick observes `CHANGES_REQUESTED` (in `done` or `pr-open`) and `latest_review_id != last_review_id_acted_on`:

1. Fetch the review payload via `gh`.
2. Write the full payload as a `review_comments` artifact (unchanged from the v1 spec).
3. **New step:** for each line comment in the payload, extract the principle prose if a `quay-principle` fenced block exists, and insert one row into `review_findings` (§3.2) — `principle` set if a block was found, `NULL` otherwise. Always one row per line comment.
4. Schedule the existing non-budget `review` respawn (unchanged); record `last_review_id_acted_on` (unchanged).

Net change vs. today: one additional table, one parse step at ingestion, no change to retry/respawn logic, no change to artifact storage.

### Not every comment needs a principle

Localized comments (*"typo," "this variable name is confusing"*) don't generalize. The reviewer omits the fenced block; the corresponding `review_findings` row stores `principle = NULL`. Per-task display still surfaces these (review history, debugging); the cross-task retrieval query filters them out via `WHERE principle IS NOT NULL`. See §3.2 *"`principle` is optional"* for the full rationale.

---

## 6. Things to note / not forget

- **Quay knows nothing about Linear.** The spec's §2 non-goal stands. Linear-watching code lives in the `linear-adapter`, not in Quay.
- **Tags are opaque to Quay.** Quay stores, indexes, filters, returns. It does not interpret. The boundary holds.
- **Reviewer is a Quay worker, triggered by CI.** See §7. CI's job is one uniform call (`quay review-pr --pr <ref>`) per PR; Quay does the dispatch internally. The reviewer preamble is Quay-versioned (drift-proof contract). The `quay-principle` fenced-block convention from §5 is enforced by Quay's preamble, not by per-repo CI configuration.
- **CI is dispatch-free.** No branch-name sniffing, no Quay-vs-human guessing in CI workflows. Quay looks up `pr_number` in `tasks` and chooses the deterministic or fallback path. Leaking dispatch into CI is what was rejected — keep CI uniform.
- **Panel review is N=1 by default; foundation laid for N>1.** A single-reviewer deployment is just a degenerate review run with one panelist and a trivial pass-through consolidator. The schema and config carry the differentiation axis from day 1 (per-panelist `reviewer_preamble_id`, named preambles, panelist config slugs distinct from model names) so adding Codex / Gemini / a security-focused Opus is a config-only change later — no migration, no abstraction lift. See §7 "Multi-model panel review (foundation)."
- **No post-PR-terminal validation step on findings.** We considered tracking whether each finding was "addressed by a later commit," "re-reviewed," or "ultimately approved" and using a 0–4 strength score to filter the corpus. Rejected as premature optimization for an unmeasured problem. The first-line quality controls are the reviewer contract (§5 — one judgment per comment, opt into the fenced block only when generalizable), the enricher's cap + recency-and-tag-overlap ranking (§3.3 — bounds noise per brief), and worker autonomy (the worker reads principles as advisory, not binding). Revisit only if production data shows measurable corpus pollution. See §7 "Why no validation step" for the full rationale.
- **The orchestrator runtime stays minimal.** Two LLM-heavy steps remain: ticket creation (upstream) and retry-brief composition (downstream of `awaiting-next-brief`). Everything in between — Linear → Quay enqueue, retrieval of past findings — is deterministic.
- **Schema enforcement happens at ticket creation, not at enqueue.** The Hermes skill is the validator. The deterministic adapter trusts the schema.
- **Validate load-bearing fields with code, not just prompt.** Slack thread and originator handle are read by downstream substrate code as required. A code-level check after the LLM draft, before the Linear write, prevents silent breakage of the escalation path.
- **Quay ships the ticket-schema validator (`quay validate-ticket`); Quay does not own ticket semantics.** The orchestrator's ticket-creation skill calls the validator on every draft before writing to Linear. Failed drafts loop with structured error feedback; only validated drafts reach Linear. Schema is per-deployment config; substrate boundary stays intact (Quay still doesn't know what Linear is). Symmetric with the `quay-principle` fenced-block contract (§5) — Quay codifies a small declarative format and provides validation; interpretation lives outside Quay. See §2 "`quay validate-ticket`."
- **Don't pre-build the smart relevance filter.** "Dump all findings under matching tags" is the right v1 — graduate only when noise becomes measurable.
- **Brief enrichment lives inside `quay enqueue` (default-on), not in the orchestrator.** Templated principles section is mechanical data piping over Quay's own schema; the orchestrator passes raw brief + tags and Quay handles the splice. Same boundary shape as `validate-ticket`. Opt out via `--no-enrich-principles` for chore tasks, test isolation, or future LLM-driven composers that want to weave context themselves. See §3.3.
- **One forward-compat decision for an eventual LLM enricher: `tasks.raw_brief` + `tasks.brief` stored separately**, so a future composer can reach the raw brief without parse-and-strip. The `task_enrichment_log` table and the public `quay query-principles` CLI that earlier drafts proposed are deferred to migration time — additive then too, and the v1 cost outweighed the v1 benefit. Explicitly *no* strategy interface, ranking-DSL config, ranking subquery, position config, or LLM-cost tracking until a second consumer actually exists. See §3.3.
- **Decay is real but not day-one work.** Keep timestamps; add recency weighting / invalidation when the corpus gets large enough to need it.
- **The `principle` field is what makes the learning loop tractable cheaply.** Without it, dedup and ranking require LLM passes. With it, they're string operations. Push the work to the reviewer agent at write time, not the adapter at read time.
- **`principle` is optional, and that's the only signal.** `principle IS NULL` means *"localized comment, not generalizable."* No separate boolean. Every line comment becomes one row; only generalizable ones carry a principle. Per-task display surfaces all rows; cross-task retrieval filters with `WHERE principle IS NOT NULL`.
- **The reviewer's only Quay-specific convention is the `quay-principle` fenced block.** No other metadata fields. Single judgment call per comment — *"is there a transferable rule here?"* Everything else is a normal GitHub review.
- **`review_findings` is a pure index, not a copy.** Only structured fields you query against (`principle`, `file_path`, `line_number`, `source_url`, etc.). Comment prose lives in the `review_comments` artifact JSON; `source_url` is the bridge. No data is duplicated between SQL and the artifact store.
- **`review_comments` artifact remains the source of truth for prose and history.** If the reviewer's output schema ever changes, the snapshots are still complete; only the `review_findings` projection has to be re-derived.
- **Defer `principle_slug`.** Free-text dedup is good enough until prose variance demonstrably hurts. Adding a slug column later is an additive schema change.

---

## 7. Reviewer as a Quay worker

This supersedes the earlier "reviewer in CI" framing in §1 and §4. The shift: instead of relying on a CI workflow to file reviews and emit `quay-principle` blocks by convention, **Quay spawns the reviewer as a worker** — same substrate as code workers, different preamble, different exit contract. The fenced-block contract becomes Quay → Quay (drift-proof) instead of CI → Quay (configuration-fragile).

### Why move the reviewer into Quay

1. **Single owner of the convention.** The reviewer preamble lives in Quay (analogous to `preambles` and `retry_templates`); versioned, deterministic across repos. The fenced-block contract is internal between Quay and a Quay-spawned worker — not a CI integration contract that drifts across repos and teams.
2. **Quay already has the task context.** Brief, prior attempts, session log, ticket snapshot, prior `review_comments`. The reviewer is prompted with all of that. A CI-side reviewer has only the diff and PR description — strictly less context.
3. **Reuses the entire substrate.** Worktree, tmux, supervisor lock, attempts table, artifact store, retry/escalation/cancel machinery. A reviewer is just a worker with a different preamble and a different exit condition (post a review via `gh pr review` instead of push code).
4. **Enforcement is structural, not by convention.** If the reviewer doesn't emit principles correctly, that's a Quay-side bug to fix, not a per-repo configuration problem.

### Two trigger paths

CI is still the natural trigger event — the PR's regular CI workflow runs a small step that calls Quay after CI passes. But the dispatch downstream of that call splits on whether the PR was Quay-spawned:

| | Quay-task PR (deterministic) | Human-authored PR (orchestrator fallback) |
|---|---|---|
| **CI calls** | `quay review-pr --pr <repo>:<num>` | `quay review-pr --pr <repo>:<num>` (same call) |
| **Quay's lookup** | Finds matching `tasks` row by `pr_number` + `repo_id` | No matching task — falls back |
| **Brief composer** | Quay (templated, deterministic, uses task context) | Orchestrator (Hermes; LLM; reasons about the PR) |
| **Spawn** | Tick promotes a reviewer attempt against the existing task | Tick promotes a reviewer attempt against a synthetic task |
| **Tags** | Inherited from the originating ticket | Assigned by the orchestrator |

The dispatch decision is one SQL lookup: `SELECT task_id FROM tasks WHERE pr_number = ? AND repo_id = ?`. Match → deterministic; no match → fallback.

### Trigger and latency

The pull-only model from the spec's §11 is great for the regular orchestrator loop, but it's a problem for the human-PR fallback path: poll-interval + tick-interval can stack to ~10 min, which is annoying in CI.

**The CI side is uniform.** CI calls `quay review-pr --pr <repo>:<num>` for *every* PR — no branch-name sniffing, no dispatch logic, no awareness of "is this a Quay task or not." Quay does the dispatch. CI's job is exactly one call per PR, identical across PRs. This is non-negotiable in the design — leaking the dispatch decision to CI ties the CI workflow to Quay's task-tracking conventions and forces every repo's CI to know about branch naming. Don't do that.

The dispatch lives entirely inside Quay's `review-pr` handler:

```
quay review-pr --pr <repo>:<num>
   │
   ▼
SELECT task_id FROM tasks WHERE pr_number = ? AND repo_id = ?
   │
   ├─ match  → deterministic path. Compose brief from task context.
   │           Schedule reviewer attempt (rows in `pending` / `queued`). Return.
   │           Cron-driven tick promotes within at most one cadence cycle
   │           (default 30 s — see "Tick cadence" below).
   │
   └─ none   → fallback path. See three sub-options below.
```

Three sub-options for the fallback (no task match), ordered by what they buy:

**Option A — Synchronous Quay → Hermes RPC (recommended).** Quay's `review-pr` handler, on no-match, calls a Hermes HTTP endpoint synchronously with the PR ref (`POST /compose-reviewer-brief`). Hermes does its LLM call (~10–30 s), returns the composed brief and the assigned tags. Quay creates the synthetic task with `state = queued` directly (skipping `review_requested` entirely, because the brief is already in hand), schedules the reviewer attempt, returns success to CI. Cron-driven tick (30 s cadence — see "Tick cadence" below) promotes the attempt to `running`.

- **Latency:** ~30–60 s end-to-end. Same call from CI's perspective whether it's the Quay-task path or the human-PR path.
- **Cost:** Hermes needs an HTTP receiver (one endpoint, one shared secret, one process per deployment).
- **Spec impact:** this is a *narrow, scoped exception* to spec §11 *"Quay never initiates outbound communication to the orchestrator."* The §11 invariant survives the most important way: **tick** still never reaches out to Hermes; tick remains pure pull-from-external. The new outbound is from an *operator-initiated entry point* (`review-pr`, called by CI), is *synchronous request/response* (not autonomous push), and is *bounded in failure* (Hermes down → `review-pr` returns an error to CI, which is the same shape as any CI step failing). None of the failure modes §11 was protecting against (orchestrator availability coupling, push-channel reliability, hidden state pushed by Quay) apply. Document it as a scoped exception in the doc-of-record.

**Option B — Pull-style fallback (no Hermes RPC).** On no-match, Quay creates the synthetic task in `review_requested` and returns immediately to CI. The orchestrator's regular pull loop picks it up at its next poll. **Cost:** poll-interval latency is back (~5–10 min). Useful as a *secondary* path for deployments that don't want to operate a Hermes HTTP receiver, or as a fallback when the receiver is down. Failure mode for Option A naturally degrades into Option B: if Quay's outbound HTTP call to Hermes fails, Quay falls back to creating the synthetic task in `review_requested` — the orchestrator's regular pull eventually picks it up. **Worth keeping as the supported degraded mode.**

**Option C — Generic reviewer brief, no Hermes involvement.** On no-match, Quay schedules a reviewer attempt with a templated "review this PR" brief — diff + PR description, nothing else. **Cost:** findings aren't tagged at ingest, crippling cross-task retrieval. Recover by running an async Hermes pass nightly to assign tags after the fact. Worth considering only if Hermes is genuinely unavailable for the deployment.

**Recommendation: Option A as primary, Option B as graceful degradation.** Quay's `review-pr` handler tries the synchronous RPC first; on HTTP failure / timeout / no Hermes endpoint configured, falls back to scheduling in `review_requested` for the pull loop. CI sees uniform behavior either way; only the latency differs.

### Tick cadence

The review path goes through cron-driven tick three times: schedule → spawn panelists, panelists-done → spawn consolidator, consolidator-done → post review. (With Phase 1 #4 below, the second is collapsed into "tick observes fan-in *and* spawns the consolidator in the same run," so it doesn't add a separate wait.) Each transition can wait up to one cron cycle. With cron at the spec's default 5 min, that's up to ~10 min of pure cron lag in the worst case — unacceptable for a CI-gating use case.

**Recommendation: tighten the cron cadence to 30 s for review-running deployments.** Tick is cheap when there's nothing to do (single SQL count + early exit, ~5–50 ms); the supervisor lock prevents overlap; idle-ticks are essentially free at 30 s on local SQLite. This is a deployment-config change (`crontab`, `systemd timer`, `launchd`) — no Quay code change.

At 30 s cadence, per tick-spacing wait:
- **Average wait:** ~15 s (event lands at uniform-random offset in the cycle).
- **Worst case:** ~30 s.

Total review latency:

| | Average | Realistic worst case |
|---|---|---|
| `max(panelist runtime)` | 1–3 min | 5 min |
| Consolidator runtime | 30–60 s | 1–2 min |
| Tick lag (3 waits × ~15 s avg / ~30 s worst) | ~45 s | ~90 s |
| `gh pr review` post + polling wake-up | ~5 s | ~5 s |
| **Total review wall-clock** | **~3.5 min** | **~8.5 min** |

(Hard worst case — workers hitting the 1-hour `max_attempt_duration_seconds` cap — is ~2 hours, but that's "everything hung at the wall-clock cap" rather than architecture lag, and the wall-clock kill is the recovery mechanism.)

**Why we did *not* introduce CLI-driven inline tick.** An earlier sketch had `review-pr` invoke `quay tick` inline at the end of its handler to skip the first tick-spacing wait (~30 s worst case). That was load-bearing when cron was at 5 min default; it's negligible at 30 s cadence and would have introduced a second spawn entry point alongside cron-driven tick. **Dropped — tightening cron is the simpler, more uniform fix.** The single-spawn-point invariant from spec §5 stays clean: cron-driven tick is the only thing that promotes anything, no special path for the review trigger.

**If 30 s tick lag is ever too slow** (sub-15 s target), the next move is event-driven progress (tmux `session-closed` hook firing tick) — sub-second latency, additive to cron-driven tick which still runs as the correctness floor. Defer until measurements show 30 s is inadequate.

### Capacity

Code workers and reviewers strain different things, so they get separate caps.

- **`max_concurrent`** (existing, default `2`) — caps **code workers** in `running`. The original spec cap. Hardware-protective: each code worker owns a worktree (full `git worktree add`, `npm/bun install`, possibly hundreds of MB of `node_modules`), runs `tsc`, runs builds, runs tests. Two code workers can already chew through CPU + disk on a small VPS. Default stays `2`.
- **`max_concurrent_review_runs`** (new, default `15`) — caps **review runs** in any non-terminal state (`panelists_running`, `consolidating`, `posting`). The cap is at the **run** level, not the panelist level. Each run spawns its N panelists + 1 consolidator atomically when promoted; the run counts as `1` against this cap regardless of N.

The asymmetry that justifies separate caps:

| | Code worker | Reviewer panelist / consolidator |
|---|---|---|
| Worktree | Own worktree per worker (heavy: clone + install) | Shares the run's single read-only worktree |
| Disk churn | `node_modules`, build artifacts, test outputs | None |
| Compute | `tsc`, builds, test runs (CPU-heavy) | Read files, make LLM calls (LLM provider's GPUs do the work) |
| Local resource cost | High — CPU + memory + disk | Low — tmux session + agent CLI process + network |
| Real bottleneck | Host hardware | LLM-API rate limits / budget |

So `max_concurrent` protects your VPS; `max_concurrent_review_runs` is a budget/rate-limit safety net rather than a hardware guardrail. At default `15`, with N = 4 (3 panelists + 1 consolidator) per run, that's up to ~60 simultaneous tmux sessions for reviews — well within file-handle and process-table headroom on any reasonable host. The actual ceiling under that load is your LLM provider's per-minute request quota.

Why `15` as a default:
- **High enough that team velocity never hits the cap** under steady-state activity (a few PRs per hour).
- **Low enough that a runaway burst is bounded** (e.g., a config bug that auto-opens 100 PRs doesn't translate into 100 simultaneous review runs and a surprise bill).
- **Operators with tight LLM budgets tighten it.** Operators with bigger budgets and rate-limit headroom raise it.

Promotion in tick: when promoting a `pending` run → `panelists_running`, tick checks both `COUNT(*) WHERE state = 'panelists_running' OR 'consolidating' OR 'posting'` against `max_concurrent_review_runs` and only promotes if there's headroom. Pending runs that exceed the cap stay in `pending`; the next tick re-checks. Same shape as `max_concurrent` for code workers.

A code worker and a review run **do not compete** for the same slot — the two caps are independent. A deployment can have 2 code workers + 15 review runs concurrently without one starving the other.

### Synthetic task vs. first-class reviews

For human PRs, two shapes for where the reviewer attempt lives:

- **Synthetic task (recommended).** Create a `tasks` row with no `external_ref`, `pr_number` set, a synthesized `task_id`. Reviewer attempts hang off it like any other attempt, distinguished by `attempts.reason = 'review_only'`. The learning-loop join (`task_tags JOIN review_findings`) just works without special-casing. Initial `state` depends on which fallback path Quay took:
  - **Option A (synchronous Hermes RPC succeeded):** synthetic task lands directly in `queued` with the brief and tags already populated.
  - **Option B (pull-style fallback):** synthetic task lands in `review_requested`; orchestrator pulls, claims, calls `quay submit-review-brief`, and the task transitions to `queued`.
- **First-class `reviews` table.** New table, separate from tasks. Pro: clean conceptually. Con: every cross-task query now has to handle two parents.

Synthetic task wins because it preserves schema uniformity. *"Task that originated from a PR-review trigger"* is a fine sub-genre of task; it just has a different `reason` and never spawns a code worker.

### State-machine delta

A new state and a new terminal at the **task level**:

```
   review_requested  ──orchestrator submits brief──►  queued  ──tick promotes──►  running
        │                                                                            │
        │ (Quay-task path AND Option-A-fallback both skip review_requested —         │
        │  brief is in hand at scheduling time, so the synthetic task is             │
        │  inserted directly in queued)                                              │
                                                                                     ▼
                                                                    reviewed (terminal)
```

- **`review_requested`** — pull-style fallback only (Option B; or Option A's degraded path when the Hermes RPC fails). The synthetic task sits here while the orchestrator pulls/claims/composes. Both the Quay-task path *and* a successful Option-A RPC skip this state because the brief is composed before the task row is written, so the task is inserted directly in `queued`.
- **`reviewed`** — terminal. There's no retry semantics for a review run; it's one-shot by design. The synthetic task transitions to `reviewed` whether the run succeeded (review filed on GitHub) or failed (no review filed, but the run is logically done). The verdict mapping for `--wait` reads `review_runs.status`, not the task state, so success vs. failure is distinguishable to CI.
- **Run-level sub-states** (on `review_runs.status`, while the task is in `running`): `pending → panelists_running → consolidating → posting → reviewed | failed`. See "Multi-model panel review (foundation)" above for the per-state behavior. For `N=1` deployments these collapse to a near-trivial sequence; for panel deployments they handle fan-out/fan-in.
- **All existing claim/escalation/cancel machinery applies.** A `review_requested` task can be claimed, escalated, cancelled, and re-claimed exactly like an `awaiting-next-brief` task. The fences from the spec's §10 (claim_id, cancel_requested_at) work unchanged. Cancel during a panel run kills all in-flight panelist tmux sessions (N of them) plus the consolidator session if active, then removes the run's single shared worktree per the standard finalizer path.

### Reviewer worker contract

The reviewer is a worker with a different preamble. Differences from the code-worker preamble in spec §6:

- **Exit condition:** post a review via `gh pr review --request-changes` / `--comment` / `--approve` (with line-level comments where applicable), then exit. No PR creation, no push, no branch ownership.
- **Workspace boundary:** read-only on the worktree (the worktree exists for context; the reviewer doesn't modify code).
- **Output convention:** for each line comment that expresses a generalizable rule, append a fenced ` ```quay-principle ` block to the comment body containing the principle prose. Exactly the contract from §5; now enforced by a Quay-versioned preamble.
- **Blocker file (`.quay-blocked.md`)** still applies for "I can't review this for some reason." Routes through the same orchestrator-pickup path.

### CLI surface (additions)

| Command | Purpose | Caller |
|---|---|---|
| `quay review-pr --pr <repo>:<num> [--wait] [--timeout <s>]` | **The single CI-callable entry point.** Looks up task by PR ref; deterministic path if matched (composes brief from task context, schedules reviewer attempt). On no-match, attempts Option A (synchronous RPC to Hermes, returns brief + tags, schedules in `queued`); on RPC failure, falls back to Option B (creates synthetic task in `review_requested` for the orchestrator's pull loop). Returns once the run is scheduled — cron-driven tick (30 s cadence) promotes the attempt to `running`. CI's behavior is uniform across all PRs — no dispatch logic on the CI side. **With `--wait`,** blocks (polling SQL) until the run reaches `reviewed` and exits with a verdict-mapped exit code; bounded by `--timeout`. SHA-keyed idempotency at the run level (`UNIQUE(repo_id, pr_number, head_sha)` on `review_runs`) means re-runs on the same head SHA reuse the existing verdict instead of spawning fresh. See "Blocking mode (CI as a gate)" below. | CI |
| `quay submit-review-brief --task-id <id> --claim-id <id> --brief-file <path>` | Orchestrator's response on the pull-style fallback path (Option B). Mirrors `submit-brief` exactly: ownership-fenced, transitions `review_requested → queued`. Only used when Option A wasn't viable (Hermes endpoint not configured / RPC failed / deployment opted for pull-style). | Hermes |

There is **no** `quay enqueue-review` CLI command. Enqueueing the synthetic task is an internal operation inside `review-pr`, not a separate caller-visible step. The orchestrator never enqueues directly for the review path; it only responds to a Quay-issued claim (Option B) or an inbound RPC (Option A's HTTP receiver, which is a Hermes-side concern, not a Quay CLI).

The existing `quay tick`, `quay task claim` / `release-claim` / `cancel`, `quay task list --state review_requested`, `quay artifact get` all work on these synthetic tasks unchanged.

### Hermes HTTP receiver (Option A)

Hermes exposes a single endpoint Quay calls when it needs a reviewer brief composed:

```
POST /compose-reviewer-brief
  body: { repo_id, pr_number, head_sha, pr_diff_url, pr_title, pr_body }
  auth: shared secret in header
  response (success):
    { brief: <string>, tags: [<string>, ...] }
  response (error):
    HTTP 5xx — Quay falls back to Option B (creates synthetic task in review_requested)
```

This is the *only* outbound HTTP call Quay ever makes to Hermes. It's synchronous, request/response, scoped to operator-initiated review handling, and gracefully degrades. Tick remains pure pull-from-external; the spec's §11 invariant survives in the load-bearing way.

### Blocking mode (CI as a gate)

Fire-and-forget review filing is the default — `quay review-pr` returns once the reviewer attempt is *scheduled*. But the reviewer is most valuable as a real merge gate, where CI blocks until the verdict is in and either passes or fails the check accordingly. Two flags extend `review-pr` to support this:

```
quay review-pr --pr <repo>:<num> --wait --timeout <seconds>
```

#### Exit codes

| Exit | Meaning | CI semantics |
|---|---|---|
| `0` | Reviewer approved | Check passes |
| `1` | Reviewer requested changes | Check fails (hard-gate posture) or records verdict (advisory posture) |
| `2` | Reviewer commented (no verdict) | Treat as advisory; usually pass-through |
| `3` | Reviewer errored (blocker file, crash, malformed signal) | Surface to operator; usually fail the check |
| `4` | Timed out — reviewer still working OR fallback path stuck in `review_requested` | Re-run later; CI typically pass-through with a soft warning |

The CI step is then trivial:

```yaml
- run: quay review-pr --pr ${{ github.repository }}:${{ github.event.pull_request.number }} --wait --timeout 480
```

GitHub branch protection requires the resulting "Agent Review" check (or whatever the workflow names it) to pass for merge.

#### How blocking is implemented

A polling loop inside the CLI: sleep 2–5 s, query SQL for the reviewer attempt's state, exit when terminal. Same shape as the orchestrator pull loop from spec §11 — no new infrastructure, no daemon, no push channel. Polling is read-only, so the supervisor lock is unaffected.

#### SHA idempotency is load-bearing

When CI re-runs the workflow (rebase, re-trigger after a fix, manual re-run of a failed check), `review-pr` must **not** always spawn a fresh review:

1. **Look up by head SHA first.** `SELECT * FROM review_runs WHERE repo_id = ? AND pr_number = ? AND head_sha = ?` — the `UNIQUE(repo_id, pr_number, head_sha)` constraint guarantees at most one row. If the run is in `reviewed` (success or `failed`-with-fallback), return its verdict immediately — don't re-spawn.
2. **Attach to in-flight runs.** If a run exists in `pending` / `panelists_running` / `consolidating` / `posting` for the same SHA, wait on its outcome rather than scheduling a duplicate. The polling loop just watches `review_runs.status`.
3. **Only spawn fresh on a new SHA.** If no run exists for the current head SHA (push since last review, or first run), proceed with the normal dispatch.

Without this, every CI re-run on the same commit burns N fresh LLM calls (one per panelist) plus the consolidator. With it, re-runs are free — they just re-read the existing run's verdict. For `N=1` deployments the property is the same, just cheaper.

#### Failure-mode handling

- **Reviewer hangs / takes too long.** The `--timeout` flag bounds CLI wait time independently of Quay's `max_attempt_duration_seconds`. On timeout: exit code `4`. The reviewer keeps running; the next CI re-run picks up the verdict via SHA idempotency.
- **Hermes RPC fails → Option B fallback.** The synthetic task lands in `review_requested`; the orchestrator's pull cycle can take 5–10 min. **Don't block on this path** — `review-pr --wait` detects `review_requested` and exits with code `4` immediately. Blocking the full pull cycle is the worst-of-both; fail fast and let CI re-run. By the second run, the orchestrator has likely picked it up and the reviewer has either finished or is in flight.
- **Quay down.** CLI exits non-zero immediately. Same failure shape as any infra-down CI step.
- **CI runner killed mid-wait.** Reviewer keeps running; verdict gets captured to SQL regardless. Re-run picks it up via SHA idempotency. No orphaned state.

#### Deployment posture: hard gate vs. advisory

Whether the agent verdict *blocks merge* or stays *advisory* is a deployment choice, not a Quay design choice. Both postures use the same `--wait` mechanics; only the CI workflow's interpretation of exit codes differs.

- **Hard gate.** CI step propagates `exit 1` (changes requested) as a CI failure; branch protection blocks merge. Real enforcement; real false-positive cost — when the agent's calibration is off, developers can't merge until the agent agrees or someone overrides via repo admin. Appropriate once the reviewer's miss rate and false-positive rate have been measured on production PRs.
- **Advisory.** CI step always passes (or only fails on `exit 3` — actual reviewer errors). The review is still filed on GitHub via `gh pr review --request-changes`, so humans see findings in the PR UI and act on them. No merge blocking. Appropriate for early rollout while reviewer calibration is unproven.

Recommendation: ship with **advisory** as the default, flip to hard gate per-repo (or globally) once the agent-miss query (see "Reviewer-improvement loop" below) shows a stable calibration profile. The schema/CLI changes don't differ between postures — only the workflow's `if: failure()` logic does.

#### What this does *not* require

No new states, no new attempt reasons, no new tables. Just:

- Two flags on `review-pr` (`--wait`, `--timeout`).
- The SHA-keyed dedup lookup at the start of the handler.
- A polling-and-mapping helper that reads the reviewer attempt's state and translates to an exit code.

All purely additive to what §7 already specifies.

### Multi-model panel review (foundation)

The single-reviewer design described above is the **N=1 degenerate case** of a more general pattern: spawn N reviewer panelists in parallel against the same PR (potentially with *different prompts each*), then a consolidator merges/condenses their findings into one consolidated review filed on GitHub. The schema and config shape laid out below support panel review from day 1, even when the initial deployment runs `N=1` with a single default preamble. Adding a model later is a config-only change.

#### The shape

A *review run* becomes the logical unit, keyed by `(repo_id, pr_number, head_sha)`:

```
                                      ┌─ panelist (Opus, security-focus) ─┐
review-pr --pr X  ──►  review_run  ──►├─ panelist (Codex, perf-focus)    ─├──►  consolidator  ──►  gh pr review
                                      └─ panelist (Gemini, style-focus)  ─┘
```

- **Panelists run in parallel,** all in the **single shared worktree** of the synthetic task (one `git worktree add` per review run, not per panelist). Panelists are read-only on the worktree per the §5 reviewer contract, so concurrent reads don't conflict. Each panelist gets its own tmux session (`quay-review-<run_id>-<panelist_name>`) for process isolation. All share the same review brief by default (PR-specific context); each gets its own *preamble* (focus / role / specialty).
- **Panelists do not file reviews on GitHub.** They write findings to `<worktree>/.quay-review-output-<panelist_name>.json` (per-panelist filename so parallel writes don't collide) and exit. Letting each panelist post would produce N reviews on the PR, defeating consolidation.
- **The consolidator is itself a worker.** Same substrate as panelists — Quay-spawned, tmux-observed, with its own preamble (`consolidator_preamble`). It reads N panelist outputs, produces one consolidated review file. A subsequent supervisor-lock-protected step posts the consolidated review via `gh pr review`.
- **Single reviewer is `N=1`.** Same machinery; one panelist, trivial consolidator (pass-through). No throwaway code when graduating from single → panel.

#### Schema

```sql
CREATE TABLE review_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  pr_number INTEGER NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,
    -- pending / panelists_running / consolidating / posting / reviewed / failed
  consolidator_preamble_id INTEGER NOT NULL REFERENCES consolidator_preambles(id),
  shared_brief_artifact_id INTEGER NOT NULL REFERENCES artifacts(artifact_id),
  consolidated_review_artifact_id INTEGER REFERENCES artifacts(artifact_id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(repo_id, pr_number, head_sha)        -- run-level SHA idempotency
);

CREATE TABLE review_panelists (
  panelist_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES review_runs(run_id),
  panelist_name TEXT NOT NULL,                -- 'opus-security' / 'codex-perf' / ...
                                               -- config slug; PRIMARY for analysis
                                               -- (distinct from model_name because two
                                               -- panelists may share a model with
                                               -- different preambles)
  model_name TEXT NOT NULL,                   -- 'opus' / 'codex' / 'gemini-3.1'
  agent_invocation TEXT NOT NULL,             -- snapshot at spawn time, even if
                                               -- the config later changes
  reviewer_preamble_id INTEGER NOT NULL REFERENCES reviewer_preambles(reviewer_preamble_id),
                                               -- per-panelist; THIS is the foundation
                                               -- for "different prompt per panelist"
  brief_artifact_id INTEGER REFERENCES artifacts(artifact_id),
                                               -- nullable; NULL = use shared run brief.
                                               -- Forward-compatible hook for per-panelist
                                               -- briefs without forcing them in v1.
  tmux_session TEXT,                          -- per-panelist; the worktree is shared
                                               -- (lives on the synthetic task)
  spawned_at TEXT,
  ended_at TEXT,
  exit_kind TEXT,                              -- output_written / crashed / timed_out / blocker
  raw_findings_artifact_id INTEGER REFERENCES artifacts(artifact_id),
  UNIQUE(run_id, panelist_name)
);

CREATE TABLE consolidator_preambles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX consolidator_preambles_by_name_latest
  ON consolidator_preambles(name, created_at DESC);
```

`reviewer_preambles` (already introduced earlier) gains a `name TEXT NOT NULL` column with the same name-latest index, so panelists can reference preambles by name (`'reviewer-default'`, `'reviewer-security'`, ...) and resolve to the latest row at spawn time.

`review_findings` (§3.2) extends with attribution columns to support per-panelist analysis:

```sql
ALTER TABLE review_findings ADD COLUMN run_id INTEGER REFERENCES review_runs(run_id);
ALTER TABLE review_findings ADD COLUMN panelist_id INTEGER REFERENCES review_panelists(panelist_id);
-- panelist_id NOT NULL  →  raw finding from a specific panelist
-- panelist_id NULL      →  consolidated finding (the one filed on GitHub)
```

Cross-task learning loop queries (§3.2 / §4) filter to consolidated findings only: `WHERE panelist_id IS NULL`. Per-model and per-focus analysis (the reviewer-improvement loop) queries the raw rows.

#### Configuration

Per-deployment or per-repo, list the panelists. Adding a model = adding an entry. Different focuses = different preamble names.

```toml
[[review_panelists]]
name = "opus-security"
model_name = "opus"
agent_invocation = "claude --model claude-opus-4-7 --prompt-file {prompt_file}"
preamble = "reviewer-security"             # name → reviewer_preambles row

[[review_panelists]]
name = "codex-perf"
model_name = "codex"
agent_invocation = "codex --prompt-file {prompt_file}"
preamble = "reviewer-performance"

[[review_panelists]]
name = "gemini-style"
model_name = "gemini-3.1"
agent_invocation = "gemini --prompt-file {prompt_file}"
preamble = "reviewer-style"

# Forward-compatible hook (not used in v1):
# brief_template = "perf-focused-brief"    # → per-panelist brief composer override

[review_consolidator]
preamble = "consolidator-default"
```

The `preamble` field is **required from day 1**, even when all panelists initially point at the same default (`preamble = "reviewer-default"` × N). That's what lays the foundation: the differentiation axis is in the data model from the start, with no migration when it's actually used.

#### Two design rules worth pinning explicitly

1. **The consolidator dedupes/condenses; it does not introduce new findings.** Findings only come from panelists. The consolidator is a merge/condense function — high-quality but not the source of truth for "what's a finding." Keeps the reviewer-improvement loop signal clean (panelists are what's being calibrated).
2. **Panelists are independent — they do not see each other's outputs.** Independence preserves model-disagreement signal (which is itself a calibration metric). The consolidator is the single place where agreement / overlap is evaluated.

Both are encoded in the panelist preamble (panelists never read sibling outputs by construction — they exit before the consolidator spawns) and the consolidator preamble (consolidator may merge/condense but not invent).

#### Tick handles fan-out / fan-in

The state machine for `review_runs` (sub-states of the synthetic task's `running`):

- `pending` → tick schedules N panelist worker attempts in parallel against the run's single shared worktree (the synthetic task's worktree, already created at task creation — no per-panelist worktrees); transition → `panelists_running`.
- `panelists_running` → tick observes each panelist's tmux session via the existing dead-worker classifier. When all N are terminal (success or failure), evaluates the failure-mode threshold (below) and either transitions → `consolidating` or → `failed`.
- `consolidating` → tick spawns the consolidator with panelist outputs as input. Same observation pattern as a regular worker.
- `posting` → consolidator finished cleanly with a consolidated review file; tick (under the supervisor lock) calls `gh pr review` to post it.
- `reviewed` → terminal; the synthetic task transitions to `reviewed` too.
- `failed` → terminal failure mode; the synthetic task still transitions to `reviewed` (the review *run* is done, even if no review was filed); the verdict mapping for `--wait` returns the appropriate non-zero exit.

This reuses the existing tick chokepoint, supervisor lock, and dead-worker classifier — same machinery, just iterating over `review_panelists` rows instead of a single `attempts` row at the panelists step. The supervisor lock protects the GitHub `gh pr review` post in the `posting` step exactly as it protects any other supervisor side effect.

#### Failure-mode policy (config-driven)

- **Minimum panelists for consolidation.** *"Consolidator runs if at least M of N panelists succeeded."* Default `M = ceil(N / 2)`. If too few succeed, run → `failed`; `--wait` returns non-zero.
- **Consolidator failure: degraded fallback.** If the consolidator fails (crash, malformed output, timeout), Quay falls back to filing the **deterministic union** of raw panelist findings (every unique principle from any panelist, no condensation) and sets `degraded_consolidation = true` on the run. Better than no review; honest about quality. Operators can opt this off and prefer hard-fail via config.
- **Per-panelist hangs.** Existing wall-clock kill from spec §5 applies per panelist independently. Other panelists keep running.

#### `--wait` interaction

`review-pr --wait` polls `review_runs.status` (not a single attempt's state) until terminal. SHA idempotency is at the **run** level — `UNIQUE(repo_id, pr_number, head_sha)` on `review_runs` means re-runs against the same SHA reuse the existing run, never spawn duplicates. The verdict for blocking mode is on the consolidated review (or the union-fallback review if the consolidator failed).

#### Cost & staging recommendation

Three models per PR is 3× the LLM cost per review, plus consolidation. For busy repos this is real money. Two non-invasive mitigations:

- **Per-tag panelist selection.** Map tags → required panelists in repo config. Touching `auth-session` triggers all 3; touching `docs` triggers just one. Quay reads the synthetic task's tags, picks the panelist subset at run-creation time, spawns only those. Schema unchanged; only the spawn list shrinks.
- **Sequential staging** (escalate to panel only if the cheap reviewer flags something). More involved; defer.

Build single-reviewer (N=1) end-to-end first; the panel layer is a strict generalization on top. Forward-compatible — single-reviewer becomes the N=1 case of the same abstraction.

### Reviewer-improvement loop (the second-order learning signal)

The clean property of bringing reviews into Quay: **the same loop that improves task briefs over time can also improve reviewer briefs over time.** The signal:

> *"A Quay reviewer approved a PR; later, a non-Quay reviewer (human or another bot) requested changes against the same SHA the agent endorsed."*

Each match is a labeled training example — *"the agent reviewer should have caught this but didn't."* Quay observes both halves deterministically:

- The Quay reviewer's verdict is captured at review time. Recorded as a new artifact kind (`agent_review`) plus the per-line rows in `review_findings` with the agent's findings.
- Subsequent human `CHANGES_REQUESTED` events are already snapshotted (`review_comments` artifact + new rows in `review_findings`).

Detecting a miss is one SQL query: *"for each agent-approved review at SHA X, did a non-agent reviewer subsequently request changes at SHA X (or a SHA the agent reviewer also implicitly endorsed) with at least one principle the agent didn't emit?"* The result set is the miss corpus.

What the orchestrator does with it (prompt-tune the reviewer, generate targeted training data, surface to humans for review) is its own concern. Quay's job is just to make the misses queryable.

#### Schema additions to `review_findings` (extending §3.2)

```sql
ALTER TABLE review_findings ADD COLUMN reviewer_kind TEXT NOT NULL DEFAULT 'human';
-- 'agent_quay'     — filed by a Quay-spawned reviewer worker (panelist or consolidated)
-- 'agent_other'    — filed by a known external bot account (configurable allowlist)
-- 'human'          — everything else
ALTER TABLE review_findings ADD COLUMN review_verdict TEXT;
-- 'approved' / 'changes_requested' / 'commented' — captured per-row from the parent review
ALTER TABLE review_findings ADD COLUMN review_head_sha TEXT;
-- the PR head SHA at review time; used by the miss-detection query

-- (Also added by "Multi-model panel review" above; listed here for completeness.)
-- ALTER TABLE review_findings ADD COLUMN run_id INTEGER REFERENCES review_runs(run_id);
-- ALTER TABLE review_findings ADD COLUMN panelist_id INTEGER REFERENCES review_panelists(panelist_id);

CREATE INDEX review_findings_by_reviewer_kind ON review_findings(reviewer_kind);
CREATE INDEX review_findings_by_panelist ON review_findings(panelist_id);
```

`reviewer_kind` is set at ingestion based on the GitHub user that filed the review (configurable: a list of bot accounts that count as `agent_quay`, with Quay's own bot as the obvious member). `review_head_sha` is what the miss-detection query joins on. `panelist_id` is `NULL` on the consolidated finding that landed on GitHub (this is what cross-task learning queries should filter to) and `NOT NULL` on each raw panelist finding (for per-model and per-focus miss analysis).

#### Why no validation step on findings

An earlier draft of this design proposed post-PR-terminal validation columns (`addressed_by_commit_sha`, `reviewer_re_reviewed_at`, `reviewer_final_verdict`) producing a 0–4 *validation strength* score, used as a soft gate (`>= 2`) on both the brief enricher and the reviewer-improvement corpus. **That step has been dropped from the design.** Reasons:

- **It solves an unmeasured problem.** We have zero data showing the corpus actually gets polluted in practice. Pre-emptively building a filter for hypothetical noise is exactly the kind of speculative scaffolding the spec discipline rejects.
- **The deterministic signal is weaker than it looks.** `git log -L` "did a commit touch the locus" misclassifies on rebases, line moves, and unrelated edits. PR-wide / review-body principles have no locus at all and cap at strength 3 with a gap at strength 2 — meaning a uniform numeric score conflates two qualitatively different signals.
- **It pulls Quay across the substrate boundary.** Tick observing PR activity to derive a quality score is *Quay reasoning about review quality* — a substrate-creep similar to the things we explicitly reject elsewhere (auto-cancelling experimental tasks, tag-driven worker routing). Quay stores findings opaquely; consumers decide what to do with them.
- **The first-line quality controls are sufficient.** Three layers already address the noise concern:
  1. **The reviewer contract (§5).** `quay-principle` blocks are emitted only when the reviewer judges a finding generalizable. If reviewers are sloppy, fix the reviewer (preamble revision, prompt-tune, replace) — don't paper over it with downstream filters. The agent reviewer's preamble is Quay-controlled and versioned.
  2. **Enricher cap + ranking (§3.3).** At most `enrich_principles_default_max` (15) principles per brief, ranked by recency × tag-overlap. Stale and off-topic noise falls off the bottom of the cap naturally.
  3. **Worker autonomy.** The worker reads principles as advisory hints, not binding rules. A bad principle is a bad hint, not a corrupting input.
- **A noisy-but-honest corpus is better than a filtered-but-misleading one for the reviewer-improvement loop.** False negatives from validation (real misses filtered out as "unvalidated") are *worse* than false positives (sloppy human comments included) — because filtered misses are invisible to whoever later does prompt-tuning. The downstream consumer of the miss corpus can apply its own quality judgment (LLM-assisted review, manual triage) on actual rows; that's the right place for that judgment, not in Quay.

What Quay does keep, derived from the dropped design:

- **`reviewer_login TEXT`** stays as a column on `review_findings` (and is listed below alongside `reviewer_kind`). Cheap, useful for "who reviewed what" queries, no derived score attached. If per-reviewer reputation features are ever built downstream, the data is there.
- **All other identity / attribution columns** (`reviewer_kind`, `review_verdict`, `review_head_sha`, `run_id`, `panelist_id`) stay — they are facts about the review, not derived quality scores.

What gets dropped:

- `addressed_by_commit_sha`, `reviewer_re_reviewed_at`, `reviewer_final_verdict` columns.
- The 0–4 `validation_strength` ladder (and any query that computes it).
- Tick's post-PR-terminal observation logic (`gh pr view` polling after merge, `git log -L` per-finding locus checks, subsequent-review scanning).
- The `>= 2` gate in both the brief enricher and the reviewer-improvement corpus query.

**Door left open.** If a future deployment surfaces measurable corpus pollution that the three first-line controls can't address, revisit this decision with data in hand. The columns are not reserved for future use; they would be added then if the rationale changed. The schema stays clean in the meantime.

#### Reviewer-improvement corpus query (without validation)

```sql
-- Apparent misses for the reviewer-improvement corpus.
-- No validation strength gate — corpus is honest about including borderline cases;
-- downstream consumer applies its own quality judgment if needed.
SELECT
  human.principle AS missed_principle,
  human.captured_at AS flagged_at,
  agent_panel.panelist_name,
  agent_panel.model_name,
  agent_panel.reviewer_preamble_id
FROM review_findings agent
JOIN review_findings human ON ... (the miss join: same repo, same head_sha, agent approved at SHA, human filed CHANGES_REQUESTED at SHA)
LEFT JOIN review_panelists agent_panel ON agent_panel.run_id = agent.run_id
WHERE agent.reviewer_kind = 'agent_quay'
  AND agent.review_verdict = 'approved'
  AND human.reviewer_kind = 'human'
  AND human.principle IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM review_findings agent2
    WHERE agent2.run_id = agent.run_id
      AND agent2.principle = human.principle
  );
```

The corpus is whatever the join returns, full stop. Whoever consumes the corpus (a prompt-tuning workflow, a human-triage dashboard) decides whether to filter further.

#### Per-model and per-focus miss analysis

With panel review, miss detection becomes richer:

- **Per-model** — *"how often does Opus miss things Codex catches?"* Group by `model_name` via the `review_panelists` join.
- **Per-focus** — *"how often does the security-focused panelist miss things later flagged by humans?"* Group by `panelist_name`.
- **Consolidator-drop** — *"did the consolidator drop a finding that *only* the security panelist raised, which a human later flagged?"* Compare raw findings (`panelist_id IS NOT NULL`) against consolidated (`panelist_id IS NULL`) within the same `run_id`, then compare to subsequent human reviews on the same SHA.

All three are SQL queries against the existing schema — no new tables.

#### Reviewer prompt versioning

**v1: deployment-config string.** The reviewer preamble lives in `~/.quay/config.toml` (or equivalent), git-versioned alongside the rest of deployment config. Read at worker spawn time. There's exactly one preamble in v1, so there's no need for a SQL table, no name resolution, no snapshotting — git history is the version log.

**v2 (panel review or reviewer-improvement loop trigger): graduate to SQL table.** When you have ≥ 2 preambles (panel review's per-focus specialization) or want to correlate prompt-version changes with miss rates (reviewer-improvement loop), promote the preamble into a SQL table mirroring `preambles`, with a `name` column for stable reference:

```sql
CREATE TABLE reviewer_preambles (
  reviewer_preamble_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                  -- 'reviewer-default' / 'reviewer-security' / ...
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX reviewer_preambles_by_name_latest
  ON reviewer_preambles(name, created_at DESC);
```

Each reviewer attempt (panelist) records which `reviewer_preamble_id` it ran under (snapshotted at spawn time so subsequent versions don't disturb historical analysis). This makes prompt changes correlatable with miss rates over time — *"after we shipped `reviewer-security` v7, did misses on auth-tagged PRs go down?"*

The same shape applies to `consolidator_preambles` (added in "Multi-model panel review") — name-based lookup, append-only versioning, snapshotted onto `review_runs.consolidator_preamble_id` at run creation.

**Migration cost** when graduating v1 → v2: one `INSERT INTO reviewer_preambles` for the existing config string (snapshot at the migration moment), then change the worker spawn path to read from the table. No backfill of historical attempts needed; analysis windows that span the migration just see "preamble version unknown" before the cutover and named versions after.

### Net effect on Quay

Additive, not invasive:

- One new state (`review_requested`), one new terminal (`reviewed`).
- One new attempt reason (`review_only`); two new worker roles (panelist, consolidator) implemented atop the existing worker substrate, distinguished by which preamble they run.
- Two new CLI commands (`review-pr`, `submit-review-brief`); `review-pr` extends with `--wait` / `--timeout` for blocking-as-CI-gate mode.
- One new outbound HTTP call from Quay (only inside `review-pr`, only when no task matches, gracefully degrades to Option B on failure).
- Three new tables (`review_runs`, `review_panelists`, `consolidator_preambles`) plus `reviewer_preambles` (named, append-only).
- One new artifact kind (`agent_review`); six new columns on `review_findings` — `reviewer_kind`, `review_verdict`, `review_head_sha`, `run_id`, `panelist_id` for attribution, plus `reviewer_login` for "who reviewed what" queries. No derived quality scores; no post-PR-terminal observation logic. See "Why no validation step" above for what was dropped and why.
- SHA-keyed dedup at the **run** level — `UNIQUE(repo_id, pr_number, head_sha)` on `review_runs` — so re-runs on the same head SHA reuse the existing run/verdict; applies to both `--wait` and non-wait modes.
- The §5 reviewer contract becomes enforced by a Quay-controlled preamble (per-panelist, named, versioned) instead of by CI-side configuration.
- One new capacity config key: `max_concurrent_review_runs` (default `15`), independent of `max_concurrent` (which stays for code workers). Reflects the asymmetry that reviewers don't strain hardware (read-only on a shared worktree, no builds/tests) and are bounded by LLM-API quota / budget instead. See "Capacity" above.
- No changes to: worktree handling (one worktree per review run on the synthetic task — N panelists share it, distinguished by tmux session and per-panelist output filenames), supervisor lock (still serializes the consolidated `gh pr review` post and any other supervisor side effect), claim machinery, retry budgets, the existing tick state-handler matrix (just adds two task states to it; run-level sub-states live on `review_runs.status`), the existing artifact store layout.

The narrow spec exception: the Hermes HTTP receiver call inside `review-pr`. Justified as scoped (operator-initiated entry point, synchronous request/response, graceful degradation). Tick stays pure pull-from-external — the load-bearing part of spec §11 survives.

---

## 8. Open questions

- **Tag namespace.** Free-form strings vs. a registered/curated vocabulary. Free-form is faster to start; curated is cleaner long-term. Probably free-form with a periodic "consolidate similar tags" pass.
- **Tag granularity guidance.** What does the Hermes ticket-creation skill actually use as its tag-granularity heuristic? Probably: *"tags should be specific enough that two tasks sharing a tag should plausibly share design considerations."* Worth iterating on with real data.
- **Multi-repo principles.** A principle from repo A — does it ever apply to repo B? V1 ignores the question (`review_findings` has no `scope` column; queries are implicitly per-repo via the task → repo join). When/if cross-repo transfer becomes valuable: either add a `scope TEXT` column to `review_findings` (`'repo'` / `'org'`) populated from a second fenced-block field, or derive scope at query time from the principle text. Both options are additive; defer until there's data demonstrating the need.
- **Reviewer agent prompt.** Out of scope here, but the quality of principles depends entirely on the prompt. Worth treating the reviewer prompt as a versioned artifact (analogous to `preambles` in Quay) so prompt changes are tracked alongside the principles they produce.
- **How the intelligent layer accesses findings (output pipeline shape).** v1 (per `docs/quay-spec-pr-review.md`) deliberately ships only the input pipeline — findings are captured and stored, not injected into anything. When the team eventually wants to close the loop, three plausible shapes are on the table, listed without commitment:
  1. **Per-task LLM pass.** Orchestrator queries Quay for findings by tag, hands them to an LLM along with the new task's draft brief, LLM composes a brief that includes whichever findings it judges relevant. Highest quality, most expensive.
  2. **Per-tag digest, refreshed periodically.** A separate cron runs an LLM pass over all findings tagged `auth-session` and produces a curated digest (stored either in Quay as a `tag_digests` table or as an external Markdown file). Orchestrator includes the matching digests when composing a brief. Cheaper amortized; lossy.
  3. **Hybrid.** Digest as default; per-task LLM pass on top for the highest-stakes tasks.
  4. **Deterministic templated splice.** The earlier draft of these notes (§3.3, before the pragmatism passes) described a deterministic `--enrich-principles` flag that would tag-overlap-query and recency-rank principles into the brief via a fixed template. Still a viable v1.5 if the team wants the loop closed without standing up an intelligent layer first.
  Quay doesn't need to pick — v1 ships the substrate (data + queries); whoever needs the output pipeline builds it as an external consumer in whatever shape they choose. This open question is explicitly captured here so it doesn't get lost in the shift to standalone spec docs.

---

## 9. Shippable v1 cut for the review feature

The brainstorm above describes the full target shape. **v1 ships a strict subset of it: the input pipeline + storage only, no closing of the loop.** The full v1 contract lives in **`docs/quay-spec-pr-review.md`** (a standalone, lockable spec). This section is now a brief overview + a deferred-work catalogue with re-introduction triggers.

> **The v1 contract is in `docs/quay-spec-pr-review.md`.** This section is rationale and the deferred-work index. If the two ever conflict, the spec wins.

### v1 in one paragraph

CI calls `quay review-pr --pr <repo>:<num>`. Quay dispatches between a Quay-task path (matched by `pr_number`) and a synthetic-task path (Option B pull-style fallback for human-authored PRs). A Quay-spawned reviewer worker (single, N=1, deployment-config preamble, read-only worktree) posts a standard GitHub PR review via `gh pr review` and emits `quay-principle` fenced blocks for generalizable rules. Tick observes the review, snapshots the existing `review_comments` artifact, and writes structured rows into a new `review_findings` SQL table. Tasks carry `task_tags` set at enqueue time, so findings are tag-clusterable via JOIN. Two read CLIs (`quay artifact list --kind review_findings --tag <name>` and `quay task review-findings <task_id>`) expose the storage. **That's it.** No brief enrichment, no principle injection into future tasks, no `--enrich-principles` flag, no `tasks.raw_brief`/`brief` split, no `query-principles` CLI, no `task_enrichment_log` table — those all defer.

The closed loop ("review → principle → next task's brief") doesn't function automatically in v1. v1 captures the input; whoever wants to consume the stored data builds it as an external consumer. See the full v1 contract in `docs/quay-spec-pr-review.md`; see the deferred-work catalogue below for what comes later.

### v1 — explicitly deferred (with re-introduction trigger)

Each deferral is a real piece of value held back deliberately. The trigger column states the measurement or signal that promotes the work into the next spec batch.

| Deferred piece | Schema/code impact when added | Trigger |
|---|---|---|
| **Closing the loop / brief enrichment** (`--enrich-principles` flag, the templated splice, `tasks.raw_brief`/`brief` split, `task_enrichment_log` table, `quay query-principles` public CLI) | New flag + transaction step in `enqueue`; new column on `tasks`; new table; new CLI command. v1 `review_findings` rows are valid input verbatim — no backfill. | An external consumer wants to use the stored findings for brief enrichment, **and** the team has chosen the consumer's shape (deterministic templated splice vs. LLM-driven composer vs. per-tag digest vs. hybrid). v1 leaves all four options open; the eventual choice is captured in §8 ("Open question: how the intelligent layer accesses findings"). |
| **Multi-model panel review** | Add `review_panelists`, `consolidator_preambles` tables; `review_runs.status` gains panel sub-states; per-panelist `reviewer_preamble_id` on `review_panelists`. Existing review attempts stay valid (treated as N=1). | Single-reviewer accuracy plateaus, OR the team wants per-focus specialization (security, perf, style). |
| **`review_runs` table itself** | In v1, the synthetic task + a single attempt suffice — the task's `attempts` row is the review run. `review_runs` becomes necessary when there are multiple panelists per PR. Migrate by inserting one row per past review. | Coincides with panel review (same trigger). |
| **`reviewer_preambles` table** (named, append-only versioning, spawn-time snapshotting) | Promote v1's deployment-config string into a SQL table; gain `reviewer_preamble_id` references on attempts/panelists for prompt-version correlation. | Panel review lands (≥ 2 preambles needed) OR reviewer-improvement loop lands (per-version miss-rate analysis). |
| **Reviewer-improvement loop** (`agent_review` artifact kind, `reviewer_kind`, `review_verdict`, `review_head_sha`, `panelist_id`, `reviewer_login` columns, miss-detection query) | Nullable column adds; new artifact kind; tick captures agent-vs-human review divergence; SQL miss-detection query. No validation strength gate — corpus is honest about borderline cases. | Single-reviewer baseline measured for ≥ 4 weeks; missed-finding rate quantifiable. |
| **Blocking mode** (`--wait`, `--timeout`, run-level SHA idempotency, exit codes 0–4) | Two CLI flags; SHA-keyed dedup graduates from `attempts.head_sha` to run-level (`UNIQUE(repo_id, pr_number, head_sha)` on `review_runs`); polling-and-mapping helper. | Team wants merges actually gated AND advisory-mode reviewer calibration is stable enough to enforce. |
| **Hermes RPC fast path** (Option A) | Hermes-side HTTP endpoint; Quay-side outbound call inside `review-pr`; Option A → Option B graceful-degradation logic. | Human-PR review latency (5–10 min in pull-only mode) is repeatedly cited as annoying. |
| **Multi-repo principles** | Add `scope TEXT` column to `review_findings` populated from a second fenced-block field, or per-tag scope rules in deployment config. | At least one cross-repo transfer scenario surfaces in real principle data. |

### What v1 explicitly does *not* lose

A few promises that hold even under the smaller cut:

- **CI-triggered review works end-to-end.** Quay-task PR → review filed on GitHub → findings stored cleanly. Anyone deploying v1 gets the reviewer feature.
- **All v1 data is forward-compatible.** No migration when v2+ lands. Every deferred piece is an additive change to schema and code; v1 `review_findings` rows stay valid forever.
- **The substrate boundary holds.** Quay still doesn't know what Linear is, doesn't reason about prompts, doesn't interpret tags. Findings are stored opaquely.
- **Pull-only invariant survives.** v1 has no Hermes RPC at all (Option B only), so spec §11 is trivially preserved.

### What costs v1 absorbs deliberately

- **Closed loop is open at the use end.** v1 stores findings; it does not inject them into future briefs. The orchestrator builds whatever consumer it wants over the stored data, or chooses to use the data only for human inspection.
- **5–10 min latency on human PRs.** Acceptable for fire-and-forget v1; would be unacceptable as a hard merge gate (which is why blocking mode is also deferred).
- **No reviewer self-improvement signal in v1.** The agent reviewer's miss rate is unobservable until the corpus columns exist. v1 ships the reviewer; v2 measures it.
- **Single-reviewer model risk.** No panel diversity. A bad call from the single reviewer is a bad review on the PR. v1 is fire-and-forget so reviews don't block merges; humans see findings on GitHub and can ignore them.

These are honest trade-offs, not hidden ones. Each maps directly to a deferred piece in the table above.

### Spec graduation status

- ✅ **`docs/quay-spec-ticket-validation.md`** — Draft. Covers §2 of these notes (the `quay validate-ticket` library/CLI). Independent of the review feature.
- ✅ **`docs/quay-spec-pr-review.md`** — Draft. Covers §3.1, §3.2, §5, and the v1 subset of §7 (input pipeline + storage). Independent of the validator.
- ⏳ **Future spec: brief-enrichment / loop-closing.** When the orchestrator team chooses an output-pipeline shape (see deferred table row 1), graduate the chosen approach into its own spec.
- ⏳ **Future spec: multi-model panel review** (deferred table row 2).
- ⏳ **Future spec: reviewer-improvement loop** (deferred table row 5).
- ⏳ **Future spec: blocking mode + Hermes RPC fast path** (deferred table rows 6–7) — likely a single combined spec since both unlock the "CI as a hard merge gate" use case together.

### Slice plans (out of scope here)

When implementation begins, the v1 specs decompose into slice plans (`docs/ralph/slice-XX-*.md`) with named red tests, same shape as slice-10. The slice plans are not part of this notes doc.
