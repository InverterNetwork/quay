import { test, expect } from "bun:test";
import {
  parseTagToken,
  validateTagVocab,
} from "../../src/validator/validate_tag_vocab.ts";
import type { MergedVocab } from "../../src/core/tags/merge.ts";

test("parseTagToken: split on first dash", () => {
  expect(parseTagToken("area-bonding-curve")).toEqual({
    namespace: "area",
    value: "bonding-curve",
  });
});

test("parseTagToken: simple two-part tag", () => {
  expect(parseTagToken("risk-reentrancy")).toEqual({
    namespace: "risk",
    value: "reentrancy",
  });
});

test("parseTagToken: no dash returns null", () => {
  expect(parseTagToken("orphan")).toBeNull();
});

test("parseTagToken: leading dash returns null", () => {
  expect(parseTagToken("-value")).toBeNull();
});

test("parseTagToken: trailing dash returns null", () => {
  expect(parseTagToken("namespace-")).toBeNull();
});

test("parseTagToken: empty string returns null", () => {
  expect(parseTagToken("")).toBeNull();
});

function vocab(spec: Record<string, { values: string[]; required?: boolean }>): MergedVocab {
  const namespaces: MergedVocab["namespaces"] = {};
  for (const [k, v] of Object.entries(spec)) {
    namespaces[k] = { values: v.values, required: v.required ?? false };
  }
  return { namespaces, enforced: true };
}

test("validateTagVocab: all tags match → no errors", () => {
  const errors = validateTagVocab(
    ["area-bonding-curve", "risk-reentrancy"],
    vocab({
      area: { values: ["bonding-curve", "vesting"] },
      risk: { values: ["reentrancy"] },
    }),
  );
  expect(errors).toEqual([]);
});

test("validateTagVocab: unparseable tag → TAG_UNKNOWN_NAMESPACE", () => {
  const errors = validateTagVocab(
    ["orphan"],
    vocab({ area: { values: ["bonding-curve"] } }),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.code).toBe("TAG_UNKNOWN_NAMESPACE");
  expect(errors[0]?.field).toBe("tags[0]");
});

test("validateTagVocab: tag with unknown namespace → TAG_UNKNOWN_NAMESPACE", () => {
  const errors = validateTagVocab(
    ["nonsense-thing"],
    vocab({ area: { values: ["bonding-curve"] } }),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.code).toBe("TAG_UNKNOWN_NAMESPACE");
});

test("validateTagVocab: tag with known namespace + unknown value → TAG_UNKNOWN_VALUE", () => {
  const errors = validateTagVocab(
    ["area-vesting"],
    vocab({ area: { values: ["bonding-curve"] } }),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.code).toBe("TAG_UNKNOWN_VALUE");
  expect(errors[0]?.field).toBe("tags[0]");
});

test("validateTagVocab: required namespace satisfied → no error", () => {
  const errors = validateTagVocab(
    ["area-bonding-curve"],
    vocab({ area: { values: ["bonding-curve"], required: true } }),
  );
  expect(errors).toEqual([]);
});

test("validateTagVocab: required namespace missing → TAG_REQUIRED_MISSING", () => {
  const errors = validateTagVocab(
    ["risk-reentrancy"],
    vocab({
      area: { values: ["bonding-curve"], required: true },
      risk: { values: ["reentrancy"] },
    }),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.code).toBe("TAG_REQUIRED_MISSING");
  expect(errors[0]?.field).toBe("tags");
  expect(errors[0]?.message).toContain("area");
});

test("validateTagVocab: empty tag list and required namespace → TAG_REQUIRED_MISSING", () => {
  const errors = validateTagVocab(
    [],
    vocab({ area: { values: ["x"], required: true } }),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.code).toBe("TAG_REQUIRED_MISSING");
});

test("validateTagVocab: value may contain dashes; only namespace is the prefix before the first dash", () => {
  // Namespaces are forbidden from containing dashes (enforced by tag-service
  // labelSchema), so the value side is the only multi-segment piece. Tag
  // `risk-money-handling` parses as namespace=risk, value=money-handling.
  const errors = validateTagVocab(
    ["risk-money-handling"],
    vocab({ risk: { values: ["money-handling"] } }),
  );
  expect(errors).toEqual([]);
});

test("validateTagVocab: collects errors per tag, keeps required check at the end", () => {
  const errors = validateTagVocab(
    ["bogus", "area-unknown"],
    vocab({
      area: { values: ["bonding-curve"], required: true },
      risk: { values: ["reentrancy"], required: true },
    }),
  );
  const codes = errors.map((e) => e.code);
  expect(codes).toContain("TAG_UNKNOWN_NAMESPACE");
  expect(codes).toContain("TAG_UNKNOWN_VALUE");
  expect(codes.filter((c) => c === "TAG_REQUIRED_MISSING")).toHaveLength(2);
});

test("validateTagVocab: non-required namespaces don't trigger required errors when absent", () => {
  const errors = validateTagVocab(
    [],
    vocab({ area: { values: ["x"] }, risk: { values: ["y"] } }),
  );
  expect(errors).toEqual([]);
});

test("validateTagVocab: required-missing errors are emitted in sorted namespace order", () => {
  const errors = validateTagVocab(
    [],
    vocab({
      zeta: { values: ["x"], required: true },
      alpha: { values: ["y"], required: true },
      mu: { values: ["z"], required: true },
    }),
  );
  const fields = errors.map((e) => e.message);
  expect(fields[0]).toContain("alpha");
  expect(fields[1]).toContain("mu");
  expect(fields[2]).toContain("zeta");
});
