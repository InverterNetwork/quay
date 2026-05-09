import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../../support/harness.ts";
import { createTagService } from "../../../src/core/tags/service.ts";
import { QuayError } from "../../../src/core/errors.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REQUIRED_REPO = {
  repo_id: "repo-a",
  repo_url: "git@example.com:owner/repo-a.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
};

function addRepo(harness: Harness, repoId: string): void {
  harness.db.query(
    `INSERT INTO repos (repo_id, repo_url, base_branch, package_manager, install_cmd, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(repoId, `git@example.com:owner/${repoId}.git`, "main", "bun", "bun install", "2024-01-01T00:00:00.000Z");
}

test("setValue and getValues round-trip", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setValue("repo", "repo-a", "area", "vesting");
  svc.setValue("repo", "repo-a", "risk", "reentrancy");

  const values = svc.getValues("repo", "repo-a");
  expect(values).toEqual({
    area: ["bonding-curve", "vesting"],
    risk: ["reentrancy"],
  });
});

test("setValue is idempotent", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setValue("repo", "repo-a", "area", "bonding-curve");

  const values = svc.getValues("repo", "repo-a");
  expect(values["area"]).toEqual(["bonding-curve"]);
  expect(
    h.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tag_namespaces")
      .get()!.c,
  ).toBe(1);
});

test("unsetValue with specific value removes only that value", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setValue("repo", "repo-a", "area", "vesting");

  svc.unsetValue("repo", "repo-a", "area", "bonding-curve");

  const values = svc.getValues("repo", "repo-a");
  expect(values["area"]).toEqual(["vesting"]);
});

test("unsetValue without value removes whole namespace and meta", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setValue("repo", "repo-a", "area", "vesting");
  svc.setRequired("repo", "repo-a", "area", true);

  svc.unsetValue("repo", "repo-a", "area");

  const values = svc.getValues("repo", "repo-a");
  expect(values["area"]).toBeUndefined();
  const required = svc.getRequired("repo", "repo-a");
  expect(required["area"]).toBeUndefined();
});

test("setRequired upserts the meta row", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setRequired("repo", "repo-a", "area", true);

  expect(svc.getRequired("repo", "repo-a")).toEqual({ area: true });

  svc.setRequired("repo", "repo-a", "area", false);
  expect(svc.getRequired("repo", "repo-a")).toEqual({ area: false });
});

test("getRequired returns only explicitly set namespaces", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "bonding-curve");

  const required = svc.getRequired("repo", "repo-a");
  expect(Object.keys(required)).toHaveLength(0);
});

test("apply is transactional and declaratively replaces state", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "old-ns", "old-val");

  svc.apply("repo", "repo-a", {
    area: { values: ["bonding-curve", "vesting"], required: true },
    risk: { values: ["reentrancy"] },
  });

  const values = svc.getValues("repo", "repo-a");
  expect(values).toEqual({
    area: ["bonding-curve", "vesting"],
    risk: ["reentrancy"],
  });
  expect(values["old-ns"]).toBeUndefined();

  const required = svc.getRequired("repo", "repo-a");
  expect(required).toEqual({ area: true });
});

test("apply with empty namespaces clears everything", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "bonding-curve");
  svc.setRequired("repo", "repo-a", "area", true);

  svc.apply("repo", "repo-a", {});

  expect(svc.getValues("repo", "repo-a")).toEqual({});
  expect(svc.getRequired("repo", "repo-a")).toEqual({});
});

test("apply is transactional: invalid value in second namespace leaves nothing written", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "existing");

  let caught: unknown;
  try {
    svc.apply("repo", "repo-a", {
      "good-ns": { values: ["good-val"] },
      "bad ns": { values: ["val"] }, // invalid namespace charset
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");

  // The "existing" value from before should still be there; nothing was written.
  const values = svc.getValues("repo", "repo-a");
  expect(values).toEqual({ area: ["existing"] });
});

test("per-repo isolation: vocab on repo-a does not appear in repo-b", () => {
  h = createHarness();
  addRepo(h, "repo-a");
  addRepo(h, "repo-b");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "bonding-curve");

  expect(svc.getValues("repo", "repo-b")).toEqual({});
});

test("unknown_repo error when repo does not exist", () => {
  h = createHarness();
  const svc = createTagService({ db: h.db, clock: h.clock });

  let caught: unknown;
  try {
    svc.setValue("repo", "no-such-repo", "area", "val");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("unknown_repo");
});

test("apply throws unknown_repo for non-existent repo", () => {
  h = createHarness();
  const svc = createTagService({ db: h.db, clock: h.clock });

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
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  const invalid = ["Area", "a_b", "a b", "", "a/b"];
  for (const ns of invalid) {
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
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  const invalid = ["Val", "a_b", "a b", "", "a/b"];
  for (const v of invalid) {
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

test("PK and CHECK constraint: deployment scope with non-null repo_id is rejected", () => {
  h = createHarness();
  addRepo(h, "repo-a");

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
  addRepo(h, "repo-a");
  const svc = createTagService({ db: h.db, clock: h.clock });

  svc.setValue("repo", "repo-a", "area", "val");

  const row = h.db
    .query<{ created_at: number }, []>(
      "SELECT created_at FROM tag_namespaces LIMIT 1",
    )
    .get()!;
  expect(typeof row.created_at).toBe("number");
  expect(row.created_at).toBeGreaterThan(0);
});
