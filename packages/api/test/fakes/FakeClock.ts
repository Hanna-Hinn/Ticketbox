import type { Clock } from "../../src/application/ports/Clock.js";

// "It is now 10:02:15" — and then it is, with no setTimeout and no flake.
export class FakeClock implements Clock {
  private ms: number;

  constructor(start: string | Date) {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
