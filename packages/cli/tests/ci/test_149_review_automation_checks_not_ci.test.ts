import { expect, test } from "bun:test";
import { classifyCi } from "../../src/core/ci_status.ts";
import { resolveCiIgnorePolicy } from "../../src/core/ci_policy.ts";
import type { PrCheck, PrSnapshot } from "../../src/ports/github.ts";

const check = (overrides: Partial<PrCheck>): PrCheck => ({
  name: "test",
  workflow: "CI",
  bucket: "pass",
  required: false,
  ...overrides,
});

test("review automation failures do not block otherwise green product CI", () => {
  const snapshot = makeSnapshot([
    check({ name: "Lint & Format", bucket: "pass", required: true }),
    check({ name: "Typecheck", bucket: "pass", required: true }),
    check({ name: "Test", bucket: "pass", required: true }),
    check({ name: "Build", bucket: "pass", required: true }),
    check({ name: "FE PR Review", bucket: "fail" }),
  ]);

  expect(classifyCi(snapshot, null, {
    ignoredCheckNames: ["FE PR Review"],
    ignoredWorkflowNames: [],
  })).toBe("pass");
});

test("review automation workflow state is ignored but product failures still block", () => {
  const snapshot = makeSnapshot([
    check({ name: "review", workflow: "Quay review", bucket: "pending" }),
    check({ name: "preview", workflow: "preview.yml", bucket: "fail" }),
  ]);

  expect(classifyCi(snapshot, null, {
    ignoredCheckNames: [],
    ignoredWorkflowNames: ["Quay review"],
  })).toBe("fail");
});

test("ignored names match exactly after trim and case fold", () => {
  const snapshot = makeSnapshot([
    check({ name: "  fe pr review ", bucket: "fail" }),
    check({ name: "FE PR Review / extra", bucket: "fail" }),
  ]);

  expect(classifyCi(snapshot, null, {
    ignoredCheckNames: ["FE PR Review"],
    ignoredWorkflowNames: [],
  })).toBe("fail");
});

test("repo CI ignore policy supports inherit extend and replace", () => {
  const global = {
    ignoredCheckNames: ["global-check"],
    ignoredWorkflowNames: ["global-workflow"],
  };

  expect(resolveCiIgnorePolicy(global, {
    ci_ignore_mode: "inherit",
    ignored_check_names: ["repo-check"],
    ignored_workflow_names: ["repo-workflow"],
  })).toEqual(global);

  expect(resolveCiIgnorePolicy(global, {
    ci_ignore_mode: "extend",
    ignored_check_names: ["repo-check"],
    ignored_workflow_names: ["repo-workflow"],
  })).toEqual({
    ignoredCheckNames: ["global-check", "repo-check"],
    ignoredWorkflowNames: ["global-workflow", "repo-workflow"],
  });

  expect(resolveCiIgnorePolicy(global, {
    ci_ignore_mode: "replace",
    ignored_check_names: ["repo-check"],
    ignored_workflow_names: ["repo-workflow"],
  })).toEqual({
    ignoredCheckNames: ["repo-check"],
    ignoredWorkflowNames: ["repo-workflow"],
  });
});

function makeSnapshot(items: PrCheck[]): PrSnapshot {
  return {
    state: "open",
    headSha: "head",
    baseSha: "base",
    mergeable: "mergeable",
    latestReview: {
      decision: "NONE",
      latestReviewId: null,
      comments: "",
    },
    checks: { checkSha: "head", items },
  };
}
