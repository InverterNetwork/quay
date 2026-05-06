// Tests for the `quay-config` fenced-block parser.
// Spec: docs/quay-spec-deployment-adapters.md §10.
//
// Test names match docs/ralph/slice-13.md exactly — the slice gate
// enforces those names verbatim.

import { expect, test } from "bun:test";
import {
  parseQuayConfigBlock,
  stripQuayConfigBlock,
} from "../../src/core/quay_config_block.ts";
import { QuayError } from "../../src/core/errors.ts";

const FENCE = "```";

function block(inner: string): string {
  return `${FENCE}quay-config\n${inner}\n${FENCE}`;
}

function expectBlockInvalid(fn: () => unknown): QuayError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("ticket_block_invalid");
  return err;
}

test("test_quay_config_block_parses_tags_and_slack_thread", () => {
  const body = `Some preamble.

${block(
  [
    "tags:",
    "  - auth-session",
    "  - cache",
    "slack_thread: https://inverter.slack.com/archives/C0123ABC/p1700000123000001",
    "authors:",
    "  - name: Fabian Scherer",
    "    slack_id: U06TDC56VJB",
  ].join("\n"),
)}

Trailing prose.`;

  const parsed = parseQuayConfigBlock(body);
  expect(parsed).not.toBeNull();
  expect(parsed!.tags).toEqual(["auth-session", "cache"]);
  expect(parsed!.slack_thread_ref).toBe("C0123ABC:1700000123.000001");
  expect(parsed!.authors).toEqual([
    { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
  ]);
});

test("test_quay_config_block_returns_null_when_block_missing", () => {
  const body = `## Context

A normal Linear ticket body with no quay-config fence at all.

\`\`\`bash
some unrelated code block
\`\`\`
`;
  expect(parseQuayConfigBlock(body)).toBeNull();
});

test("test_quay_config_block_errors_on_malformed_yaml", () => {
  const body = block(
    [
      ":::!!! this is not yaml",
      "tags:",
      "  - foo",
    ].join("\n"),
  );
  const err = expectBlockInvalid(() => parseQuayConfigBlock(body));
  expect(err.details?.detail).toMatch(/yaml parse/);
});

test("test_quay_config_block_errors_on_unknown_required_field_type", () => {
  // `tags` is a scalar string, not a list; `slack_thread` is not a string
  // would also be malformed but tags-not-a-list is enough to trip the check
  // and is the simpler case to construct in YAML.
  const body = block(
    [
      "tags: just-a-string",
      "authors:",
      "  - name: A",
      "    slack_id: U001",
    ].join("\n"),
  );
  expectBlockInvalid(() => parseQuayConfigBlock(body));
});

test("test_quay_config_block_ignores_unknown_keys", () => {
  // `preamble_override` is a forward-compat field; the parser should accept
  // it without complaining and ignore the value.
  const body = block(
    [
      "preamble_override: some-future-thing",
      "tags:",
      "  - foo",
      "authors:",
      "  - name: A",
      "    slack_id: U001",
    ].join("\n"),
  );
  const parsed = parseQuayConfigBlock(body);
  expect(parsed).not.toBeNull();
  expect(parsed!.tags).toEqual(["foo"]);
  expect(parsed!.authors).toEqual([{ name: "A", slack_id: "U001" }]);
  // The block type does not surface unknown keys.
  expect(Object.keys(parsed!).sort()).toEqual(
    ["authors", "slack_thread_ref", "tags"].sort(),
  );
});

test("test_quay_config_block_decodes_slack_p_format_correctly", () => {
  const body = block(
    [
      "tags:",
      "  - foo",
      "slack_thread: https://inverter.slack.com/archives/C0123ABC/p1700000123000001",
      "authors:",
      "  - name: A",
      "    slack_id: U001",
    ].join("\n"),
  );
  const parsed = parseQuayConfigBlock(body);
  expect(parsed!.slack_thread_ref).toBe("C0123ABC:1700000123.000001");
});

test("test_quay_config_block_errors_on_malformed_slack_url", () => {
  const body = block(
    [
      "tags:",
      "  - foo",
      "slack_thread: https://example.com/not-slack",
      "authors:",
      "  - name: A",
      "    slack_id: U001",
    ].join("\n"),
  );
  const err = expectBlockInvalid(() => parseQuayConfigBlock(body));
  expect(err.details?.detail).toBe("slack_thread URL malformed");
});

test("test_quay_config_block_rejects_duplicate_blocks", () => {
  const inner = [
    "tags:",
    "  - foo",
    "authors:",
    "  - name: A",
    "    slack_id: U001",
  ].join("\n");
  const body = `${block(inner)}\n\nSome prose.\n\n${block(inner)}`;
  const err = expectBlockInvalid(() => parseQuayConfigBlock(body));
  expect(err.details?.detail).toMatch(/multiple quay-config blocks/);
});

test("test_quay_config_block_strips_from_brief", () => {
  const original = `## Context

Some context text.

${block(
  [
    "tags:",
    "  - foo",
    "authors:",
    "  - name: A",
    "    slack_id: U001",
  ].join("\n"),
)}

## Acceptance Criteria

- Do the thing.
`;
  const stripped = stripQuayConfigBlock(original);
  expect(stripped).not.toContain("quay-config");
  expect(stripped).not.toContain("slack_id");
  expect(stripped).toContain("## Context");
  expect(stripped).toContain("## Acceptance Criteria");
  // Original retained for archival callers.
  expect(original).toContain("```quay-config");
});

test("test_quay_config_block_parses_authors_in_order", () => {
  const body = block(
    [
      "tags:",
      "  - foo",
      "authors:",
      "  - name: A",
      "    slack_id: U001",
      "  - name: B",
      "    slack_id: U002",
      "  - name: C",
      "    slack_id: U003",
    ].join("\n"),
  );
  const parsed = parseQuayConfigBlock(body);
  expect(parsed!.authors).toEqual([
    { name: "A", slack_id: "U001" },
    { name: "B", slack_id: "U002" },
    { name: "C", slack_id: "U003" },
  ]);
});

test("test_quay_config_block_errors_on_empty_authors", () => {
  const body = block(
    [
      "tags:",
      "  - foo",
      "authors: []",
    ].join("\n"),
  );
  expectBlockInvalid(() => parseQuayConfigBlock(body));
});

test("test_quay_config_block_errors_on_malformed_slack_id", () => {
  const body = block(
    [
      "tags:",
      "  - foo",
      "authors:",
      '  - name: Fabian',
      '    slack_id: "@fabian"',
    ].join("\n"),
  );
  const err = expectBlockInvalid(() => parseQuayConfigBlock(body));
  expect(err.details?.detail).toMatch(/authors\[0\]\.slack_id/);
});

test("test_quay_config_block_errors_on_missing_authors", () => {
  const body = block(
    [
      "tags:",
      "  - foo",
      "slack_thread: https://inverter.slack.com/archives/C0123ABC/p1700000123000001",
    ].join("\n"),
  );
  expectBlockInvalid(() => parseQuayConfigBlock(body));
});

test("test_quay_config_block_parses_crlf_body", () => {
  // A body transmitted with CRLF line endings must parse identically to the
  // equivalent LF body — the fence regexes must not be silently bypassed.
  const lfBody = block(
    [
      "tags:",
      "  - auth-session",
      "authors:",
      "  - name: Fabian Scherer",
      "    slack_id: U06TDC56VJB",
    ].join("\n"),
  );
  const crlfBody = lfBody.replace(/\n/g, "\r\n");
  const parsed = parseQuayConfigBlock(crlfBody);
  expect(parsed).not.toBeNull();
  expect(parsed!.tags).toEqual(["auth-session"]);
  expect(parsed!.authors).toEqual([
    { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
  ]);
});

test("test_quay_config_block_errors_on_unterminated_fence", () => {
  // An opening fence with no matching closing fence is invalid, not absent.
  const body = "```quay-config\ntags:\n  - foo\nauthors:\n  - name: A\n    slack_id: U001\n";
  const err = expectBlockInvalid(() => parseQuayConfigBlock(body));
  expect(err.details?.detail).toMatch(/unterminated fence/);
});

test("test_quay_config_block_errors_on_valid_block_followed_by_unterminated_fence", () => {
  // A correctly closed block followed by an unterminated opener must also
  // error — the unterminated opener is invalid, so the body as a whole is.
  const inner = [
    "tags:",
    "  - foo",
    "authors:",
    "  - name: A",
    "    slack_id: U001",
  ].join("\n");
  const body = `${block(inner)}\n\nSome prose.\n\n\`\`\`quay-config\ntags:\n  - bar\n`;
  const err = expectBlockInvalid(() => parseQuayConfigBlock(body));
  expect(err.details?.detail).toMatch(/unterminated fence/);
});

test("test_quay_config_block_parses_bare_cr_body", () => {
  // Bodies with lone CR line endings (classic Mac) must also parse correctly.
  const lfBody = block(
    [
      "tags:",
      "  - foo",
      "authors:",
      "  - name: A",
      "    slack_id: U001",
    ].join("\n"),
  );
  const crBody = lfBody.replace(/\n/g, "\r");
  const parsed = parseQuayConfigBlock(crBody);
  expect(parsed).not.toBeNull();
  expect(parsed!.tags).toEqual(["foo"]);
});
