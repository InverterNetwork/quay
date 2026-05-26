import { join } from "node:path";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import type { TickDeps } from "../../src/core/tick.ts";
import { InProcessSupervisorLock } from "../../src/core/supervisor_lock.ts";
import type { Harness } from "./harness.ts";
import { FakeGit } from "./fakes/git.ts";
import { FakeGitHub } from "./fakes/github.ts";
import { FakeLinearAdapter } from "./fakes/linear.ts";
import { FakeSlack } from "./fakes/slack.ts";
import { FakeTmux } from "./fakes/tmux.ts";

export interface BuiltTickDeps {
  deps: TickDeps;
  git: FakeGit;
  github: FakeGitHub;
  tmux: FakeTmux;
  slack: FakeSlack;
  // Every test harness gets a FakeLinearAdapter wired in. Tests that don't
  // exercise Linear writeback simply ignore it; `setIssueState` is a silent
  // no-op for identifiers the test never seeded.
  linear: FakeLinearAdapter;
  reposRoot: string;
  artifactStore: ReturnType<typeof createArtifactStore>;
}

export function buildTickDeps(h: Harness): BuiltTickDeps {
  const reposRoot = join(h.dataDir, "repos");
  const git = new FakeGit(reposRoot);
  const github = new FakeGitHub();
  const tmux = new FakeTmux();
  const slack = new FakeSlack();
  const linear = new FakeLinearAdapter();
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  return {
    deps: {
      db: h.db,
      clock: h.clock,
      git,
      github,
      tmux,
      slack,
      linear,
      artifactStore,
      supervisorLock: new InProcessSupervisorLock(),
    },
    git,
    github,
    tmux,
    slack,
    linear,
    reposRoot,
    artifactStore,
  };
}
