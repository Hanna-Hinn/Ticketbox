import { describe, expect, it } from "vitest";
import { Hold } from "../../../../src/domain/entities/Hold.js";
import { InvalidHold } from "../../../../src/domain/errors/InvalidHold.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { eventId, tierId } from "../../../../src/domain/value-objects/Ids.js";
import { Quantity } from "../../../../src/domain/value-objects/Quantity.js";

const TTL_MS = 120_000;
const createdAt = new Date("2026-01-01T10:00:00.000Z");

function aHold(ttlMs = TTL_MS, now: Date = createdAt): Hold {
  return Hold.create({
    token: holdToken("tok-1"),
    eventId: eventId("e-1"),
    tierId: tierId("t-1"),
    qty: Quantity.of(2),
    now,
    ttlMs,
  });
}

function at(offsetMs: number): Date {
  return new Date(createdAt.getTime() + offsetMs);
}

describe("Hold", () => {
  it("expires exactly ttl after its creation instant", () => {
    const hold = aHold();

    expect(hold.createdAt).toEqual(createdAt);
    expect(hold.expiresAt).toEqual(at(TTL_MS));
  });

  it("is alive one ms before its expiry instant", () => {
    expect(aHold().isExpired(at(TTL_MS - 1))).toBe(false);
  });

  it("is expired at exactly its expiry instant", () => {
    expect(aHold().isExpired(at(TTL_MS))).toBe(true);
  });

  it("is expired one ms after its expiry instant", () => {
    expect(aHold().isExpired(at(TTL_MS + 1))).toBe(true);
  });

  it("counts down the remaining time and never goes negative", () => {
    const hold = aHold();

    expect(hold.remainingMs(at(0))).toBe(TTL_MS);
    expect(hold.remainingMs(at(TTL_MS - 1))).toBe(1);
    expect(hold.remainingMs(at(TTL_MS))).toBe(0);
    expect(hold.remainingMs(at(TTL_MS + 1))).toBe(0);
  });

  it("agrees with itself: zero remaining if and only if expired", () => {
    const hold = aHold();

    for (const offset of [TTL_MS - 1, TTL_MS, TTL_MS + 1]) {
      expect(hold.remainingMs(at(offset)) === 0).toBe(hold.isExpired(at(offset)));
    }
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects a ttl of %s", (ttlMs) => {
    expect(() => aHold(ttlMs)).toThrow(InvalidHold);
  });

  it("rejects a ttl that is not a safe integer rather than creating an immortal hold", () => {
    expect(() => aHold(1e300)).toThrow(InvalidHold);
  });

  it("rejects a ttl that pushes the expiry past the representable date range", () => {
    expect(() => aHold(9e15)).toThrow(InvalidHold);
  });

  it("rejects an invalid creation instant", () => {
    expect(() => aHold(TTL_MS, new Date("garbage"))).toThrow(InvalidHold);
  });

  it("treats an invalid clock reading as a bug, not as 'not expired'", () => {
    const hold = aHold();

    expect(() => hold.isExpired(new Date(Number.NaN))).toThrow(InvalidHold);
    expect(() => hold.remainingMs(new Date(Number.NaN))).toThrow(InvalidHold);
  });

  it("cannot have its expiry rewritten through the Date it hands out", () => {
    const hold = aHold();

    hold.expiresAt.setTime(0);

    expect(hold.isExpired(at(TTL_MS - 1))).toBe(false);
    expect(hold.expiresAt).toEqual(at(TTL_MS));
  });

  it("does not alias the caller's clock reading", () => {
    const now = new Date(createdAt.getTime());
    const hold = aHold(TTL_MS, now);

    now.setTime(0);

    expect(hold.createdAt).toEqual(createdAt);
  });
});
