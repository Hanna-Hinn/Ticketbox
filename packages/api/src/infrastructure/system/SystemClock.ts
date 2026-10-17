import type { Clock } from "../../application/ports/Clock.js";

// The only place the system clock is read on behalf of a use case.
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
