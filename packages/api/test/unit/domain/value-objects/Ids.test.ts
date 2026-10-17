import { describe, expect, it } from "vitest";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import {
  eventId,
  orderId,
  tierId,
  type EventId,
  type TierId,
} from "../../../../src/domain/value-objects/Ids.js";

describe("branded ids", () => {
  it("keep the underlying string unchanged", () => {
    expect(eventId("e-1")).toBe("e-1");
    expect(tierId("t-1")).toBe("t-1");
    expect(orderId("o-1")).toBe("o-1");
    expect(holdToken("tok-1")).toBe("tok-1");
  });

  it("are not interchangeable at the type level", () => {
    const tier: TierId = tierId("t-1");

    // @ts-expect-error a TierId must not be assignable where an EventId belongs
    const event: EventId = tier;

    expect(event).toBe("t-1");
  });
});
