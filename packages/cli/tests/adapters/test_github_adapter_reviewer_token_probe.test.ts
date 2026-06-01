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
  nextResults: RunResult[] = [];

  constructor() {
    super("/tmp/quay-stub-reviewer-token-probe");
  }

  protected override run(
    repoId: string,
    cmd: string[],
    env: Record<string, string | undefined> = process.env,
  ): RunResult {
    this.calls.push({ repoId, cmd, env });
    if (this.nextResults.length > 0) {
      return this.nextResults.shift()!;
    }
    return this.next;
  }
}

test("reviewer token probe uses an App-compatible repo-scoped endpoint", () => {
  const adapter = new RecordingAdapter();
  adapter.probeTokenAccess("repo-x", "ghs_installation_token", "reviewer");

  expect(adapter.calls).toHaveLength(1);
  expect(adapter.calls[0]!.cmd).toEqual([
    "gh",
    "api",
    "repos/{owner}/{repo}",
    "--jq",
    ".full_name",
  ]);
  expect(adapter.calls[0]!.env.GH_TOKEN).toBe("ghs_installation_token");
  expect(adapter.calls[0]!.env.GITHUB_TOKEN).toBeUndefined();
  expect(adapter.calls[0]!.env.QUAY_WORKER_GH_TOKEN).toBeUndefined();
  expect(adapter.calls[0]!.env.QUAY_REVIEWER_GH_TOKEN).toBeUndefined();
  expect(adapter.calls[0]!.cmd.join(" ")).not.toContain(" user");
});

test("actor token probe throws a repo-scoped diagnostic on auth failure", () => {
  const adapter = new RecordingAdapter();
  adapter.next = {
    exitCode: 1,
    stdout: "",
    stderr: "HTTP 401: Bad credentials",
  };

  expect(() => adapter.probeTokenAccess("repo-x", "stale", "reviewer")).toThrow(
    /gh api repos\/\{owner\}\/\{repo\} failed: HTTP 401/i,
  );
});

test("worker token probe rejects tokens without repository write access", () => {
  const adapter = new RecordingAdapter();
  adapter.nextResults = [
    { exitCode: 0, stdout: "lafawnduh1966/quay\n", stderr: "" },
    { exitCode: 1, stdout: "", stderr: "write access denied\n" },
  ];

  expect(() =>
    adapter.probeTokenAccess("repo-x", "ghs_readonly_token", "worker"),
  ).toThrow(/worker token does not have write access/i);
  expect(adapter.calls).toHaveLength(2);
  const workerProbe = adapter.calls[1]!;
  expect(workerProbe.cmd.slice(0, 7)).toEqual([
    "git",
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f",
    "push",
    "--dry-run",
  ]);
  expect(workerProbe.cmd[7]).toBe("https://github.com/lafawnduh1966/quay.git");
  expect(workerProbe.cmd[8]).toMatch(
    /^HEAD:refs\/heads\/quay\/token-write-probe-/,
  );
  expect(adapter.calls[1]!.env.GH_TOKEN).toBe("ghs_readonly_token");
  expect(adapter.calls[1]!.env.GITHUB_TOKEN).toBeUndefined();
  expect(adapter.calls[1]!.env.QUAY_WORKER_GH_TOKEN).toBeUndefined();
  expect(adapter.calls[1]!.env.QUAY_REVIEWER_GH_TOKEN).toBeUndefined();
  expect(adapter.calls[1]!.env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(adapter.calls[1]!.env.GIT_ASKPASS).toBe("");
});

test("worker token probe accepts writable repository permissions", () => {
  for (const stderr of ["", "dry run ok\n"]) {
    const adapter = new RecordingAdapter();
    adapter.nextResults = [
      { exitCode: 0, stdout: "lafawnduh1966/quay\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr },
    ];

    expect(() =>
      adapter.probeTokenAccess("repo-x", "ghs_installation_token", "worker"),
    ).not.toThrow();
  }
});
