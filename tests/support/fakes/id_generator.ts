import type { IdGenerator } from "../../../src/ports/id_generator.ts";

export class FakeIdGenerator implements IdGenerator {
  private counter = 0;
  private readonly prefix: string;
  private readonly queue: string[] = [];

  constructor(prefix: string = "id") {
    this.prefix = prefix;
  }

  next(): string {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }

  push(...ids: string[]): void {
    this.queue.push(...ids);
  }

  reset(): void {
    this.counter = 0;
    this.queue.length = 0;
  }
}
