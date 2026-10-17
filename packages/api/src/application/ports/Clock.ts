// Never Date.now() inside a use case: this product's core concept is a timer,
// and an injectable clock is what makes it testable without setTimeout.
export interface Clock {
  now(): Date;
}
