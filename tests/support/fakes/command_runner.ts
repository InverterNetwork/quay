import type { CommandRunner, CommandRunResult } from "../../../src/ports/command_runner.ts";

export interface FakeCommandCall {
  command: string;
  cwd: string;
}

export type FakeCommandHandler = (
  command: string,
  cwd: string,
) => CommandRunResult;

export class FakeCommandRunner implements CommandRunner {
  readonly calls: FakeCommandCall[] = [];
  private handler: FakeCommandHandler;

  constructor(
    handler: FakeCommandHandler = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  ) {
    this.handler = handler;
  }

  setHandler(handler: FakeCommandHandler): void {
    this.handler = handler;
  }

  failNext(stderr = "boom", exitCode = 1): void {
    let fired = false;
    const prior = this.handler;
    this.handler = (cmd, cwd) => {
      if (!fired) {
        fired = true;
        return { exitCode, stdout: "", stderr };
      }
      return prior(cmd, cwd);
    };
  }

  run(command: string, opts: { cwd: string }): CommandRunResult {
    this.calls.push({ command, cwd: opts.cwd });
    return this.handler(command, opts.cwd);
  }
}
