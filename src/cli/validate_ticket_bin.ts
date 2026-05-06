#!/usr/bin/env bun
// Standalone child-process entry for `quay validate-ticket`. Adapters spec
// §11 requires `enqueue --linear-issue` to invoke the validator as a
// subprocess; the public `quay validate-ticket` CLI is also routed through
// dispatch (see src/cli/index.ts), but that path opens the Quay DB and runs
// migrations — wasted work for a stateless, JSON-in/JSON-out validator. This
// thin entry skips the substrate setup so the spawn is fast.
//
// argv / stdin / exit-code contract is identical to the dispatched form:
// see src/cli/validate_ticket.ts for the full semantics.

import { readFileSync } from "node:fs";
import { handleValidateTicket } from "./validate_ticket.ts";

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
);
process.exit(result.exitCode);
