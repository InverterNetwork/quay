// Resolver contract: `(repo_id, role) → { agent, invocation }` with
// per-repo overrides winning over deployment defaults, and a legacy
// `agent_invocation =` config key folded into the synthetic claude
// entry so unmodified deployments keep working.

import { afterEach, expect, test } from "bun:test";
import {
  buildAgentSelection,
  createAgentResolver,
  validateAgentSelection,
  DEFAULT_AGENT_NAME,
  DEFAULT_CLAUDE_REVIEWER_INVOCATION,
  DEFAULT_CLAUDE_WORKER_INVOCATION,
} from "../../src/core/agents.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("empty config seeds the built-in claude defaults for both roles", () => {
  const sel = buildAgentSelection({});
  expect(sel.defaults).toEqual({ worker: "claude", reviewer: "claude" });
  expect(sel.invocations.claude!.worker).toBe(DEFAULT_CLAUDE_WORKER_INVOCATION);
  expect(sel.invocations.claude!.reviewer).toBe(
    DEFAULT_CLAUDE_REVIEWER_INVOCATION,
  );
});

test("legacy agent_invocation folds into the claude entry for both roles", () => {
  const sel = buildAgentSelection({ agent_invocation: "claude --custom" });
  expect(sel.invocations.claude!.worker).toBe("claude --custom");
  expect(sel.invocations.claude!.reviewer).toBe("claude --custom");
});

test("explicit [agents.invocations.claude] wins over legacy agent_invocation per role", () => {
  const sel = buildAgentSelection({
    agent_invocation: "claude --legacy",
    agents: {
      invocations: {
        claude: { worker: "claude --explicit-worker" },
      },
    },
  });
  // Worker comes from the explicit block; reviewer falls back to legacy
  // because the explicit block didn't set a reviewer.
  expect(sel.invocations.claude!.worker).toBe("claude --explicit-worker");
  expect(sel.invocations.claude!.reviewer).toBe("claude --legacy");
});

test("resolver uses repo override over deployment default for worker only", () => {
  h = createHarness();
  insertRepo(h.db, "repo-codex-worker");
  h.db
    .query(`UPDATE repos SET agent_worker = ?, agent_reviewer = NULL WHERE repo_id = ?`)
    .run("codex", "repo-codex-worker");

  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "claude",
        reviewer: "claude",
        invocations: {
          claude: {
            worker: "claude --worker",
            reviewer: "claude --reviewer",
          },
          codex: {
            worker: "codex exec",
            reviewer: "codex exec --review",
          },
        },
      },
    },
  });

  const worker = resolver.resolve("repo-codex-worker", "worker");
  expect(worker.agent).toBe("codex");
  expect(worker.invocation).toBe("codex exec");

  const reviewer = resolver.resolve("repo-codex-worker", "reviewer");
  expect(reviewer.agent).toBe("claude");
  expect(reviewer.invocation).toBe("claude --reviewer");
});

test("resolver applies task snapshot over repo and global role defaults", () => {
  h = createHarness();
  insertRepo(h.db, "repo-snapshot");
  h.db
    .query(`UPDATE repos SET agent_worker = ?, model_worker = ? WHERE repo_id = ?`)
    .run("claude", "repo-model", "repo-snapshot");

  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "codex",
        worker_model: "global-model",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "codex exec", reviewer: "codex exec --review" },
        },
      },
    },
  });

  const resolved = resolver.resolve("repo-snapshot", "worker", {
    agent: "codex",
    model: "task-model",
  });
  expect(resolved.agent).toBe("codex");
  expect(resolved.model).toBe("task-model");
  expect(resolved.invocation).toBe("codex exec --model 'task-model'");
});

test("resolver uses repo model over global model when task snapshot is empty", () => {
  h = createHarness();
  insertRepo(h.db, "repo-model-default");
  h.db
    .query(`UPDATE repos SET model_reviewer = ? WHERE repo_id = ?`)
    .run("repo-reviewer-model", "repo-model-default");

  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        reviewer_model: "global-reviewer-model",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
        },
      },
    },
  });

  const resolved = resolver.resolve("repo-model-default", "reviewer");
  expect(resolved.agent).toBe("claude");
  expect(resolved.model).toBe("repo-reviewer-model");
  expect(resolved.invocation).toBe("claude --r --model 'repo-reviewer-model'");
});

test("resolver mix-and-match: claude worker with codex reviewer", () => {
  h = createHarness();
  insertRepo(h.db, "repo-mixed");
  h.db
    .query(`UPDATE repos SET agent_worker = ?, agent_reviewer = ? WHERE repo_id = ?`)
    .run("claude", "codex", "repo-mixed");

  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "codex",
        reviewer: "codex",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "codex --w", reviewer: "codex --r" },
        },
      },
    },
  });

  expect(resolver.resolve("repo-mixed", "worker").agent).toBe("claude");
  expect(resolver.resolve("repo-mixed", "reviewer").agent).toBe("codex");
});

test("resolver throws when the repo override names an unregistered agent", () => {
  h = createHarness();
  insertRepo(h.db, "repo-orphan");
  h.db
    .query(`UPDATE repos SET agent_worker = ? WHERE repo_id = ?`)
    .run("removed-runtime", "repo-orphan");

  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
        },
      },
    },
  });

  expect(() => resolver.resolve("repo-orphan", "worker")).toThrow(
    /removed-runtime/,
  );
});

test("createAgentResolver fails at boot when [agents].worker names an unregistered entry", () => {
  const harness = createHarness();
  h = harness;
  // Worker default points at "codex" but no [agents.invocations.codex]
  // block was registered. Without the eager check this would only blow
  // up when the first queued task tried to spawn; with it, the
  // production CLI fails the moment config is loaded.
  expect(() =>
    createAgentResolver({
      db: harness.db,
      config: {
        agents: {
          worker: "codex",
          invocations: {
            claude: { worker: "claude --w", reviewer: "claude --r" },
          },
        },
      },
    }),
  ).toThrow(/codex/);
});

test("validateAgentSelection flags a registered entry that's missing the chosen role", () => {
  // Defaults say "use codex for the reviewer," but the codex entry
  // only set `worker = ...`. Same boot-time failure shape.
  expect(() =>
    validateAgentSelection({
      defaults: { worker: "claude", reviewer: "codex" },
      invocations: {
        claude: {
          worker: DEFAULT_CLAUDE_WORKER_INVOCATION,
          reviewer: DEFAULT_CLAUDE_REVIEWER_INVOCATION,
        },
        codex: { worker: "codex --w" },
      },
    }),
  ).toThrow(/reviewer/);
});

test("resolver leaves hermes invocations untouched when a model is configured", () => {
  // Hermes-backed Codex selects the model through Hermes' own YAML
  // config; appending `--model <x>` would be passed as a hermes CLI
  // flag and fail. The resolved model still rides on the attempt row
  // for attribution.
  h = createHarness();
  insertRepo(h.db, "repo-hermes");

  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "hermes_codex",
        worker_model: "gpt-5.1-codex",
        invocations: {
          hermes_codex: {
            worker:
              "hermes chat --quiet --query-file {prompt_file} --toolsets file,terminal",
          },
        },
      },
    },
  });

  const resolved = resolver.resolve("repo-hermes", "worker");
  expect(resolved.agent).toBe("hermes_codex");
  expect(resolved.model).toBe("gpt-5.1-codex");
  expect(resolved.invocation).toBe(
    "hermes chat --quiet --query-file {prompt_file} --toolsets file,terminal",
  );
});

test("resolver treats any hermes_-prefixed agent as model-flag-skipping", () => {
  // The browser variant is a separate registered invocation but should
  // follow the same "Hermes owns model selection" rule.
  h = createHarness();
  insertRepo(h.db, "repo-hermes-browser");
  h.db
    .query(`UPDATE repos SET agent_worker = ? WHERE repo_id = ?`)
    .run("hermes_codex_browser", "repo-hermes-browser");

  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "claude",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          hermes_codex_browser: {
            worker:
              "hermes chat --quiet --query-file {prompt_file} --toolsets file,terminal,browser,vision",
          },
        },
      },
    },
  });

  const resolved = resolver.resolve("repo-hermes-browser", "worker", {
    agent: "hermes_codex_browser",
    model: "gpt-5.1-codex",
  });
  expect(resolved.agent).toBe("hermes_codex_browser");
  expect(resolved.invocation).toBe(
    "hermes chat --quiet --query-file {prompt_file} --toolsets file,terminal,browser,vision",
  );
});

test("registeredAgents lists every entry under [agents.invocations] plus the seeded claude", () => {
  h = createHarness();
  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        invocations: {
          codex: { worker: "codex --w", reviewer: "codex --r" },
        },
      },
    },
  });
  expect(resolver.registeredAgents()).toEqual([DEFAULT_AGENT_NAME, "codex"]);
});
