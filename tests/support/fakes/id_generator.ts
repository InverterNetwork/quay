import type { IdGenerator } from "../../../src/ports/id_generator.ts";

export class FakeIdGenerator implements IdGenerator {
  private counter = 0;
  private readonly prefix: string;

  constructor(prefix: string = "id") {
    this.prefix = prefix;
  }

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }

  reset(): void {
    this.counter = 0;
  }
}
