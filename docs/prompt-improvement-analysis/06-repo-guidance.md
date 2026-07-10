# Prompt-improvement analysis — 06: repo-specific guidance drafts

**Date:** 2026-07-10. Threshold split adopted after review: **global preambles keep N≥3**
(a line rides on every attempt everywhere); **repo-routed guidance accepts N≥2** (blast
radius is one repo, guidance is cheap to edit/revert). All items below are same-SHA-verified
misses. Carriers: worker side → the repo's `CLAUDE.md`/`AGENTS.md` (read per preamble item 7);
reviewer side → Quay's per-repo reviewer guidance channel (`## Reviewer guidance` section
composed into the reviewer prompt; see `packages/cli/src/core/preamble.ts`).

## 1. iTRY-monorepo — reviewer guidance body + CLAUDE.md addition

Evidence: pinned-schema breaks (task `pr-review-itry-monorepo-1040` ×5 findings, PRs #1059,
#1048 — n=3); sessionless registration missed in #1113 (lafawnduh1966) and #1048/C#51
(0xNuggan) — n=2, two independent reviewers.

Proposed text (same body works for both carriers):

```markdown
### Stats/APY response contracts are pinned
The `/v1/itry/stats` and APY response shapes are consumed by schemas checked into
consumers: `packages/web-consumer/src/features/dashboard/lib/itry-stats-schema.ts`
(iTRY-frontends) and the monorepo dashboard client (`packages/app/client`). Any change
to field names, nesting, or numeric scale of these responses must be validated against
those schemas and is breaking unless the consumers migrate in the same change. Additive
fields are safe; renames need a legacy alias.

### Public endpoints must be registered sessionless in BOTH entrypoints
A new public, unauthenticated endpoint must be added to `isPublicSessionlessPath` in
both `packages/app/src/lambda-hono.ts` and `packages/app/src/index.ts`. Missing
registration silently adds a DynamoDB session read + touch write per hit and risks
Set-Cookie leaking into shared caches. Copying the `/v1/itry` route template carries
this obligation.
```

## 2. brix-landing — CLAUDE.md/AGENTS.md addition + reviewer guidance

Evidence: PRs #83, #97 (n=2; single reviewer — accepted as an owner-set house rule, not a
generalized taste rule).

```markdown
### Landing metrics must mirror the app
Every metric shown on the landing page (APY variants, wiTRY price, supplies, FX series)
must be read from the same source and derivation the app uses (`/api/v1/itry/stats`
paths, e.g. `?include=series` → `series.stakingApyUsd7d`), not recomputed landing-side
from cached snapshot series. If the app and landing can disagree on a number, the
landing implementation is wrong by definition. When adding a metric, cite the app-side
source path in the PR body.
```

## 3. atlas — CI lever (not prompt text)

Evidence: atlas#37 — the reviewer approved a head where `bun run typecheck` fails; atlas has
only `release.yml`, so nothing enforces typecheck on PRs. `package.json` already has
`"typecheck": "tsc --noEmit"`.

Proposed `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
```

## Shipping notes

- iTRY-monorepo and brix-landing texts go into the target repos via normal PRs (Quay tasks or
  manual); the reviewer-side copies are configured through Quay's repo reviewer guidance.
- These are drafts authored in the quay repo for review; nothing has been applied to the
  target repos.
- Measurement: repo-guidance items are covered by the same gate-6 loop — the two iTRY-monorepo
  rules and the brix-landing rule should stop appearing in human CRs; atlas typecheck breaks
  shift from review findings to red CI.
