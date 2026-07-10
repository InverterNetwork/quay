Quay protocol preamble (monorepo v3)

1. If you cannot make progress, write `.quay-blocked.md` containing a concise explanation of what happened, what you tried, and what is needed next. Then exit cleanly.

2. Exit when one of these is true:
   (a) you have pushed your branch and opened/updated a PR,
   (b) you have written a blocker file, or
   (c) you have decided the task cannot be completed safely.
   Do not loop indefinitely. Do not sleep waiting for input.

3. Work only inside the assigned worktree. `.quay-*` files are reserved.
   You may:
   - read `.quay-prompt.md`
   - write `.quay-blocked.md`
   - write `.quay-goal-report.json` only when goal mode explicitly asks for it
   Do not modify other `.quay-*` files.

4. Dependencies are already installed by Quay. Do not re-run install commands unless the task explicitly requires dependency changes and you are validating those changes.

5. Do not use tools that require interactive input.

6. If you would normally ask a clarifying question, write the question into `.quay-blocked.md` and exit. Do not guess on ambiguous, security-sensitive, or release-sensitive behavior.

7. Follow repo contribution and architecture docs when present, especially monorepo conventions around package boundaries, ownership, and CI expectations.

8. Engineering quality bar (applies to everything you write; reviews most often reject work for violating these):
   - Fix the class, not the instance. When you change behavior — especially when addressing review feedback — sweep for every parallel site with the same concern (sibling components, both entrypoints, every route/handler) and fix them all. Copying an existing template/pattern carries all of its obligations, not just the visible ones.
   - State + external side effects (payments, proposals, notifications, infra): assume a crash between any two steps and retries of every step. Make handlers idempotent; never record success before the external system has durably accepted the operation; cover cancel/retry/concurrent interleavings in tests.
   - Failures must surface. Do not swallow errors; a failed side effect must not report success; errors that halt a business flow must reach the configured alerting path; UI must not show success when the underlying operation failed.
   - Wire it end-to-end. A feature exists only when it runs in the deployed shape: routes registered, env vars and config plumbed through IaC into the runtime, referenced APIs/fields actually exist, handlers scheduled/deployed. Removing infra code does not remove already-deployed infrastructure — include explicit teardown or migration steps.
   - Contracts and consumers. Before changing a shared function, response shape, or event, enumerate its consumers (pinned schemas, sibling apps, legacy params) and keep them working; alias or migrate rather than silently break. A unit/scale change is a breaking change.
   - Boundaries and units. Handle null-vs-unset, empty/zero, and range edges deliberately; do not let defaults move under stored data; never pass big integers through floating point; never hardcode token/currency decimals — resolve them.
   - Tests must be able to fail. Assert the failure direction too; an env-guarded test that passes vacuously, or scaffolding that never runs, is worse than no test. Never relax repo-wide lint/test rules to make a feature pass.
   - Security hygiene. Secrets and PII must not reach logs, error details, process arguments, prompts, or synthesized templates — route new logging through the repo's existing redaction layer. Validate untrusted input at every new surface; new endpoints get the same auth/session treatment as their siblings.
   - Docs are part of the change. Update every document the change invalidates (README, CLAUDE.md/AGENTS.md, runbooks, specs, docs indexes); do not describe shipped behavior as future work.
   - Ship no dead code: no unused exports, dead branches, duplicate implementations, or leftover scaffolding. When you replace a path, delete the old one.

9. PR lifecycle behavior:
   - Push the branch when done.
   - Check whether a PR already exists for the branch (for example, `gh pr list --head <branch>`).
   - If no PR exists, open one with `gh pr create` against the configured base branch.
   - If a PR exists, do not open a duplicate.
   - You may update an existing PR title/body when needed to reflect the actual scope and verification state.
   - PR title must start with a conventional-commit prefix:
     - `feat:` for new user-visible behavior
     - `fix:` for repaired broken/incorrect behavior
     - `chore:` for refactors/docs/build/CI/dependency/maintenance work
     When unsure between `feat` and `chore`, choose `chore`.
   - Put ticket reference in the PR body or rely on branch naming; do not lead title with ticket id.

10. PR title standard (monorepo):
   - Regular PRs: `type(scope): description (BRIX-XXXX)` when a ticket is recoverable.
     - allowed type: `feat`, `fix`, `chore`, `refactor`, `docs`, `hotfix`
     - preferred scopes: `app`, `app/client`, `serverless`, `infra`, `ci`, `core`, `frontends`, `changelog`
     - description should be concise, imperative, lowercase.
   - Rewrite legacy ticket identifiers `ITRY-<n>` to `BRIX-<n>` in PR title/body text only.
     Do not rewrite branch names or commit history.
   - Release PRs use:
     - `Release: dev → staging (YYYY-MM-DD)` or
     - `Release: staging → main (vX.Y.Z)`
   - Didier changelog sync PR title is exactly:
     - `docs(changelog): sync dev changelog`
   - Submodule sync PRs:
     - `chore(frontends): sync submodule (PRs #XX, #YY)`

11. PR summary/body quality:
    - Keep existing author structure when accurate.
    - Fix PR body only when empty, boilerplate, factually wrong, or materially incomplete versus the diff.
    - Summary must match actual diff, not intent prose.
    - Do not add filler.

12. Deployment Steps section (required in PR body near bottom, immediately above Test Plan):
    - If no manual action is needed, include:
      `## Deployment Steps`
      `:white_check_mark: No manual deployment steps needed, will be fully operational after automated CI deployment.`
    - If manual action is required (for example secrets, migrations, env vars, stack/manual rollout, feature flags), include:
      `## Deployment Steps`
      `:warning: Manual deployment steps needed, will not be operational unless the following steps are taken:`
      with concrete numbered actions and exact commands using `{env}` placeholders.
    - Do not include user-specific AWS profiles in commands.
    - If needed, add a final non-numbered verification line.

13. Test Plan section (required at very bottom of PR body):
    - Use this exact structure when applicable:
      `## Test Plan`
      `### Pre-merge checklist` with checkbox bullets `- [ ]`
      `### Post-deployment verification` with plain bullets `-`
    - Classify items by real testability:
      - pre-merge = locally/CI verifiable now
      - post-deployment = requires deployed env/runtime integration
    - Keep concise, actionable, and non-redundant.
    - For workflow/infra changes, avoid claiming post-merge-only behavior is pre-merge validated.

14. Preserve unrelated PR body sections. Replace/update only deployment/test sections when needed so the PR remains self-documenting and operationally correct.
