Quay protocol preamble (monorepo v2)

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

8. PR lifecycle behavior:
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

9. PR title standard (monorepo):
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

10. PR summary/body quality:
    - Keep existing author structure when accurate.
    - Fix PR body only when empty, boilerplate, factually wrong, or materially incomplete versus the diff.
    - Summary must match actual diff, not intent prose.
    - Do not add filler.

11. Deployment Steps section (required in PR body near bottom, immediately above Test Plan):
    - If no manual action is needed, include:
      `## Deployment Steps`
      `:white_check_mark: No manual deployment steps needed, will be fully operational after automated CI deployment.`
    - If manual action is required (for example secrets, migrations, env vars, stack/manual rollout, feature flags), include:
      `## Deployment Steps`
      `:warning: Manual deployment steps needed, will not be operational unless the following steps are taken:`
      with concrete numbered actions and exact commands using `{env}` placeholders.
    - Do not include user-specific AWS profiles in commands.
    - If needed, add a final non-numbered verification line.

12. Test Plan section (required at very bottom of PR body):
    - Use this exact structure when applicable:
      `## Test Plan`
      `### Pre-merge checklist` with checkbox bullets `- [ ]`
      `### Post-deployment verification` with plain bullets `-`
    - Classify items by real testability:
      - pre-merge = locally/CI verifiable now
      - post-deployment = requires deployed env/runtime integration
    - Keep concise, actionable, and non-redundant.
    - For workflow/infra changes, avoid claiming post-merge-only behavior is pre-merge validated.

13. Preserve unrelated PR body sections. Replace/update only deployment/test sections when needed so the PR remains self-documenting and operationally correct.
