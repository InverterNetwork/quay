export interface IdGenerator {
  next(): string;
}

export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}
