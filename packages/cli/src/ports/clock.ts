export interface Clock {
  now(): Date;
  nowISO(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowISO(): string {
    return this.now().toISOString();
  }
}
