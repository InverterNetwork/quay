import { test, expect } from "bun:test";
import { parseImportToml, planImport } from "../../../src/core/tags/import_toml.ts";
import { QuayError } from "../../../src/core/errors.ts";

test("valid TOML round-trip: parses values and required", () => {
  const toml = `
[tags.namespaces.area]
values = ["bonding-curve", "vesting"]
required = true

[tags.namespaces.risk]
values = ["reentrancy"]
`;
  const result = parseImportToml(toml);
  expect(result["area"]).toEqual({ values: ["bonding-curve", "vesting"], required: true });
  expect(result["risk"]).toEqual({ values: ["reentrancy"] });
});

test("missing [tags.namespaces] section returns empty object", () => {
  const toml = `
[other]
key = "value"
`;
  expect(parseImportToml(toml)).toEqual({});
});

test("completely empty TOML returns empty object", () => {
  expect(parseImportToml("")).toEqual({});
});

test("[tags] present but no namespaces key returns empty object", () => {
  const toml = `
[tags]
version = 1
`;
  expect(parseImportToml(toml)).toEqual({});
});

test("missing values key throws validation_error", () => {
  const toml = `
[tags.namespaces.area]
required = true
`;
  let caught: unknown;
  try {
    parseImportToml(toml);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
});

test("non-string element in values throws validation_error", () => {
  const toml = `
[tags.namespaces.area]
values = ["ok", 42]
`;
  let caught: unknown;
  try {
    parseImportToml(toml);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
});

test("non-boolean required throws validation_error", () => {
  const toml = `
[tags.namespaces.area]
values = ["ok"]
required = "yes"
`;
  let caught: unknown;
  try {
    parseImportToml(toml);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
});

test("unknown extra key in namespace spec throws validation_error", () => {
  const toml = `
[tags.namespaces.area]
values = ["ok"]
extra = true
`;
  let caught: unknown;
  try {
    parseImportToml(toml);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
});

test("syntactically invalid TOML throws validation_error", () => {
  let caught: unknown;
  try {
    parseImportToml("[tags.namespaces.area\nvalues = [\n");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
});

test("duplicate values in TOML are deduped on parse", () => {
  const result = parseImportToml(`
[tags.namespaces.area]
values = ["x", "x", "y"]
`);
  expect(result["area"]?.values).toEqual(["x", "y"]);
});

test("[tags] as a non-table throws validation_error", () => {
  const toml = `tags = "oops"\n`;
  let caught: unknown;
  try {
    parseImportToml(toml);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
});

test("[tags.namespaces] as a non-table throws validation_error", () => {
  const toml = `
[tags]
namespaces = "oops"
`;
  let caught: unknown;
  try {
    parseImportToml(toml);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
});

test("required namespace with empty values throws validation_error", () => {
  // The unsatisfiable shape: a TOML import that flags a namespace required
  // but provides no values would brick validation for every consumer.
  const toml = `
[tags.namespaces.area]
values = []
required = true
`;
  let caught: unknown;
  try {
    parseImportToml(toml);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("validation_error");
});

test("non-required namespace with empty values is accepted (a no-op clear)", () => {
  const toml = `
[tags.namespaces.area]
values = []
`;
  expect(parseImportToml(toml)).toEqual({ area: { values: [] } });
});

test("planImport: same desired vs current is a noop", () => {
  const desired = { area: { values: ["bonding-curve", "vesting"], required: true } };
  const current = { area: { values: ["bonding-curve", "vesting"], required: true } };
  const plan = planImport(desired, current);
  expect(plan.isNoop).toBe(true);
  expect(plan.needsForce).toBe(false);
});

test("planImport: different desired, current empty → not noop, no force needed", () => {
  const desired = { area: { values: ["bonding-curve"] } };
  const plan = planImport(desired, {});
  expect(plan.isNoop).toBe(false);
  expect(plan.needsForce).toBe(false);
});

test("planImport: different desired, current non-empty → not noop, force needed", () => {
  const desired = { area: { values: ["vesting"] } };
  const current = { area: { values: ["bonding-curve"], required: false } };
  const plan = planImport(desired, current);
  expect(plan.isNoop).toBe(false);
  expect(plan.needsForce).toBe(true);
});

test("planImport: canonicalization — value order in input does not affect isNoop", () => {
  const desired = { area: { values: ["vesting", "bonding-curve"] } };
  const current = { area: { values: ["bonding-curve", "vesting"], required: false } };
  const plan = planImport(desired, current);
  expect(plan.isNoop).toBe(true);
});

test("planImport: missing required defaults to false for comparison", () => {
  const desired = { area: { values: ["val"] } };
  const current = { area: { values: ["val"], required: false } };
  const plan = planImport(desired, current);
  expect(plan.isNoop).toBe(true);
});

test("planImport: both empty is a noop", () => {
  const plan = planImport({}, {});
  expect(plan.isNoop).toBe(true);
  expect(plan.needsForce).toBe(false);
});
