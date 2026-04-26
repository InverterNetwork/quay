# Quay

Bun + TypeScript implementation of the Quay task lifecycle service.

- Behavior contract: [`docs/quay-spec.md`](docs/quay-spec.md)
- Build order: [`docs/quay-tdd-implementation-plan.md`](docs/quay-tdd-implementation-plan.md)

## Quick start

```bash
bun install
bun test         # red until Slice 0 lands
bun run typecheck
```

## Layout

```
migrations/       SQL migration files (read at runtime)
src/
  cli/            commander entry points; thin wrapper over core
  core/           service API: enqueue, tick_once, claim_task, ...
  db/             sqlite connection + migration runner
  artifacts/      artifact-store helper
  ports/          TmuxPort, GitPort, GitHubPort, SlackPort, Clock, ...
tests/
  support/        harness, fakes, failpoints (test-only)
  schema/         migration + constraint tests
  enqueue/        enqueue + bootstrap behavior
  tick/           promotion, classifier, retries
  claim/          claim fencing, submit-brief, escalate-human
  cancel/         cancel finalizer + recovery
  slack/          waiting_human tick handler
  pr/             pr-open / done polling
  cli/            CLI smoke tests
```

Tests are organized by domain, not by slice; the slice number is encoded
in the test name (e.g. `test_055_enqueue_fresh_repo_bootstraps_and_queues_task`).
