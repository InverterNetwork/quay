import { expect, test } from "bun:test";
import { classifyCi } from "../../src/core/ci_status.ts";
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

  expect(classifyCi(snapshot, null)).toBe("pass");
});

test("review automation workflow state is ignored but product failures still block", () => {
  const snapshot = makeSnapshot([
    check({ name: "review", workflow: "Quay review", bucket: "pending" }),
    check({ name: "preview", workflow: "preview.yml", bucket: "fail" }),
  ]);

  expect(classifyCi(snapshot, null)).toBe("fail");
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
