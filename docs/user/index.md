# Quay User Documentation

This directory is the user-facing documentation for Quay.

It is written from the current implementation and tests, not from the older
design specs. The specs in `docs/quay-spec*.md` are useful design history, but
they have not been maintained all the way. If a spec and these docs disagree,
verify against the CLI implementation and tests, then fix the docs.

## Start Here

- [Quickstart](quickstart.md): build Quay, register a repo, enqueue a task, and
  run a demo tick loop.
- [Concepts](concepts.md): the core terms behind the task lifecycle.
- [Installation](installation.md): build and install the binary.
- [Configuration](configuration.md): `config.toml`, data directories, defaults,
  and adapter settings.
- [External Services Setup](external-services.md): GitHub, Slack, Linear,
  worker credentials, and scheduler environment setup.
- [Repositories](repositories.md): register repos and materialize bare clones.
- [Enqueueing Tasks](enqueueing-tasks.md): manual briefs and Linear-backed
  enqueue.
- [Running Quay](running-quay.md): `quay tick`, lifecycle states, retries, and
  cancellation.
- [Monitoring And Artifacts](monitoring-and-artifacts.md): task JSON, events,
  and artifact retrieval.
- [Linear And Slack](linear-and-slack.md): adapter setup and behavior.
- [Parent-Owned Umbrella QA Matrix](qa-parent-owned-umbrella.md): deployed
  Linear and test-repo validation scenarios for dependency and umbrella flows.
- [Ticket Authoring](ticket-authoring.md): the `quay-config` block and ticket
  validation.
- [Troubleshooting](troubleshooting.md): common errors and recovery paths.
- [CLI Reference](cli-reference.md): command inventory and output conventions.

## Audience

These docs are for:

- Operators installing and running Quay on a single host.
- Orchestrator authors integrating with Quay through the CLI.
- Engineers debugging task state, artifacts, repo registration, and adapter
  behavior.

They are not a replacement for the internal design notes. Use the specs when
you need architectural context, but use these docs when you need to run the
tool.
