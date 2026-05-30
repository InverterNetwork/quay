// Slice 16 — `quay enqueue --linear-issue` end-to-end. Adapters spec §3
// (atomicity), §8 (CLI behavior), §11 (validator integration), §12
// (failure modes), §13 (worked example).
//
// Tests below match the slice-16 expected_tests gate names verbatim.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { SpawnedValidatorRunner } from "../../src/core/validator_runner.ts";
import type { LinearBlockedByRelation } from "../../src/ports/linear.ts";
import type { LinearIssue } from "../../src/ports/linear.ts";
import type { SlackThreadMessage } from "../../src/ports/slack.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
const scratchDirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  h = null;
  for (const d of scratchDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "quay-enq-li-"));
  scratchDirs.push(d);
  return d;
}

function writeTemp(contents: string, name = "f.md"): string {
  const dir = tempDir();
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

const FENCE = "```";
const REPO_ID = "repo-li";
const SLACK_URL = "https://inverter.slack.com/archives/C0123ABC/p1700000123000001";
const SLACK_THREAD_REF = "C0123ABC:1700000123.000001";

interface BlockOpts {
  repo?: string;
  base_branch?: string | null;
  tags?: string[];
  slack_thread?: string | null;
  authors?: { name: string; slack_id: string }[];
  umbrella?: {
    external_ref: string;
    base_branch?: string;
    feature_branch?: string;
    depends_on?: string[];
  };
}

function quayConfigBlock(opts: BlockOpts = {}): string {
  const repo = opts.repo ?? REPO_ID;
  const tags = opts.tags ?? ["auth-session", "cache"];
  const authors = opts.authors ?? [
    { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
    { name: "Marvin Gross", slack_id: "U07ABCDEFGH" },
  ];
  const lines: string[] = [`${FENCE}quay-config`, `repo: ${repo}`, "tags:"];
  if (opts.base_branch !== null && opts.base_branch !== undefined) {
    lines.splice(2, 0, `base_branch: ${opts.base_branch}`);
  }
  for (const t of tags) lines.push(`  - ${t}`);
  if (opts.slack_thread !== null && opts.slack_thread !== undefined) {
    lines.push(`slack_thread: ${opts.slack_thread}`);
  }
  lines.push("authors:");
  for (const a of authors) {
    lines.push(`  - name: ${a.name}`);
    lines.push(`    slack_id: ${a.slack_id}`);
  }
  if (opts.umbrella !== undefined) {
    lines.push("umbrella:");
    lines.push(`  external_ref: ${opts.umbrella.external_ref}`);
    if (opts.umbrella.base_branch !== undefined) {
      lines.push(`  base_branch: ${opts.umbrella.base_branch}`);
    }
    if (opts.umbrella.feature_branch !== undefined) {
      lines.push(`  feature_branch: ${opts.umbrella.feature_branch}`);
    }
    if (opts.umbrella.depends_on !== undefined) {
      lines.push("  depends_on:");
      for (const dep of opts.umbrella.depends_on) lines.push(`    - ${dep}`);
    }
  }
  lines.push(FENCE);
  return lines.join("\n");
}

// Linear ticket bodies must be long enough to satisfy the validator's
// shipped-default `body.min_length = 10`. Default body comfortably exceeds it.
function makeIssue(opts: { identifier?: string; block?: BlockOpts; body?: string } = {}): LinearIssue {
  const identifier = opts.identifier ?? "ENG-1276";
  const blockText = quayConfigBlock(opts.block ?? {});
  const body =
    opts.body ??
    `## Context\n\nWe're seeing stale auth sessions when multiple devices invalidate the cache concurrently. Need to nail down the invalidation propagation timing.\n\n${blockText}\n`;
  return {
    identifier,
    url: `https://linear.app/inverter/issue/${identifier}`,
    title: "Cache invalidation under concurrent updates",
    body,
    comments: [],
  };
}

function configureSlackThread(slackFake: ReturnType<typeof buildCliDeps>["slack"]): void {
  const parent: SlackThreadMessage = {
    ts: "1700000123.000001",
    authorBot: false,
    authorName: "Fabian Scherer",
    text: "Original ask: cache invalidation timing under concurrent writes?",
  };
  const replies: SlackThreadMessage[] = [
    {
      ts: "1700000200.000001",
      authorBot: false,
      authorName: "Marvin Gross",
      text: "Read replicas same-tick or eventual?",
    },
  ];
  slackFake.configureThreadContext(SLACK_THREAD_REF, parent, replies);
}

async function addRepo(built: ReturnType<typeof buildCliDeps>): Promise<void> {
  const r = await dispatch(
    [
      "repo",
      "add",
      "--id",
      REPO_ID,
      "--url",
      "git@example.com:owner/r.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  expect(r.exitCode).toBe(0);
  // Quay is a pure consumer of bare clones; the operator (or, here, the
  // test) must materialize the clone before enqueuing.
  built.git.seedBareClone(REPO_ID);
}

function insertTrackedTask(
  state: string,
  externalRef: string,
  repoId = REPO_ID,
): string {
  if (h === null) throw new Error("harness not initialized");
  const taskId = `task-${externalRef.toLowerCase()}`;
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, external_ref, state, branch_name, tmux_id, worktree_path,
         retry_budget, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 5, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      externalRef,
      state,
      `quay/${externalRef.toLowerCase()}`,
      `quay-task-${externalRef.toLowerCase()}`,
      `/tmp/${taskId}`,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  return taskId;
}

function insertUmbrellaWorkflow(
  externalRef: string,
  opts: { baseBranch?: string; featureBranch?: string } = {},
): number {
  if (h === null) throw new Error("harness not initialized");
  const now = h.clock.nowISO();
  const row = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      externalRef,
      REPO_ID,
      opts.baseBranch ?? "dev",
      opts.featureBranch ?? `quay/umbrella/${externalRef}`,
      now,
      now,
    );
  if (!row) throw new Error("failed to insert umbrella workflow");
  return row.umbrella_workflow_id;
}

function insertExpectedUmbrellaTask(
  umbrellaWorkflowId: number,
  externalRef: string,
  title: string,
): void {
  if (h === null) throw new Error("harness not initialized");
  const now = h.clock.nowISO();
  h.db
    .query(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, title, linear_issue_url,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      umbrellaWorkflowId,
      externalRef,
      title,
      `https://linear.app/inverter/issue/${externalRef}`,
      now,
      now,
    );
}

function blockedByRelation(
  identifier: string,
  stateType: string | null,
  opts: { repo?: string; relationId?: string } = {},
): LinearBlockedByRelation {
  return {
    relationId: opts.relationId ?? `rel-${identifier}`,
    blocker: {
      identifier,
      url: `https://linear.app/inverter/issue/${identifier}`,
      title: `Blocker ${identifier}`,
      body: `Blocker context\n\n${quayConfigBlock({
        repo: opts.repo ?? REPO_ID,
        tags: ["dependency"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      })}`,
      stateType,
    },
  };
}

// ---------------------------------------------------------------------------

test("test_enqueue_linear_issue_end_to_end", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      identifier: "ENG-1276",
      block: {
        tags: ["auth-session", "cache"],
        slack_thread: SLACK_URL,
        authors: [
          { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
          { name: "Marvin Gross", slack_id: "U07ABCDEFGH" },
        ],
      },
    }),
  );
  configureSlackThread(built.slack);

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqResult = JSON.parse(io.out().trim());
  expect(typeof enqResult.task_id).toBe("string");
  expect(enqResult.state).toBe("queued");
  expect(typeof enqResult.attempt_id).toBe("number");
  expect(typeof enqResult.branch_name).toBe("string");
  expect(typeof enqResult.tmux_id).toBe("string");
  expect(typeof enqResult.worktree_path).toBe("string");

  // Adapters were exercised.
  expect(built.linear.getIssueCalls).toContain("ENG-1276");
  expect(built.slack.fetchThreadContextCalls).toContain(SLACK_THREAD_REF);
  expect(built.validatorRunner.runCalls).toHaveLength(1);

  // Task row carries the adapter-derived fields.
  const taskRow = h.db
    .query<
      { external_ref: string | null; slack_thread_ref: string | null; authors_json: string | null },
      [string]
    >(
      `SELECT external_ref, slack_thread_ref, authors_json FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(taskRow?.external_ref).toBe("ENG-1276");
  expect(taskRow?.slack_thread_ref).toBe(SLACK_THREAD_REF);
  expect(taskRow?.authors_json).not.toBeNull();
  const authors = JSON.parse(taskRow!.authors_json!);
  expect(authors).toEqual([
    { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
    { name: "Marvin Gross", slack_id: "U07ABCDEFGH" },
  ]);

  // Two task_tags rows, one per block tag.
  const tags = h.db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag`,
    )
    .all(enqResult.task_id);
  expect(tags.map((r) => r.tag)).toEqual(["auth-session", "cache"]);
});

test("complete Linear blocker is snapshotted but does not create dependency row", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(makeIssue({ identifier: "ENG-2000" }));
  built.linear.setBlockedByRelations("ENG-2000", [
    blockedByRelation("ENG-1999", "completed"),
  ]);

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2000"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult.state).toBe("queued");
  const deps = h.db
    .query(`SELECT dependency_id FROM task_dependencies WHERE dependent_task_id = ?`)
    .all(enqResult.task_id);
  expect(deps).toHaveLength(0);
  const snapshot = h.db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND kind = 'ticket_snapshot'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(enqResult.task_id);
  const parsed = JSON.parse(readFileSync(snapshot!.file_path, "utf8"));
  expect(parsed.linear_blocked_by_relations[0]).toMatchObject({
    blocker_identifier: "ENG-1999",
    complete_in_linear: true,
    persisted: false,
  });
  expect(parsed.linear_hierarchy).toEqual({ parent: null, children: [] });
});

test("incomplete tracked Linear blocker creates dependency and waits", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);
  const blockerTaskId = insertTrackedTask("pr-open", "ENG-2100");

  built.linear.setIssue(makeIssue({ identifier: "ENG-2101" }));
  built.linear.setBlockedByRelations("ENG-2101", [
    blockedByRelation("ENG-2100", "started"),
  ]);

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2101"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult.state).toBe("waiting_dependencies");
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(enqResult.task_id);
  expect(task?.state).toBe("waiting_dependencies");
  const dep = h.db
    .query<
      {
        dependency_task_id: string;
        dependency_external_ref: string;
        dependency_repo_id: string;
        satisfied_at: string | null;
      },
      [string]
    >(
      `SELECT dependency_task_id, dependency_external_ref, dependency_repo_id, satisfied_at
         FROM task_dependencies WHERE dependent_task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(dep).toEqual({
    dependency_task_id: blockerTaskId,
    dependency_external_ref: "ENG-2100",
    dependency_repo_id: REPO_ID,
    satisfied_at: null,
  });
  const outbox = h.db
    .query<
      { kind: string; handler_class: string; payload_json: string | null; route_hint_json: string | null },
      [string]
    >(
      `SELECT kind, handler_class, payload_json, route_hint_json
         FROM outbox_items
        WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(outbox?.kind).toBe("delivery.dependency_waiting");
  expect(outbox?.handler_class).toBe("delivery");
  expect(JSON.parse(outbox!.payload_json!)).toMatchObject({
    dependency_count: 1,
    dependencies: [{ dependency_task_id: blockerTaskId }],
  });
  expect(JSON.parse(outbox!.route_hint_json!)).toEqual({ attention: "normal" });
});

test("umbrella Linear issue retargets subtask and creates umbrella dependency", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);
  const blockerTaskId = insertTrackedTask("pr-open", "ENG-2199");

  built.linear.setIssue(
    makeIssue({
      identifier: "ENG-2200",
      block: {
        umbrella: {
          external_ref: "BRIX-1509",
          base_branch: "dev",
          feature_branch: "feature/brix-1509",
          depends_on: ["ENG-2199"],
        },
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2200"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult.state).toBe("waiting_dependencies");

  const task = h.db
    .query<{ base_branch: string }, [string]>(
      `SELECT base_branch FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(task?.base_branch).toBe("feature/brix-1509");

  const workflow = h.db
    .query<
      { external_ref: string; base_branch: string; feature_branch: string },
      []
    >(
      `SELECT external_ref, base_branch, feature_branch
         FROM umbrella_workflows`,
    )
    .get();
  expect(workflow).toEqual({
    external_ref: "BRIX-1509",
    base_branch: "dev",
    feature_branch: "feature/brix-1509",
  });

  const dep = h.db
    .query<
      {
        dependency_task_id: string | null;
        dependency_external_ref: string | null;
        scope: string;
        required_state: string;
        satisfied_at: string | null;
      },
      [string]
    >(
      `SELECT dependency_task_id, dependency_external_ref, scope,
              required_state, satisfied_at
         FROM task_dependencies
        WHERE dependent_task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(dep).toEqual({
    dependency_task_id: blockerTaskId,
    dependency_external_ref: "ENG-2199",
    scope: "umbrella",
    required_state: "merged_to_feature_branch",
    satisfied_at: null,
  });
});

test("Linear parent enqueue creates idempotent umbrella workflow and expected children", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      identifier: "ENG-2300",
      block: {
        base_branch: "dev",
        tags: ["umbrella"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );
  built.linear.setIssueHierarchy("ENG-2300", {
    parent: null,
    children: [
      {
        identifier: "ENG-2302",
        url: "https://linear.app/inverter/issue/ENG-2302",
        title: "Already done child",
        stateType: "completed",
      },
      {
        identifier: "eng-2301",
        url: "https://linear.app/inverter/issue/ENG-2301",
        title: "Build child",
        stateType: "started",
      },
    ],
  });

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2300"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult).toMatchObject({
    external_ref: "ENG-2300",
    repo_id: REPO_ID,
    base_branch: "dev",
    feature_branch: "quay/umbrella/ENG-2300",
  });
  expect(enqResult.linear_hierarchy.children).toEqual([
    {
      identifier: "ENG-2302",
      url: "https://linear.app/inverter/issue/ENG-2302",
      title: "Already done child",
      state_type: "completed",
      complete_in_linear: true,
    },
    {
      identifier: "ENG-2301",
      url: "https://linear.app/inverter/issue/ENG-2301",
      title: "Build child",
      state_type: "started",
      complete_in_linear: false,
    },
  ]);
  expect(
    built.git.calls.find((c) => c.op === "ensureRemoteBranchFromBase")?.args,
  ).toEqual({
    repoId: REPO_ID,
    branch: "quay/umbrella/ENG-2300",
    baseBranch: "dev",
  });
  expect(built.git.countCalls("worktreeAdd")).toBe(0);

  const workflow = h.db
    .query<
      {
        umbrella_workflow_id: number;
        external_ref: string;
        base_branch: string;
        feature_branch: string;
      },
      []
    >(
      `SELECT umbrella_workflow_id, external_ref, base_branch, feature_branch
         FROM umbrella_workflows`,
    )
    .get();
  expect(workflow).toMatchObject({
    external_ref: "ENG-2300",
    base_branch: "dev",
    feature_branch: "quay/umbrella/ENG-2300",
  });

  const expected = h.db
    .query<
      {
        external_ref: string;
        title: string | null;
        linear_issue_url: string | null;
        state: string;
        completion_source: string | null;
      },
      [number]
    >(
      `SELECT external_ref, title, linear_issue_url, state, completion_source
         FROM umbrella_expected_tasks
        WHERE umbrella_workflow_id = ?
        ORDER BY external_ref`,
    )
    .all(workflow!.umbrella_workflow_id);
  expect(expected).toEqual([
    {
      external_ref: "ENG-2301",
      title: "Build child",
      linear_issue_url: "https://linear.app/inverter/issue/ENG-2301",
      state: "expected",
      completion_source: null,
    },
    {
      external_ref: "ENG-2302",
      title: "Already done child",
      linear_issue_url: "https://linear.app/inverter/issue/ENG-2302",
      state: "complete_without_quay",
      completion_source: "linear",
    },
  ]);
  const taskCount = h.db
    .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM tasks`)
    .get();
  expect(taskCount?.count).toBe(0);

  const ioAgain = bufferIO();
  const second = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2300"],
    built.deps,
    ioAgain,
  );
  expect(second.exitCode).toBe(0);
  const secondResult = JSON.parse(ioAgain.out().trim());
  expect(secondResult.umbrella_workflow_id).toBe(
    workflow!.umbrella_workflow_id,
  );
  const expectedCount = h.db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM umbrella_expected_tasks`,
    )
    .get();
  expect(expectedCount?.count).toBe(2);
});

test("Linear child enqueue resolves parent umbrella workflow and links expected task", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);
  const workflowId = insertUmbrellaWorkflow("ENG-2400", {
    baseBranch: "dev",
    featureBranch: "quay/umbrella/ENG-2400",
  });
  insertExpectedUmbrellaTask(workflowId, "ENG-2401", "Build subtask");

  built.linear.setIssue(
    makeIssue({
      identifier: "ENG-2401",
      block: {
        tags: ["umbrella"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );
  built.linear.setIssueHierarchy("ENG-2401", {
    parent: {
      identifier: "ENG-2400",
      url: "https://linear.app/inverter/issue/ENG-2400",
      title: "Umbrella parent",
      stateType: "started",
    },
    children: [],
  });

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2401"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult.state).toBe("queued");

  const task = h.db
    .query<{ base_branch: string; external_ref: string | null }, [string]>(
      `SELECT base_branch, external_ref FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(task).toEqual({
    base_branch: "quay/umbrella/ENG-2400",
    external_ref: "ENG-2401",
  });
  expect(
    built.git.calls.find((c) => c.op === "ensureRemoteBranchFromBase")?.args,
  ).toEqual({
    repoId: REPO_ID,
    branch: "quay/umbrella/ENG-2400",
    baseBranch: "dev",
  });
  expect(built.git.calls.find((c) => c.op === "worktreeAdd")?.args).toMatchObject({
    branch: "quay/ENG-2401",
    baseRef: "origin/quay/umbrella/ENG-2400",
  });

  const umbrellaTask = h.db
    .query<
      { umbrella_workflow_id: number; task_id: string; external_ref: string },
      [string]
    >(
      `SELECT umbrella_workflow_id, task_id, external_ref
         FROM umbrella_tasks
        WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(umbrellaTask).toEqual({
    umbrella_workflow_id: workflowId,
    task_id: enqResult.task_id,
    external_ref: "ENG-2401",
  });
  const expected = h.db
    .query<{ state: string }, [number, string]>(
      `SELECT state
         FROM umbrella_expected_tasks
        WHERE umbrella_workflow_id = ? AND external_ref = ?`,
    )
    .get(workflowId, "ENG-2401");
  expect(expected?.state).toBe("linked");

  const snapshot = h.db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND kind = 'ticket_snapshot'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(enqResult.task_id);
  const parsed = JSON.parse(readFileSync(snapshot!.file_path, "utf8"));
  expect(parsed.linear_hierarchy.parent).toMatchObject({
    identifier: "ENG-2400",
    title: "Umbrella parent",
  });
});

test("Linear child enqueue fails before substrate when parent umbrella is missing", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(makeIssue({ identifier: "ENG-2411" }));
  built.linear.setIssueHierarchy("ENG-2411", {
    parent: {
      identifier: "ENG-2410",
      url: "https://linear.app/inverter/issue/ENG-2410",
      title: "Missing umbrella parent",
      stateType: "started",
    },
    children: [],
  });

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2411"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("umbrella_not_enqueued");
  expect(built.git.countCalls("worktreeAdd")).toBe(0);
  expect(built.git.countCalls("ensureRemoteBranchFromBase")).toBe(0);
  const counts = h.db
    .query<{ tasks: number; artifacts: number }, []>(
      `SELECT
         (SELECT COUNT(*) FROM tasks) AS tasks,
         (SELECT COUNT(*) FROM artifacts) AS artifacts`,
    )
    .get();
  expect(counts).toEqual({ tasks: 0, artifacts: 0 });
});

test("Linear child enqueue fails before substrate when child is not expected", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);
  const workflowId = insertUmbrellaWorkflow("ENG-2420", {
    baseBranch: "dev",
    featureBranch: "quay/umbrella/ENG-2420",
  });
  insertExpectedUmbrellaTask(workflowId, "ENG-2422", "Different subtask");

  built.linear.setIssue(makeIssue({ identifier: "ENG-2421" }));
  built.linear.setIssueHierarchy("ENG-2421", {
    parent: {
      identifier: "ENG-2420",
      url: "https://linear.app/inverter/issue/ENG-2420",
      title: "Umbrella parent",
      stateType: "started",
    },
    children: [],
  });

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2421"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("umbrella_subtask_not_expected");
  expect(built.git.countCalls("worktreeAdd")).toBe(0);
  expect(built.git.countCalls("ensureRemoteBranchFromBase")).toBe(0);
  const taskCount = h.db
    .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM tasks`)
    .get();
  expect(taskCount?.count).toBe(0);
});

test("incomplete untracked Linear blocker fails before substrate side effects", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(makeIssue({ identifier: "ENG-2201" }));
  built.linear.setBlockedByRelations("ENG-2201", [
    blockedByRelation("ENG-2200", "started"),
  ]);

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-2201"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("dependency_not_tracked");
  expect(
    built.git.calls.some((call) => call.op === "worktreeAdd"),
  ).toBe(false);
  const taskCount = h.db
    .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM tasks`)
    .get();
  expect(taskCount?.count).toBe(0);
});

test("enqueue linear issue forwards PR screenshot request flag", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      identifier: "ENG-145",
      block: {
        tags: ["auth-session"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-145",
      "--request-pr-screenshots",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqResult = JSON.parse(io.out().trim());
  const task = h.db
    .query<{ pr_screenshots_requested: number }, [string]>(
      `SELECT pr_screenshots_requested FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(task?.pr_screenshots_requested).toBe(1);

  const brief = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'brief'`,
    )
    .get(enqResult.task_id, enqResult.attempt_id);
  expect(brief).not.toBeNull();
  expect(readFileSync(brief!.file_path, "utf8")).toContain(
    "<quay-pr-screenshot-request",
  );
});

test("enqueue linear issue rejects value-bearing PR screenshot boolean flag before adapter calls", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--linear-issue",
      "ENG-145",
      "--request-pr-screenshots=true",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  expect(io.out()).toBe("");
  const parsed = JSON.parse(io.err());
  expect(parsed.error).toBe("usage_error");
  expect(parsed.message).toContain(
    "--request-pr-screenshots is a boolean flag and does not take a value",
  );
  expect(built.linear.getIssueCalls).toHaveLength(0);
});

test("enqueue linear issue preserves task-level base_branch override", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      identifier: "ENG-1278",
      block: {
        base_branch: "dev",
        tags: ["auth-session"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1278"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  expect(built.git.calls.find((c) => c.op === "fetch")?.args).toEqual({
    repoId: REPO_ID,
    ref: "dev",
  });
  expect(
    (built.validatorRunner.runCalls[0]?.payload as Record<string, unknown>)
      .base_branch,
  ).toBe("dev");

  const row = h.db
    .query<{ base_branch: string | null }, [string]>(
      `SELECT base_branch FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(row?.base_branch).toBe("dev");
});

test("enqueue linear issue CLI base_branch overrides ticket base_branch", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      identifier: "ENG-1279",
      block: {
        base_branch: "feature/ticket",
        tags: ["auth-session"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1279",
      "--base-branch",
      "dev",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  const row = h.db
    .query<{ base_branch: string | null }, [string]>(
      `SELECT base_branch FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(row?.base_branch).toBe("dev");
  expect(
    (built.validatorRunner.runCalls[0]?.payload as Record<string, unknown>)
      .base_branch,
  ).toBe("dev");
});

test("test_enqueue_linear_issue_validation_failure_writes_no_db_state", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(makeIssue());
  built.validatorRunner.setInvalid([
    { field: "tags", code: "MIN_COUNT", message: "tags must contain at least 1 entries" },
  ]);

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).not.toBe(0);
  // Validator errors[] are surfaced verbatim on stdout per spec §11 step 3.
  const out = JSON.parse(io.out().trim());
  expect(out.valid).toBe(false);
  expect(Array.isArray(out.errors)).toBe(true);
  expect(out.errors[0].code).toBe("MIN_COUNT");

  // No DB writes (atomicity §3).
  const taskCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(taskCount?.n).toBe(0);
  const tagCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM task_tags`)
    .get();
  expect(tagCount?.n).toBe(0);
  const artifactCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM artifacts`)
    .get();
  expect(artifactCount?.n).toBe(0);
});

test("test_enqueue_linear_issue_combines_with_cli_tags", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["auth-session", "cache"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--tag",
      "urgent",
      "--tag",
      "cache", // dupe with block — should dedupe
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());

  const tags = h.db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag`,
    )
    .all(enqResult.task_id);
  // Block tags ∪ CLI tags, deduped, alphabetically (ORDER BY tag).
  expect(tags.map((r) => r.tag)).toEqual(["auth-session", "cache", "urgent"]);
});

test("test_enqueue_linear_issue_normalizes_block_and_cli_tag_case", async () => {
  // Block tags `Auth-Session` / CLI tag `URGENT` must converge to the
  // canonical lower-case set the validator and the `tasks` table expect.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["Auth-Session", "Cache"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--tag",
      "URGENT",
      "--tag",
      "CACHE",
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());

  const tags = h.db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag`,
    )
    .all(enqResult.task_id);
  expect(tags.map((r) => r.tag)).toEqual(["auth-session", "cache", "urgent"]);
});

test("test_enqueue_linear_issue_forwards_merged_tags_to_validator", async () => {
  // Block + CLI tags must reach the validator as one merged, lower-cased,
  // exact-deduped list — so the schema's charset/count rules apply
  // uniformly to everything that ends up persisted, not just the block.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["Auth-Session", "cache"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--tag",
      "URGENT",
      "--tag",
      "Cache",
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);

  expect(built.validatorRunner.runCalls).toHaveLength(1);
  const sent = built.validatorRunner.runCalls[0]!.payload as {
    tags: string[];
  };
  expect(sent.tags).toEqual(["auth-session", "cache", "urgent"]);
});

test("test_enqueue_linear_issue_idempotent_on_external_ref", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const ioA = bufferIO();
  const a = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    ioA,
  );
  expect(a.exitCode).toBe(0);
  const first = JSON.parse(ioA.out().trim());

  const ioB = bufferIO();
  const b = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    ioB,
  );
  expect(b.exitCode).toBe(0);
  const second = JSON.parse(ioB.out().trim());

  expect(second.task_id).toBe(first.task_id);
  // Only one task, one set of tags, in the DB.
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(1);
});

test("test_enqueue_linear_issue_mutually_exclusive_with_brief_file", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const briefPath = writeTemp("ignored", "brief.md");

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--brief-file",
      briefPath,
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("usage_error");
  // No adapter call, no DB write.
  expect(built.linear.getIssueCalls).toEqual([]);
  expect(built.validatorRunner.runCalls).toEqual([]);
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(0);
});

test("test_enqueue_linear_issue_mutually_exclusive_with_external_ref", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--external-ref",
      "FOO-99",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("usage_error");
  expect(built.linear.getIssueCalls).toEqual([]);
  expect(built.validatorRunner.runCalls).toEqual([]);
});

test("test_enqueue_linear_issue_mutually_exclusive_with_slack_thread_ref", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--slack-thread-ref",
      "C111:222.333",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("usage_error");
  expect(built.linear.getIssueCalls).toEqual([]);
  expect(built.validatorRunner.runCalls).toEqual([]);
});

test("test_enqueue_linear_issue_atomicity_failure_before_substrate", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.set5xx("ENG-1276", "linear is sad");

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("adapter_error");

  // Atomicity: no substrate side-effects started.
  // No DB rows.
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(0);
  const tags = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM task_tags`)
    .get();
  expect(tags?.n).toBe(0);
  // No git substrate calls — dispatch failed before enqueue ran.
  expect(built.git.countCalls("fetch")).toBe(0);
  expect(built.git.countCalls("worktreeAdd")).toBe(0);
  // No worktree directory (should not have been created).
  expect(existsSync(join(built.worktreesRoot, "ENG-1276"))).toBe(false);
  // Validator never invoked.
  expect(built.validatorRunner.runCalls).toEqual([]);
});

test("test_enqueue_linear_issue_validator_payload_passes_authors_through", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  const authors = [
    { name: "Primary", slack_id: "U001ABCDE" },
    { name: "Second", slack_id: "U002ABCDE" },
    { name: "Third", slack_id: "U003ABCDE" },
  ];
  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: null,
        authors,
      },
    }),
  );

  const io = bufferIO();
  await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(built.validatorRunner.runCalls).toHaveLength(1);
  const payload = built.validatorRunner.runCalls[0]!.payload as Record<
    string,
    unknown
  >;
  // 1:1 with the block — same shape, same order, no munging.
  expect(payload.authors).toEqual(authors);
});

test("test_enqueue_linear_issue_validator_payload_omits_slack_thread_when_null", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(built.validatorRunner.runCalls).toHaveLength(1);
  const payload = built.validatorRunner.runCalls[0]!.payload as Record<
    string,
    unknown
  >;
  // Spec §11: when `slack_thread_ref` is null, the field is OMITTED entirely
  // from the validator payload (not passed as `null`).
  expect("slack_thread" in payload).toBe(false);
});

test("test_enqueue_linear_issue_invokes_validator_as_child_process", async () => {
  h = createHarness();
  // Wire the real spawned validator runner — confirms the child-process
  // path actually works end-to-end against the shipped default schema.
  const built = buildCliDeps(h, { validatorRunner: new SpawnedValidatorRunner() });
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["auth-session", "cache"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );
  // If the validator subprocess spawned, the schema (shipped default) accepts
  // the payload, the child returns {valid: true}, and the task lands.
  expect(io.err()).toBe("");
  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult.state).toBe("queued");
});

test("test_enqueue_linear_issue_fails_when_ticket_has_no_quay_config_block", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue({
    identifier: "ENG-1276",
    url: "https://linear.app/inverter/issue/ENG-1276",
    title: "No block",
    body: "## Context\n\nThis ticket body has no quay-config fence at all.\n",
    comments: [],
  });

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("ticket_block_invalid");
  // Validator was not invoked (the block parser fails first).
  expect(built.validatorRunner.runCalls).toEqual([]);
  // No DB writes.
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(0);
});

test("test_enqueue_linear_issue_uses_ticket_repo_when_no_cli_repo", async () => {
  // When --repo is omitted, the ticket's `repo` field drives enqueue.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built); // registers REPO_ID

  built.linear.setIssue(
    makeIssue({
      block: {
        repo: REPO_ID, // ticket carries the repo
        tags: ["auth-session"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );

  const io = bufferIO();
  // No --repo flag; the adapter must read it from the ticket.
  const result = await dispatch(
    ["enqueue", "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult.state).toBe("queued");

  // The task must have landed under REPO_ID (the ticket-supplied repo).
  const taskRow = h.db
    .query<{ repo_id: string }, [string]>(
      `SELECT repo_id FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(taskRow?.repo_id).toBe(REPO_ID);
});

test("test_enqueue_linear_issue_explicit_repo_overrides_ticket_repo", async () => {
  // Explicit --repo wins over the ticket's repo field.
  const OVERRIDE_REPO = "override-repo";
  h = createHarness();
  const built = buildCliDeps(h);
  // Register both repos.
  await addRepo(built); // REPO_ID
  await dispatch(
    [
      "repo", "add",
      "--id", OVERRIDE_REPO,
      "--url", "git@example.com:owner/override.git",
      "--base-branch", "main",
      "--package-manager", "bun",
      "--install-cmd", "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.git.seedBareClone(OVERRIDE_REPO);

  built.linear.setIssue(
    makeIssue({
      block: {
        repo: REPO_ID, // ticket says REPO_ID
        tags: ["foo"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  // Explicit --repo overrides the ticket value.
  const result = await dispatch(
    ["enqueue", "--repo", OVERRIDE_REPO, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  const taskRow = h.db
    .query<{ repo_id: string }, [string]>(
      `SELECT repo_id FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(taskRow?.repo_id).toBe(OVERRIDE_REPO);
});

test("test_enqueue_linear_issue_idempotent_repoll_no_cli_repo_skips_linear_call", async () => {
  // Re-poll of an already-enqueued ticket on the no-`--repo` path must NOT
  // hit the Linear (or Slack) adapter — pre-fetch lookup by external_ref
  // alone short-circuits to the existing task. This preserves the
  // load-bearing property that re-polls don't burn API quota.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        repo: REPO_ID,
        tags: ["foo"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  // First call — populates the row.
  const ioA = bufferIO();
  const a = await dispatch(
    ["enqueue", "--linear-issue", "ENG-1276"],
    built.deps,
    ioA,
  );
  expect(a.exitCode).toBe(0);
  const first = JSON.parse(ioA.out().trim());

  const callsAfterFirst = built.linear.getIssueCalls.length;

  // Second call — must short-circuit before touching Linear.
  const ioB = bufferIO();
  const b = await dispatch(
    ["enqueue", "--linear-issue", "ENG-1276"],
    built.deps,
    ioB,
  );
  expect(b.exitCode).toBe(0);
  const second = JSON.parse(ioB.out().trim());

  expect(second.task_id).toBe(first.task_id);
  expect(built.linear.getIssueCalls.length).toBe(callsAfterFirst);
});

test("test_enqueue_linear_issue_ticket_missing_repo_fails_via_validator", async () => {
  // When the ticket's quay-config block is missing `repo`, the block parser
  // throws ticket_block_invalid before the validator is invoked.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  // Build a block without `repo` by constructing the raw YAML manually.
  const bodyWithoutRepo =
    `## Context\n\nNeeds work.\n\n\`\`\`quay-config\ntags:\n  - foo\nauthors:\n  - name: F\n    slack_id: U001ABCDE\n\`\`\`\n`;

  built.linear.setIssue({
    identifier: "ENG-1276",
    url: "https://linear.app/inverter/issue/ENG-1276",
    title: "Missing repo",
    body: bodyWithoutRepo,
    comments: [],
  });

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  // Block parser catches missing repo before the validator runs.
  expect(err.error).toBe("ticket_block_invalid");
  expect(built.validatorRunner.runCalls).toEqual([]);
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(0);
});
