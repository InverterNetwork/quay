import { test, expect } from "bun:test";
import { mergeVocab } from "../../../src/core/tags/merge.ts";

test("empty deployment + empty perRepo yields empty namespaces, not enforced", () => {
  const result = mergeVocab({}, {});
  expect(result).toEqual({ namespaces: {}, enforced: false });
});

test("deployment-only vocab with empty perRepo is not enforced", () => {
  const result = mergeVocab(
    { area: { values: ["defi", "lending"], required: false } },
    {},
  );
  expect(result.enforced).toBe(false);
  expect(result.namespaces).toEqual({
    area: { values: ["defi", "lending"], required: false },
  });
});

test("per-repo-only vocab with empty deployment is enforced", () => {
  const result = mergeVocab(
    {},
    { risk: { values: ["reentrancy"], required: true } },
  );
  expect(result.enforced).toBe(true);
  expect(result.namespaces).toEqual({
    risk: { values: ["reentrancy"], required: true },
  });
});

test("disjoint namespaces both appear in result and are sorted", () => {
  const result = mergeVocab(
    { zebra: { values: ["z1"], required: false } },
    { alpha: { values: ["a1"], required: false } },
  );
  expect(result.enforced).toBe(true);
  expect(Object.keys(result.namespaces)).toEqual(["alpha", "zebra"]);
});

test("overlapping namespace: values are unioned, deduped, and sorted ascending", () => {
  const result = mergeVocab(
    { area: { values: ["vesting", "bonding-curve"], required: false } },
    { area: { values: ["bonding-curve", "lending"], required: false } },
  );
  expect(result.namespaces["area"]!.values).toEqual([
    "bonding-curve",
    "lending",
    "vesting",
  ]);
});

test("required conflict: deployment true, perRepo false → result true", () => {
  const result = mergeVocab(
    { area: { values: ["val"], required: true } },
    { area: { values: ["val"], required: false } },
  );
  expect(result.namespaces["area"]!.required).toBe(true);
});

test("required: deployment false, perRepo true → result true", () => {
  const result = mergeVocab(
    { area: { values: ["val"], required: false } },
    { area: { values: ["val"], required: true } },
  );
  expect(result.namespaces["area"]!.required).toBe(true);
});

test("required: both false → result false", () => {
  const result = mergeVocab(
    { area: { values: ["val"], required: false } },
    { area: { values: ["val"], required: false } },
  );
  expect(result.namespaces["area"]!.required).toBe(false);
});

test("namespaces in output are sorted ascending by key", () => {
  const result = mergeVocab(
    {
      zebra: { values: ["z"], required: false },
      mango: { values: ["m"], required: false },
    },
    {
      apple: { values: ["a"], required: false },
    },
  );
  expect(Object.keys(result.namespaces)).toEqual(["apple", "mango", "zebra"]);
});
