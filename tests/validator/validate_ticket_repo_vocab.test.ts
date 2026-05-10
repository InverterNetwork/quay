// validate-ticket integrates with TagService to enforce the merged
// (deployment ∪ per-repo) vocab when a repo opts in. Drives
// handleValidateTicket directly with a `lookupRepoVocab` closure backed by a
// real TagService over a tmp DB.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bufferIO } from "../../src/cli/io.ts";
import {
  handleValidateTicket,
  type RepoVocabLookup,
} from "../../src/cli/validate_ticket.ts";
import type { TagService } from "../../src/core/tags/service.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertRepo } from "../support/fixtures.ts";

let h: Harness | null = null;
let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
  h?.cleanup();
  h = null;
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "quay-validate-vocab-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// Empty config dir → handler falls through to the shipped default schema.
function shippedDefaultEnv(): { QUAY_CONFIG_DIR: string } {
  const dir = tempDir();
  // Ensure the dir is empty (no ticket_schema.toml).
  writeFileSync(join(dir, ".keep"), "");
  return { QUAY_CONFIG_DIR: dir };
}

function lookupFromService(
  tagService: TagService,
  repoExists: (repoId: string) => boolean = () => true,
): RepoVocabLookup {
  return (repoId) => {
    if (!repoExists(repoId)) return null;
    const perRepo = tagService.getVocab("repo", repoId);
    if (Object.keys(perRepo).length === 0) return null;
    return { perRepo, deployment: tagService.getVocab("deployment") };
  };
}

interface RunArgs {
  payload: unknown;
  tagService?: TagService;
}

function runValidate({ payload, tagService }: RunArgs) {
  const io = bufferIO();
  io.setStdin(JSON.stringify(payload));
  const result = handleValidateTicket(
    ["--ticket-json", "-"],
    io,
    shippedDefaultEnv(),
    tagService === undefined
      ? {}
      : { lookupRepoVocab: lookupFromService(tagService) },
  );
  return { io, result };
}

const BASE_PAYLOAD = {
  body:
    "Refactor the cache to evict entries when a user logs out. Context: stale entries persist for 30 minutes after revocation.",
  repo: "repo-a",
  tags: ["area-bonding-curve"],
  authors: [{ name: "Fabian", slack_id: "U06TDC56VJB" }],
};

test("repo with no per-repo vocab → enforcement skipped (opt-in gate)", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");

  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["whatever-noise"] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("deployment-required namespace doesn't bind unconfigured repos", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  built.deps.tagService.apply("deployment", null, {
    area: { values: ["bonding-curve"], required: true },
  });

  // repo-a still has no per-repo vocab → enforcement gate stays closed.
  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["random-tag"] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("configured repo rejects unknown namespace", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  built.deps.tagService.apply("repo", "repo-a", {
    area: { values: ["bonding-curve"] },
  });

  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["risk-reentrancy"] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const codes = out.errors.map((e: { code: string }) => e.code);
  expect(codes).toContain("TAG_UNKNOWN_NAMESPACE");
});

test("configured repo rejects unknown value within known namespace", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  built.deps.tagService.apply("repo", "repo-a", {
    area: { values: ["bonding-curve"] },
  });

  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["area-vesting"] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const errs = out.errors.filter((e: { code: string }) => e.code === "TAG_UNKNOWN_VALUE");
  expect(errs).toHaveLength(1);
  expect(errs[0].field).toBe("tags[0]");
});

test("configured repo rejects when required namespace has no matching tag", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  built.deps.tagService.apply("repo", "repo-a", {
    area: { values: ["bonding-curve"], required: true },
    risk: { values: ["reentrancy"] },
  });

  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["risk-reentrancy"] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const errs = out.errors.filter((e: { code: string }) => e.code === "TAG_REQUIRED_MISSING");
  expect(errs).toHaveLength(1);
  expect(errs[0].field).toBe("tags");
});

test("deployment-required survives per-repo required=false", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  built.deps.tagService.apply("deployment", null, {
    area: { values: ["bonding-curve"], required: true },
  });
  // Per-repo opts in (gate now open) and tries to un-require area.
  built.deps.tagService.apply("repo", "repo-a", {
    area: { values: ["vesting"], required: false },
  });

  // Tag list satisfies neither required namespace.
  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["area-mint"] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const required = out.errors.filter((e: { code: string }) => e.code === "TAG_REQUIRED_MISSING");
  expect(required).toHaveLength(1);
});

test("merged vocab unions deployment and per-repo values", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  built.deps.tagService.apply("deployment", null, {
    area: { values: ["bonding-curve"] },
  });
  built.deps.tagService.apply("repo", "repo-a", {
    area: { values: ["vesting"] },
  });

  // A tag from each layer is accepted.
  const { io: io1, result: r1 } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["area-bonding-curve"] },
    tagService: built.deps.tagService,
  });
  expect(r1.exitCode).toBe(0);
  expect(JSON.parse(io1.out().trim())).toEqual({ valid: true });

  const { io: io2, result: r2 } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["area-vesting"] },
    tagService: built.deps.tagService,
  });
  expect(r2.exitCode).toBe(0);
  expect(JSON.parse(io2.out().trim())).toEqual({ valid: true });
});

test("cross-repo isolation: repo-b's vocab doesn't bleed into repo-a", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  insertRepo(h.db, "repo-b");
  built.deps.tagService.apply("repo", "repo-b", {
    area: { values: ["bonding-curve"] },
  });
  // repo-a has no per-repo vocab → opt-in gate stays closed for it.

  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, repo: "repo-a", tags: ["random-tag"] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("unregistered repo → enforcement skipped (lookup returns null)", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  // No insertRepo call: repo-a is not registered.
  // The production lookup factory checks repoService.get first; mirror that
  // by passing an existence check that returns false.
  const lookup = lookupFromService(
    built.deps.tagService,
    () => false,
  );
  const io = bufferIO();
  io.setStdin(JSON.stringify({ ...BASE_PAYLOAD, tags: ["whatever-noise"] }));
  const result = handleValidateTicket(
    ["--ticket-json", "-"],
    io,
    shippedDefaultEnv(),
    { lookupRepoVocab: lookup },
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("no lookup wired → existing v0 behavior preserved", () => {
  // Calling with no lookupRepoVocab dep at all should pass for any tag set
  // that meets the schema (charset/min/unique).
  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["whatever"] },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("non-string tags don't shift vocab error indices", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  built.deps.tagService.apply("repo", "repo-a", {
    area: { values: ["bonding-curve"] },
  });

  // tags[0] is a number → base validator emits TYPE at tags[0].
  // tags[1] is "risk-reentrancy" — unknown namespace under repo-a's vocab.
  // The vocab error must point at tags[1], not tags[0].
  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: [123, "risk-reentrancy"] as unknown[] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const typeErr = out.errors.find((e: { code: string }) => e.code === "TYPE");
  expect(typeErr.field).toBe("tags[0]");
  const vocabErr = out.errors.find(
    (e: { code: string }) => e.code === "TAG_UNKNOWN_NAMESPACE",
  );
  expect(vocabErr.field).toBe("tags[1]");
});

test("vocab errors coexist with v0 schema errors", () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  built.deps.tagService.apply("repo", "repo-a", {
    area: { values: ["bonding-curve"], required: true },
  });

  // Charset violation on tag[1] AND vocab violations on both tags.
  const { io, result } = runValidate({
    payload: { ...BASE_PAYLOAD, tags: ["bogus-thing", "AreaBondingCurve"] },
    tagService: built.deps.tagService,
  });
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const codes = out.errors.map((e: { code: string }) => e.code);
  expect(codes).toContain("CHARSET");
  expect(codes).toContain("TAG_UNKNOWN_NAMESPACE");
  expect(codes).toContain("TAG_REQUIRED_MISSING");
});
