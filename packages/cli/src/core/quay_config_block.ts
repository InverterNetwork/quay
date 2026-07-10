// Pure parser for the `quay-config` fenced block carried in a Linear
// ticket body. Spec: docs/quay-spec-deployment-adapters.md §10.
//
// No I/O, no Linear or Slack calls — this is a function over a string.

import { QuayError } from "./errors.ts";
import { BASE_BRANCH_ERROR, isValidBaseBranchName } from "./base_branch.ts";
import { isTaskType, type TaskType } from "./task_type.ts";

export interface QuayConfigAuthor {
  name: string;
  slack_id: string;
}

export interface QuayConfigBlock {
  repo: string;
  base_branch: string | null;
  task_type: TaskType | null;
  tags: string[];
  worker_execution: "oneshot" | "goal";
  slack_thread_ref: string | null;
  authors: QuayConfigAuthor[];
  umbrella: QuayConfigUmbrella | null;
}

export interface QuayConfigUmbrella {
  external_ref: string;
  base_branch: string | null;
  feature_branch: string | null;
  depends_on: string[];
}

const FENCE_OPEN = /^[ \t]*```quay-config[ \t]*$/;
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/;
const SLACK_URL = /^https:\/\/[^.]+\.slack\.com\/archives\/([^/]+)\/p(\d+)$/;
const SLACK_USER_ID = /^U[A-Z0-9]+$/;
// Matches the `repo_id` charset accepted by the registry (src/core/repos/schema.ts).
// We deliberately do NOT narrow it (e.g. to `[a-z0-9-]+`): existing deployments
// register repos with uppercase, `.`, or `_`, and a stricter ticket charset
// would silently lock them out of ticket-supplied repos.
const REPO_ID = /^[A-Za-z0-9._-]+$/;
const KEY_VALUE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

interface FencedBlock {
  openLine: number;
  closeLine: number;
  content: string;
}

function findFencedBlocks(body: string): FencedBlock[] {
  // Normalize line endings so CRLF bodies match the fence regexes.
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (FENCE_OPEN.test(lines[i] ?? "")) {
      const openLine = i;
      i++;
      let closeLine = -1;
      while (i < lines.length) {
        if (FENCE_CLOSE.test(lines[i] ?? "")) {
          closeLine = i;
          i++;
          break;
        }
        i++;
      }
      if (closeLine === -1) {
        throw new QuayError(
          "ticket_block_invalid",
          "quay-config block: unterminated fence (opening ``` quay-config has no matching closing ```)",
          {
            detail:
              "unterminated fence (opening ``` quay-config has no matching closing ```)",
          },
        );
      }
      blocks.push({
        openLine,
        closeLine,
        content: lines.slice(openLine + 1, closeLine).join("\n"),
      });
    } else {
      i++;
    }
  }
  return blocks;
}

export function parseQuayConfigBlock(body: string): QuayConfigBlock | null {
  const blocks = findFencedBlocks(body);
  if (blocks.length === 0) return null;
  if (blocks.length > 1) {
    const detail =
      "multiple quay-config blocks found in ticket body; only one is permitted";
    throw new QuayError("ticket_block_invalid", detail, { detail });
  }
  const yaml = parseYaml(blocks[0]!.content);
  return validateBlock(yaml);
}

export function stripQuayConfigBlock(body: string): string {
  const blocks = findFencedBlocks(body);
  if (blocks.length === 0) return body;
  // Strip the first block's lines (open through close, inclusive). If the
  // parser already accepted the body, exactly one block exists; if more, the
  // parse path would have thrown — strip is downstream of parse.
  const { openLine, closeLine } = blocks[0]!;
  const lines = body.split("\n");
  return [...lines.slice(0, openLine), ...lines.slice(closeLine + 1)].join(
    "\n",
  );
}

export function setQuayConfigTaskType(body: string, taskType: TaskType): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = findFencedBlocks(normalized);
  if (blocks.length !== 1) return body;

  const lines = normalized.split("\n");
  const block = blocks[0]!;
  for (let i = block.openLine + 1; i < block.closeLine; i++) {
    if (/^[ \t]*task_type\s*:/.test(lines[i] ?? "")) {
      lines[i] = `task_type: ${taskType}`;
      return lines.join("\n");
    }
  }

  let insertAt = block.openLine + 1;
  for (let i = block.openLine + 1; i < block.closeLine; i++) {
    if (/^[ \t]*repo\s*:/.test(lines[i] ?? "")) {
      insertAt = i + 1;
      break;
    }
  }
  lines.splice(insertAt, 0, `task_type: ${taskType}`);
  return lines.join("\n");
}

// --- YAML parsing -------------------------------------------------------

type YamlScalar = string | null;
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

interface Token {
  indent: number;
  body: string;
  lineNo: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\s*$/.test(raw)) continue;
    if (/^\s*#/.test(raw)) continue;
    if (/^\t/.test(raw)) {
      throw yamlError(
        `tab indentation at line ${i + 1} (use spaces only)`,
      );
    }
    const m = /^([ ]*)(.*?)\s*$/.exec(raw)!;
    tokens.push({ indent: m[1]!.length, body: m[2]!, lineNo: i + 1 });
  }
  return tokens;
}

function yamlError(detail: string): QuayError {
  const full = `yaml parse: ${detail}`;
  return new QuayError("ticket_block_invalid", full, { detail: full });
}

function parseYaml(text: string): { [key: string]: YamlValue } {
  const tokens = tokenize(text);
  const out: { [key: string]: YamlValue } = {};
  let pos = 0;
  while (pos < tokens.length) {
    const t = tokens[pos]!;
    if (t.indent !== 0) {
      throw yamlError(`unexpected indent at line ${t.lineNo}`);
    }
    const m = KEY_VALUE.exec(t.body);
    if (!m) {
      throw yamlError(`expected "key: value" at line ${t.lineNo}`);
    }
    const key = m[1]!;
    const inline = m[2]!.trim();
    pos++;
    if (inline.length > 0) {
      out[key] = parseInlineValue(inline);
      continue;
    }
    // No inline value; look for a list or object continuation.
    if (pos < tokens.length && tokens[pos]!.indent > 0) {
      if (tokens[pos]!.body.startsWith("-")) {
        const result = parseList(tokens, pos);
        out[key] = result.value;
        pos = result.nextPos;
      } else {
        const result = parseObject(tokens, pos);
        out[key] = result.value;
        pos = result.nextPos;
      }
    } else {
      out[key] = null;
    }
  }
  return out;
}

function parseInlineValue(raw: string): YamlValue {
  // Flow-style empties.
  if (raw === "[]") return [];
  if (raw === "{}") return {};
  return unquoteScalar(raw);
}

function unquoteScalar(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

interface ListResult {
  value: YamlValue[];
  nextPos: number;
}

interface ObjectResult {
  value: { [key: string]: YamlValue };
  nextPos: number;
}

function parseObject(tokens: Token[], start: number): ObjectResult {
  const objectIndent = tokens[start]!.indent;
  const obj: { [key: string]: YamlValue } = {};
  let pos = start;
  while (
    pos < tokens.length &&
    tokens[pos]!.indent === objectIndent &&
    !tokens[pos]!.body.startsWith("-")
  ) {
    const t = tokens[pos]!;
    const m = KEY_VALUE.exec(t.body);
    if (!m) {
      throw yamlError(`expected "key: value" at line ${t.lineNo}`);
    }
    const key = m[1]!;
    const inline = m[2]!.trim();
    pos++;
    if (inline.length > 0) {
      obj[key] = parseInlineValue(inline);
      continue;
    }
    if (pos < tokens.length && tokens[pos]!.indent > objectIndent) {
      if (tokens[pos]!.body.startsWith("-")) {
        const result = parseList(tokens, pos);
        obj[key] = result.value;
        pos = result.nextPos;
      } else {
        const result = parseObject(tokens, pos);
        obj[key] = result.value;
        pos = result.nextPos;
      }
    } else {
      obj[key] = null;
    }
  }
  return { value: obj, nextPos: pos };
}

function parseList(tokens: Token[], start: number): ListResult {
  const listIndent = tokens[start]!.indent;
  const items: YamlValue[] = [];
  let pos = start;
  while (
    pos < tokens.length &&
    tokens[pos]!.indent === listIndent &&
    tokens[pos]!.body.startsWith("-")
  ) {
    const t = tokens[pos]!;
    const dashMatch = /^-(?:\s+(.*))?$/.exec(t.body);
    if (!dashMatch) {
      throw yamlError(`malformed list item at line ${t.lineNo}`);
    }
    const inline = (dashMatch[1] ?? "").trim();
    pos++;
    if (inline.length === 0) {
      items.push(null);
      continue;
    }
    const kv = KEY_VALUE.exec(inline);
    if (!kv) {
      items.push(parseInlineValue(inline));
      continue;
    }
    // Object list item. Continuation lines at indent > listIndent that don't
    // start a new list item belong to this object.
    const obj: { [key: string]: YamlValue } = {};
    const fk = kv[1]!;
    const fv = kv[2]!.trim();
    obj[fk] = fv.length > 0 ? parseInlineValue(fv) : null;
    let contIndent: number | null = null;
    while (pos < tokens.length) {
      const nt = tokens[pos]!;
      if (nt.indent <= listIndent) break;
      if (nt.body.startsWith("-")) break;
      if (contIndent === null) {
        contIndent = nt.indent;
      } else if (nt.indent !== contIndent) {
        throw yamlError(
          `inconsistent indent at line ${nt.lineNo} (expected ${contIndent}, got ${nt.indent})`,
        );
      }
      const fm = KEY_VALUE.exec(nt.body);
      if (!fm) {
        throw yamlError(`expected "key: value" at line ${nt.lineNo}`);
      }
      const ck = fm[1]!;
      const cv = fm[2]!.trim();
      obj[ck] = cv.length > 0 ? parseInlineValue(cv) : null;
      pos++;
    }
    items.push(obj);
  }
  return { value: items, nextPos: pos };
}

// --- Type validation ----------------------------------------------------

function blockError(detail: string): QuayError {
  return new QuayError(
    "ticket_block_invalid",
    `quay-config block: ${detail}`,
    { detail },
  );
}

function isPlainObject(
  v: unknown,
): v is { [key: string]: YamlValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateBlock(yaml: { [key: string]: YamlValue }): QuayConfigBlock {
  // repo (required)
  if (!("repo" in yaml) || yaml.repo === null) {
    throw blockError("repo is required");
  }
  const rawRepo = yaml.repo;
  if (typeof rawRepo !== "string" || rawRepo.length === 0) {
    throw blockError("repo must be a non-empty string");
  }
  if (!REPO_ID.test(rawRepo) || rawRepo === "." || rawRepo === "..") {
    // Mirrors src/core/repos/schema.ts: charset [A-Za-z0-9._-]+, no
    // path-traversal sentinels. Deliberately does not duplicate the registry's
    // existence check here — that lives in the enqueue path, where a missing
    // repo surfaces as a clear `repo_not_registered` error rather than a parse
    // failure.
    throw blockError(
      "repo must match [A-Za-z0-9._-]+ and cannot be '.' or '..'",
    );
  }
  const repo = rawRepo;

  let task_type: TaskType | null = null;
  if ("task_type" in yaml && yaml.task_type !== null && yaml.task_type !== undefined) {
    const raw = yaml.task_type;
    if (!isTaskType(raw)) {
      throw blockError("task_type must be bugfix, feature, chore, or refactor");
    }
    task_type = raw;
  }

  // base_branch (optional task-level override)
  let base_branch: string | null = null;
  if (
    "base_branch" in yaml &&
    yaml.base_branch !== null &&
    yaml.base_branch !== undefined
  ) {
    const raw = yaml.base_branch;
    if (typeof raw !== "string" || raw.length === 0) {
      throw blockError("base_branch must be a non-empty string");
    }
    if (!isValidBaseBranchName(raw)) {
      throw blockError(BASE_BRANCH_ERROR);
    }
    base_branch = raw;
  }

  // tags
  const rawTags = yaml.tags;
  if (!Array.isArray(rawTags)) {
    throw blockError("tags must be a list of strings");
  }
  const tags: string[] = [];
  for (let i = 0; i < rawTags.length; i++) {
    const v = rawTags[i];
    if (typeof v !== "string") {
      throw blockError(`tags[${i}] must be a string`);
    }
    tags.push(v);
  }

  let worker_execution: "oneshot" | "goal" = "oneshot";
  if (
    "worker_execution" in yaml &&
    yaml.worker_execution !== null &&
    yaml.worker_execution !== undefined
  ) {
    const raw = yaml.worker_execution;
    if (raw !== "oneshot" && raw !== "goal") {
      throw blockError("worker_execution must be oneshot or goal");
    }
    worker_execution = raw;
  }

  // slack_thread (optional)
  let slack_thread_ref: string | null = null;
  if (
    "slack_thread" in yaml &&
    yaml.slack_thread !== null &&
    yaml.slack_thread !== undefined
  ) {
    const raw = yaml.slack_thread;
    if (typeof raw !== "string") {
      throw blockError("slack_thread must be a string URL");
    }
    const m = SLACK_URL.exec(raw);
    if (!m) {
      throw blockError("slack_thread URL malformed");
    }
    const channel = m[1]!;
    const digits = m[2]!;
    if (digits.length < 11) {
      throw blockError("slack_thread URL malformed");
    }
    const tsHead = digits.slice(0, 10);
    const tsTail = digits.slice(10);
    slack_thread_ref = `${channel}:${tsHead}.${tsTail}`;
  }

  // authors (required, non-empty)
  if (!("authors" in yaml)) {
    throw blockError("authors is required");
  }
  const rawAuthors = yaml.authors;
  if (!Array.isArray(rawAuthors)) {
    throw blockError("authors must be a list of {name, slack_id}");
  }
  if (rawAuthors.length === 0) {
    throw blockError("authors must have at least one entry");
  }
  const authors: QuayConfigAuthor[] = [];
  for (let i = 0; i < rawAuthors.length; i++) {
    const a = rawAuthors[i];
    if (!isPlainObject(a)) {
      throw blockError(`authors[${i}] must be {name, slack_id}`);
    }
    const name = a.name;
    const slack_id = a.slack_id;
    if (typeof name !== "string") {
      throw blockError(`authors[${i}].name must be a string`);
    }
    if (typeof slack_id !== "string") {
      throw blockError(`authors[${i}].slack_id must be a string`);
    }
    if (!SLACK_USER_ID.test(slack_id)) {
      throw blockError(
        `authors[${i}].slack_id must be a bare Slack user ID like U06TDC56VJB`,
      );
    }
    authors.push({ name, slack_id });
  }

  const umbrella = parseUmbrella(yaml);

  return {
    repo,
    base_branch,
    task_type,
    tags,
    worker_execution,
    slack_thread_ref,
    authors,
    umbrella,
  };
}

function parseUmbrella(yaml: { [key: string]: YamlValue }): QuayConfigUmbrella | null {
  if (!("umbrella" in yaml) || yaml.umbrella === null || yaml.umbrella === undefined) {
    return null;
  }
  const rawUmbrella = yaml.umbrella;
  if (!isPlainObject(rawUmbrella)) {
    throw blockError("umbrella must be an object");
  }
  const rawExternalRef = rawUmbrella.external_ref;
  if (typeof rawExternalRef !== "string" || rawExternalRef.length === 0) {
    throw blockError("umbrella.external_ref must be a non-empty string");
  }

  let base_branch: string | null = null;
  if (
    rawUmbrella.base_branch !== null &&
    rawUmbrella.base_branch !== undefined
  ) {
    const raw = rawUmbrella.base_branch;
    if (typeof raw !== "string" || raw.length === 0) {
      throw blockError("umbrella.base_branch must be a non-empty string");
    }
    if (!isValidBaseBranchName(raw)) {
      throw blockError(`umbrella.${BASE_BRANCH_ERROR}`);
    }
    base_branch = raw;
  }

  let feature_branch: string | null = null;
  if (
    rawUmbrella.feature_branch !== null &&
    rawUmbrella.feature_branch !== undefined
  ) {
    const raw = rawUmbrella.feature_branch;
    if (typeof raw !== "string" || raw.length === 0) {
      throw blockError("umbrella.feature_branch must be a non-empty string");
    }
    if (!isValidBaseBranchName(raw)) {
      throw blockError(`umbrella.feature_branch ${BASE_BRANCH_ERROR}`);
    }
    feature_branch = raw;
  }

  const rawDependsOn = rawUmbrella.depends_on ?? [];
  if (!Array.isArray(rawDependsOn)) {
    throw blockError("umbrella.depends_on must be a list of strings");
  }
  const depends_on: string[] = [];
  for (let i = 0; i < rawDependsOn.length; i++) {
    const v = rawDependsOn[i];
    if (typeof v !== "string" || v.length === 0) {
      throw blockError(`umbrella.depends_on[${i}] must be a non-empty string`);
    }
    depends_on.push(v.toUpperCase());
  }

  return {
    external_ref: rawExternalRef.toUpperCase(),
    base_branch,
    feature_branch,
    depends_on,
  };
}
