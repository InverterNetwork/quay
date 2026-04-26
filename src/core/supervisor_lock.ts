// In-process supervisor lock abstraction (per spec §5 "Concurrency policy").
//
// The real adapter (Slice 10) is a PID-aware lockfile under `tick_lock_path`.
// For Slice 3 we only need a wrapper that serializes side effects: tick holds
// it for an entire cycle so spawn/kill/Slack/branch ops don't race. An
// in-process Mutex is sufficient for the fakes used by tests and for any
// single-process call sites.
export interface SupervisorLock {
  run<T>(fn: () => T): T;
}

export class InProcessSupervisorLock implements SupervisorLock {
  private held = false;

  run<T>(fn: () => T): T {
    if (this.held) {
      throw new Error("supervisor lock is already held in this process");
    }
    this.held = true;
    try {
      return fn();
    } finally {
      this.held = false;
    }
  }
}
