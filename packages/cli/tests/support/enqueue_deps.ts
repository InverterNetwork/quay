import { join } from "node:path";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import type { EnqueueDeps } from "../../src/core/enqueue.ts";
import type { Harness } from "./harness.ts";
import { FakeCommandRunner } from "./fakes/command_runner.ts";
import { FakeGit } from "./fakes/git.ts";

export interface BuiltEnqueueDeps {
  deps: EnqueueDeps;
  git: FakeGit;
  commandRunner: FakeCommandRunner;
  reposRoot: string;
  worktreesRoot: string;
}

export function buildEnqueueDeps(h: Harness): BuiltEnqueueDeps {
  const reposRoot = join(h.dataDir, "repos");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const git = new FakeGit(reposRoot);
  const commandRunner = new FakeCommandRunner();
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  return {
    deps: {
      db: h.db,
      clock: h.clock,
      ids: h.ids,
      git,
      commandRunner,
      artifactStore,
      paths: { reposRoot, worktreesRoot, artifactsRoot: h.artifactRoot },
    },
    git,
    commandRunner,
    reposRoot,
    worktreesRoot,
  };
}
