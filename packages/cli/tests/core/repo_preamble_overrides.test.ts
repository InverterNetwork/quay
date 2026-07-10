import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import {
  createRepoGuidance,
  ensurePreambleIdForAttemptReason,
} from "../../src/core/preamble.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";
import { insertPreamble, insertTask } from "../support/fixtures.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REPO = {
  repo_id: "repo-preamble",
  repo_url: "git@example.com:owner/repo.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "true",
} as const;

test("repo preamble override wins over global fallback, task override wins over repo", () => {
  h = createHarness();
  const repoPreamble = insertPreamble(h.db, "repo worker preamble", "code");
  const taskPreamble = insertPreamble(h.db, "task worker preamble", "code");
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO, preamble_worker: repoPreamble });
  const taskId = insertTask(h.db, {
    repoId: REPO.repo_id,
    taskId: "task-preamble-precedence",
  });

  expect(
    ensurePreambleIdForAttemptReason(h.db, h.clock, "initial", { taskId }),
  ).toBe(repoPreamble);
  expect(
    ensurePreambleIdForAttemptReason(h.db, h.clock, "initial", {
      taskId,
      overridePreambleId: taskPreamble,
    }),
  ).toBe(taskPreamble);
});

test("repo add/update accepts and clears preamble overrides from CLI flags", async () => {
  h = createHarness();
  const preambleId = insertPreamble(h.db, "worker preamble", "code");
  const built = buildCliDeps(h);

  let io = bufferIO();
  let result = await dispatch(
    [
      "repo",
      "add",
      "--id",
      REPO.repo_id,
      "--url",
      REPO.repo_url,
      "--base-branch",
      REPO.base_branch,
      "--package-manager",
      REPO.package_manager,
      "--install-cmd",
      REPO.install_cmd,
      "--preamble-worker",
      String(preambleId),
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out()).preamble_worker).toBe(preambleId);

  io = bufferIO();
  result = await dispatch(
    ["repo", "update", REPO.repo_id, "--preamble-worker", ""],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out()).preamble_worker).toBeNull();
});

test("enqueue stores repo-selected worker preamble id on the attempt and prompt", () => {
  h = createHarness();
  const preambleId = insertPreamble(h.db, "Repo-specific worker preamble", "code");
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO, preamble_worker: preambleId });

  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(REPO.repo_id);
  h.ids.push("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "BRIX-1479",
    brief: "Do the thing",
  });

  const attempt = h.db
    .query<{ preamble_id: number }, [number]>(
      `SELECT preamble_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(result.attempt_id);
  expect(attempt?.preamble_id).toBe(preambleId);

  const finalPrompt = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(result.attempt_id);
  expect(finalPrompt).not.toBeNull();
  expect(
    readFileSync(finalPrompt!.file_path, "utf8").startsWith(
      "Repo-specific worker preamble\n\n",
    ),
  ).toBe(true);
});

test("enqueue composes additive repo worker guidance and records provenance", () => {
  h = createHarness();
  const preambleId = insertPreamble(h.db, "Global worker preamble", "code");
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO, preamble_worker: preambleId });
  const guidance = createRepoGuidance(h.db, h.clock, {
    repoId: REPO.repo_id,
    role: "worker",
    body: "Use the pinned schema for this repo.",
  });

  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(REPO.repo_id);
  h.ids.push("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "BRIX-1887",
    brief: "Do the thing",
  });

  const attempt = h.db
    .query<{ preamble_id: number; repo_guidance_id: number | null }, [number]>(
      `SELECT preamble_id, repo_guidance_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(result.attempt_id);
  expect(attempt).toEqual({
    preamble_id: preambleId,
    repo_guidance_id: guidance.guidance_id,
  });

  const finalPrompt = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(result.attempt_id);
  const body = readFileSync(finalPrompt!.file_path, "utf8");
  expect(body).toContain("Global worker preamble");
  expect(body).toContain("## Repo-specific guidance (repo-preamble)");
  expect(body).toContain("Use the pinned schema for this repo.");
});

test("repo guidance CLI appends and reads latest guidance", async () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add(REPO);
  const built = buildCliDeps(h);

  let io = bufferIO();
  let result = await dispatch(
    [
      "repo",
      "guidance-set",
      REPO.repo_id,
      "--role",
      "reviewer",
      "--body",
      "Reviewer appendix",
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toMatchObject({
    repo_id: REPO.repo_id,
    role: "reviewer",
    body: "Reviewer appendix",
  });

  io = bufferIO();
  result = await dispatch(
    ["repo", "guidance-get", REPO.repo_id, "--role", "reviewer"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toMatchObject({
    repo_id: REPO.repo_id,
    role: "reviewer",
    body: "Reviewer appendix",
  });
});

test("repo preamble overrides must reference the matching preamble kind", () => {
  h = createHarness();
  const reviewPreamble = insertPreamble(h.db, "reviewer preamble", "review");
  const repos = createRepoService({ db: h.db, clock: h.clock });

  expect(() => repos.add({ ...REPO, preamble_worker: reviewPreamble }))
    .toThrow(/expected code/);
});

test("repo reviewer preamble overrides reject direct-post guidance", () => {
  h = createHarness();
  const staleReviewPreamble = insertPreamble(
    h.db,
    "Post the review directly to GitHub via `gh pr review`.",
    "review",
  );
  const repos = createRepoService({ db: h.db, clock: h.clock });

  expect(() => repos.add({ ...REPO, preamble_reviewer: staleReviewPreamble }))
    .toThrow(/conflict with the static reviewer protocol/);
});
