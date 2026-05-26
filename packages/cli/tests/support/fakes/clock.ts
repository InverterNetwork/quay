import type { Clock } from "../../../src/ports/clock.ts";

export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: string | Date = "2026-01-01T00:00:00.000Z") {
    this.current = typeof initial === "string" ? new Date(initial) : new Date(initial);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  nowISO(): string {
    return this.current.toISOString();
  }

  set(value: string | Date): void {
    this.current = typeof value === "string" ? new Date(value) : new Date(value);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
