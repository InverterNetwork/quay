import { expect, test } from "bun:test";
import {
  GitHubCliAdapter,
  type RunResult,
} from "../../src/adapters/github.ts";

class RecordingAdapter extends GitHubCliAdapter {
  readonly calls: Array<{
    repoId: string;
    cmd: string[];
    env: Record<string, string | undefined>;
  }> = [];
  next: RunResult = {
    exitCode: 0,
    stdout: "lafawnduh1966/quay\n",
    stderr: "",
  };

  constructor() {
    super("/tmp/quay-stub-reviewer-token-probe");
  }

  protected override run(
    repoId: string,
    cmd: string[],
    env: Record<string, string | undefined> = process.env,
  ): RunResult {
    this.calls.push({ repoId, cmd, env });
    return this.next;
  }
}

test("reviewer token probe uses an App-compatible repo-scoped endpoint", () => {
  const adapter = new RecordingAdapter();
  adapter.probeTokenAccess("repo-x", "ghs_installation_token");

  expect(adapter.calls).toHaveLength(1);
  expect(adapter.calls[0]!.cmd).toEqual([
    "gh",
    "api",
    "repos/{owner}/{repo}",
    "--jq",
    ".full_name",
  ]);
  expect(adapter.calls[0]!.env.GH_TOKEN).toBe("ghs_installation_token");
  expect(adapter.calls[0]!.cmd.join(" ")).not.toContain(" user");
});

test("reviewer token probe throws a repo-scoped diagnostic on auth failure", () => {
  const adapter = new RecordingAdapter();
  adapter.next = {
    exitCode: 1,
    stdout: "",
    stderr: "HTTP 401: Bad credentials",
  };

  expect(() => adapter.probeTokenAccess("repo-x", "stale")).toThrow(
    /gh api repos\/\{owner\}\/\{repo\} failed: HTTP 401/i,
  );
});
