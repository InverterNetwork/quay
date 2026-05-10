#!/usr/bin/env bun
// Standalone child-process entry for `quay validate-ticket`. Adapters spec
// §11 requires `enqueue --linear-issue` to invoke the validator as a
// subprocess; this thin entry skips the dispatcher's adapter wiring (slack,
// linear, github, tmux, …) so the spawn stays cheap. The DB is opened
// lazily inside the vocab lookup, only when a payload references a repo
// that has opted in. argv / stdin / exit-code contract is identical to the
// dispatched form (see src/cli/validate_ticket.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrationsFromDir } from "../db/migrate.ts";
import { createLazyRepoVocabLookup } from "./repo_vocab_lookup.ts";
import { handleValidateTicket } from "./validate_ticket.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

const result = handleValidateTicket(
  process.argv.slice(2),
  {
    stdout: (c) => {
      process.stdout.write(c as string | Uint8Array);
    },
    stderr: (c) => {
      process.stderr.write(c);
    },
    stdin: () => readFileSync(0, "utf8"),
  },
  process.env,
  {
    lookupRepoVocab: createLazyRepoVocabLookup(
      process.env,
      () => loadMigrationsFromDir(MIGRATIONS_DIR),
    ),
  },
);
process.exit(result.exitCode);
