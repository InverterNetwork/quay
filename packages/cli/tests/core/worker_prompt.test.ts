import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OBJECTIVE_RENDER_CAP_BYTES,
  INITIAL_ATTEMPT_GUIDANCE,
  composeWorkerPrompt,
  loadOriginalTaskObjective,
} from "../../src/core/worker_prompt.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const PREAMBLE = "Quay protocol preamble (v1)\n... rules ...";

const SAFE_OBJECTIVE = {
  body: "Build the widget service.",
  artifactId: 7,
  filePath: "/artifacts/task-1/task/task_objective/abc.md",
};

test("preamble comes first and brief is preamble-stripped final_prompt", () => {
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: SAFE_OBJECTIVE,
    attemptGuidance: { reason: "initial", body: INITIAL_ATTEMPT_GUIDANCE },
  });
  expect(composed.finalPrompt.startsWith(`${PREAMBLE}\n\n`)).toBe(true);
  expect(composed.finalPrompt).toBe(`${PREAMBLE}\n\n${composed.brief}`);
});

test("stable objective renders inside a tagged section with audit attributes", () => {
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: SAFE_OBJECTIVE,
    attemptGuidance: { reason: "initial", body: "guidance" },
  });
  expect(composed.brief).toContain(
    `<quay-task-objective artifact-id="${SAFE_OBJECTIVE.artifactId}"`,
  );
  expect(composed.brief).toContain(
    `source-path="${SAFE_OBJECTIVE.filePath}"`,
  );
  expect(composed.brief).toContain(`objective-bytes="${SAFE_OBJECTIVE.body.length}"`);
  expect(composed.brief).toContain('truncated="false"');
  expect(composed.brief).toContain(SAFE_OBJECTIVE.body);
});

test("diagnostics section is omitted when no diagnostics supplied", () => {
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: SAFE_OBJECTIVE,
    attemptGuidance: { reason: "initial", body: "guidance" },
  });
  expect(composed.brief).not.toContain("<quay-diagnostics");
  expect(composed.brief).not.toContain("<quay-reference-repos");
});

test("PR target section renders effective base branch when supplied", () => {
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: SAFE_OBJECTIVE,
    prBaseBranch: "release/2026.05",
    attemptGuidance: { reason: "initial", body: "guidance" },
  });
  expect(composed.brief).toContain(
    '<quay-pr-target base-branch="release/2026.05">',
  );
  expect(composed.brief).toContain(
    "Open or update the pull request against base branch release/2026.05.",
  );
});

test("PR screenshot request section renders only when requested", () => {
  const omitted = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: SAFE_OBJECTIVE,
    prBaseBranch: "main",
    attemptGuidance: { reason: "initial", body: "guidance" },
  });
  expect(omitted.brief).not.toContain("<quay-pr-screenshot-request");

  const requested = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: SAFE_OBJECTIVE,
    prBaseBranch: "main",
    prScreenshotsRequested: true,
    attemptGuidance: { reason: "initial", body: "guidance" },
  });
  const targetIndex = requested.brief.indexOf("<quay-pr-target");
  const screenshotIndex = requested.brief.indexOf(
    "<quay-pr-screenshot-request",
  );
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  expect(screenshotIndex).toBeGreaterThan(targetIndex);
  expect(requested.brief).toContain(
    "capture one or more screenshots of the changed UI state",
  );
  expect(requested.brief).toContain(
    "state that limitation plainly in the PR body or PR comment",
  );
  expect(requested.brief).toContain("Do not block for interactive input");
});

test("PR screenshot requirement section renders hard mode", () => {
  const required = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: SAFE_OBJECTIVE,
    prBaseBranch: "main",
    prScreenshotsRequired: true,
    attemptGuidance: { reason: "initial", body: "guidance" },
  });
  expect(required.brief).toContain(
    '<quay-pr-screenshot-request requested="true" required="true">',
  );
  expect(required.brief).toContain(
    "Screenshots are required for this task.",
  );
  expect(required.brief).toContain(
    "stop with a blocker instead of opening or updating the PR as complete",
  );
});

test("diagnostics section appears when provided and tags reason kind", () => {
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: SAFE_OBJECTIVE,
    attemptGuidance: { reason: "ci_fail", body: "rerun" },
    diagnostics: { kind: "ci_failure_excerpt", body: "tests failed in cli.ts" },
  });
  expect(composed.brief).toContain('<quay-diagnostics kind="ci_failure_excerpt">');
  expect(composed.brief).toContain("tests failed in cli.ts");
});

test("body content escapes &, <, > inside tagged sections", () => {
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: {
      ...SAFE_OBJECTIVE,
      body: "Use <html> & </quay-task-objective> as test fixtures.",
    },
    attemptGuidance: {
      reason: "initial",
      body: "Don't & let </quay-current-attempt-guidance> close the tag.",
    },
    diagnostics: {
      kind: "ci_failure_excerpt",
      body: "stderr: <expected 1 got 2>",
    },
  });
  // The escape preserves the original characters as entities rather than
  // letting a malicious objective body close the wrapping tag early.
  expect(composed.brief).toContain(
    "Use &lt;html&gt; &amp; &lt;/quay-task-objective&gt;",
  );
  expect(composed.brief).toContain(
    "Don't &amp; let &lt;/quay-current-attempt-guidance&gt; close the tag.",
  );
  expect(composed.brief).toContain("stderr: &lt;expected 1 got 2&gt;");
  // No raw closing tag from the user content leaks through.
  const userClosing = "</quay-task-objective>";
  // The composer adds exactly one closing tag per section (the real one).
  const occurrences = composed.brief.split(userClosing).length - 1;
  expect(occurrences).toBe(1);
});

test("attribute values escape double-quote, &, <, >", () => {
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: {
      body: "obj",
      artifactId: 1,
      filePath: '/some path with "quotes" & <brackets>.md',
    },
    attemptGuidance: { reason: 'malicious"reason', body: "g" },
    diagnostics: { kind: 'kind"with"quotes', body: "d" },
  });
  expect(composed.brief).toContain(
    'source-path="/some path with &quot;quotes&quot; &amp; &lt;brackets&gt;.md"',
  );
  expect(composed.brief).toContain('reason="malicious&quot;reason"');
  expect(composed.brief).toContain('kind="kind&quot;with&quot;quotes"');
});

test("reference repos section renders sorted immediate git children", () => {
  const root = mkdtempSync(join(tmpdir(), "quay-reference-repos-"));
  try {
    mkdirSync(join(root, "beta", ".git"), { recursive: true });
    mkdirSync(join(root, "alpha", ".git"), { recursive: true });
    mkdirSync(join(root, "not-a-repo"), { recursive: true });

    const composed = composeWorkerPrompt({
      preambleBody: PREAMBLE,
      taskObjective: SAFE_OBJECTIVE,
      referenceReposRoot: root,
      attemptGuidance: { reason: "initial", body: "guidance" },
    });

    expect(composed.brief).toContain(
      `<quay-reference-repos root="${root}">`,
    );
    expect(composed.brief).toContain(
      `- alpha: ${join(root, "alpha")}`,
    );
    expect(composed.brief).toContain(`- beta: ${join(root, "beta")}`);
    expect(composed.brief).not.toContain("not-a-repo");
    expect(composed.brief.indexOf("alpha")).toBeLessThan(
      composed.brief.indexOf("beta"),
    );
    expect(composed.brief).toContain(
      "Do not edit, commit, branch, or push from these directories.",
    );
    expect(composed.brief).toContain("Only modify the Quay task worktree.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reference repos section renders an empty configured root", () => {
  const root = mkdtempSync(join(tmpdir(), "quay-reference-repos-empty-"));
  try {
    const composed = composeWorkerPrompt({
      preambleBody: PREAMBLE,
      taskObjective: SAFE_OBJECTIVE,
      referenceReposRoot: root,
      attemptGuidance: { reason: "initial", body: "guidance" },
    });
    expect(composed.brief).toContain(
      `<quay-reference-repos root="${root}">`,
    );
    expect(composed.brief).toContain("- (none discovered)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing reference repos root is omitted without throwing", () => {
  const parent = mkdtempSync(join(tmpdir(), "quay-reference-repos-missing-"));
  try {
    const root = join(parent, "missing");
    const composed = composeWorkerPrompt({
      preambleBody: PREAMBLE,
      taskObjective: SAFE_OBJECTIVE,
      referenceReposRoot: root,
      attemptGuidance: { reason: "initial", body: "guidance" },
    });
    expect(composed.brief).not.toContain("<quay-reference-repos");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("objective under cap renders truncated=false with full body", () => {
  const body = "x".repeat(100);
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: { ...SAFE_OBJECTIVE, body },
    attemptGuidance: { reason: "initial", body: "g" },
    renderCapBytes: 1024,
  });
  expect(composed.brief).toContain('truncated="false"');
  expect(composed.brief).toContain(body);
  expect(composed.brief).not.toContain("excerpt-bytes=");
  expect(composed.brief).not.toContain("Excerpt truncated");
});

test("objective over cap renders an excerpt plus pointer to full artifact", () => {
  const body = "y".repeat(2048);
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: { ...SAFE_OBJECTIVE, body },
    attemptGuidance: { reason: "initial", body: "g" },
    renderCapBytes: 256,
  });
  expect(composed.brief).toContain('truncated="true"');
  expect(composed.brief).toContain('objective-bytes="2048"');
  expect(composed.brief).toContain("excerpt-bytes=");
  expect(composed.brief).toContain(
    `[Excerpt truncated. Read the full original task objective from artifact #${SAFE_OBJECTIVE.artifactId} at ${SAFE_OBJECTIVE.filePath}.]`,
  );
  // Excerpt is a prefix of the body, never exceeds the cap.
  const matchExcerptBytes = composed.brief.match(/excerpt-bytes="(\d+)"/);
  expect(matchExcerptBytes).not.toBeNull();
  expect(Number(matchExcerptBytes![1])).toBeLessThanOrEqual(256);
});

test("truncation never slices a multibyte codepoint in half", () => {
  // Four-byte UTF-8 codepoints: cap=3 sits inside the second codepoint.
  const body = "\u{1F600}\u{1F601}\u{1F602}"; // 12 bytes total
  const composed = composeWorkerPrompt({
    preambleBody: PREAMBLE,
    taskObjective: { ...SAFE_OBJECTIVE, body },
    attemptGuidance: { reason: "initial", body: "g" },
    renderCapBytes: 6,
  });
  expect(composed.brief).toContain('truncated="true"');
  // The excerpt should contain exactly one full emoji (4 bytes), not a partial.
  const matchExcerptBytes = composed.brief.match(/excerpt-bytes="(\d+)"/);
  expect(Number(matchExcerptBytes![1])).toBe(4);
});

test("default render cap is exposed as a constant", () => {
  expect(DEFAULT_OBJECTIVE_RENDER_CAP_BYTES).toBeGreaterThan(1024);
});

test("loadOriginalTaskObjective reads the task-level kind='task_objective' artifact", () => {
  h = createHarness();
  const taskId = insertTask(h.db, { taskId: "obj-task" });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  const written = store.writeArtifact({
    taskId,
    attemptId: null,
    kind: "task_objective",
    content: "Build the widget service.",
    extension: "md",
  });

  const ref = loadOriginalTaskObjective(h.db, taskId);
  expect(ref.artifactId).toBe(written.artifactId);
  expect(ref.filePath).toBe(written.filePath);
  expect(ref.body).toBe("Build the widget service.");
});

test("loadOriginalTaskObjective throws when no task_objective artifact exists", () => {
  const harness = createHarness();
  h = harness;
  const taskId = insertTask(harness.db, { taskId: "no-objective" });
  expect(() => loadOriginalTaskObjective(harness.db, taskId)).toThrow(
    /task_objective artifact not found/,
  );
});

test("loadOriginalTaskObjective throws with a clear message if the file is gone", () => {
  const harness = createHarness();
  h = harness;
  const taskId = insertTask(harness.db, { taskId: "missing-file" });
  const store = createArtifactStore({
    db: harness.db,
    artifactRoot: harness.artifactRoot,
    clock: harness.clock,
  });
  const written = store.writeArtifact({
    taskId,
    attemptId: null,
    kind: "task_objective",
    content: "Build the widget service.",
    extension: "md",
  });
  unlinkSync(written.filePath);

  expect(() => loadOriginalTaskObjective(harness.db, taskId)).toThrow(
    /task_objective artifact \d+ unreadable/,
  );
});
