import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../../support/harness.ts";
import { insertRepo } from "../../support/fixtures.ts";
import { createRepoService } from "../../../src/core/repos/service.ts";
import { createTagService } from "../../../src/core/tags/service.ts";
import { QuayError } from "../../../src/core/errors.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function makeService(harness: Harness) {
  const repoService = createRepoService({ db: harness.db, clock: harness.clock });
  return createTagService({ db: harness.db, clock: harness.clock, repoService });
}

test("setValue and getValues round-trip", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setValue("repo", "repo-a", "area", "vesting");
  svc.setValue("repo", "repo-a", "risk", "reentrancy");

  expect(svc.getValues("repo", "repo-a")).toEqual({
    area: ["bonding-curve", "vesting"],
    risk: ["reentrancy"],
  });
});

test("setValue is idempotent", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setValue("repo", "repo-a", "area", "bonding-curve");

  expect(svc.getValues("repo", "repo-a")["area"]).toEqual(["bonding-curve"]);
  expect(
    h.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tag_namespaces").get()!.c,
  ).toBe(1);
});

test("unsetValue with specific value removes only that value", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setValue("repo", "repo-a", "area", "vesting");
  svc.unsetValue("repo", "repo-a", "area", "bonding-curve");

  expect(svc.getValues("repo", "repo-a")["area"]).toEqual(["vesting"]);
});

test("unsetValue without value removes whole namespace and meta", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setValue("repo", "repo-a", "area", "vesting");
  svc.setRequired("repo", "repo-a", "area", true);

  svc.unsetValue("repo", "repo-a", "area");

  expect(svc.getValues("repo", "repo-a")["area"]).toBeUndefined();
  expect(svc.getRequired("repo", "repo-a")["area"]).toBeUndefined();
});

test("setRequired upserts the meta row", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setRequired("repo", "repo-a", "area", true);
  expect(svc.getRequired("repo", "repo-a")).toEqual({ area: true });

  svc.setRequired("repo", "repo-a", "area", false);
  expect(svc.getRequired("repo", "repo-a")).toEqual({ area: false });
});

test("getRequired returns only explicitly set namespaces", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "bonding-curve");

  expect(Object.keys(svc.getRequired("repo", "repo-a"))).toHaveLength(0);
});

test("apply declaratively replaces state and returns the canonical result", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "old-ns", "old-val");

  const result = svc.apply("repo", "repo-a", {
    area: { values: ["bonding-curve", "vesting"], required: true },
    risk: { values: ["reentrancy"] },
  });

  expect(result).toEqual({
    area: { values: ["bonding-curve", "vesting"], required: true },
    risk: { values: ["reentrancy"], required: false },
  });
  expect(svc.getValues("repo", "repo-a")["old-ns"]).toBeUndefined();
  expect(svc.getRequired("repo", "repo-a")).toEqual({ area: true });
});

test("apply with empty namespaces clears everything", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setRequired("repo", "repo-a", "area", true);

  expect(svc.apply("repo", "repo-a", {})).toEqual({});
  expect(svc.getValues("repo", "repo-a")).toEqual({});
  expect(svc.getRequired("repo", "repo-a")).toEqual({});
});

test("apply rejects an empty namespace string before touching the DB", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "existing");

  expect(() =>
    svc.apply("repo", "repo-a", { "": { values: ["x"] } }),
  ).toThrow(QuayError);
  expect(svc.getValues("repo", "repo-a")).toEqual({ area: ["existing"] });
});

test("apply rolls back when a value in a later namespace is invalid", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "existing");

  let caught: unknown;
  try {
    svc.apply("repo", "repo-a", {
      "good-ns": { values: ["good-val"] },
      "bad ns": { values: ["val"] },
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
  expect(svc.getValues("repo", "repo-a")).toEqual({ area: ["existing"] });
});

test("per-repo isolation: vocab on repo-a does not appear in repo-b", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  insertRepo(h.db, "repo-b");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "bonding-curve");

  expect(svc.getValues("repo", "repo-b")).toEqual({});
});

test("setValue throws unknown_repo when the repo does not exist", () => {
  h = createHarness();
  const svc = makeService(h);

  let caught: unknown;
  try {
    svc.setValue("repo", "no-such-repo", "area", "val");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("unknown_repo");
});

test("apply throws unknown_repo when the repo does not exist", () => {
  h = createHarness();
  const svc = makeService(h);

  let caught: unknown;
  try {
    svc.apply("repo", "no-such-repo", { area: { values: ["val"] } });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("unknown_repo");
});

test("validation_error for namespace not matching [a-z0-9-]+", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  for (const ns of ["Area", "a_b", "a b", "", "a/b"]) {
    let caught: unknown;
    try {
      svc.setValue("repo", "repo-a", ns, "val");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuayError);
    expect((caught as QuayError).code).toBe("validation_error");
  }
});

test("validation_error for value not matching [a-z0-9-]+", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  for (const v of ["Val", "a_b", "a b", "", "a/b"]) {
    let caught: unknown;
    try {
      svc.setValue("repo", "repo-a", "area", v);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuayError);
    expect((caught as QuayError).code).toBe("validation_error");
  }
});

test("CHECK constraint: deployment scope with non-null repo_id is rejected", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");

  let caught: unknown;
  try {
    h.db
      .query(
        `INSERT INTO tag_namespaces (scope, repo_id, namespace, value, created_at)
         VALUES ('deployment', 'repo-a', 'area', 'val', 1000)`,
      )
      .run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeTruthy();
  expect(String(caught)).toMatch(/CHECK|constraint/i);
});

test("created_at is stored as unix ms integer", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "area", "val");

  const row = h.db
    .query<{ created_at: number }, []>(
      "SELECT created_at FROM tag_namespaces LIMIT 1",
    )
    .get()!;
  expect(typeof row.created_at).toBe("number");
  expect(row.created_at).toBeGreaterThan(0);
});

test("getVocab merges values and required into a single sorted shape", () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const svc = makeService(h);

  svc.setValue("repo", "repo-a", "risk", "reentrancy");
  svc.setValue("repo", "repo-a", "area", "vesting");
  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setRequired("repo", "repo-a", "area", true);

  expect(svc.getVocab("repo", "repo-a")).toEqual({
    area: { values: ["bonding-curve", "vesting"], required: true },
    risk: { values: ["reentrancy"], required: false },
  });
});
