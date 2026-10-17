import { describe, expect, it } from "vitest";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { KEY_PREFIX, keys } from "../../../src/infrastructure/redis/keys.js";

// The shapes the delivery plan documents: ticketbox:v1:hold:* (TB-040),
// tier:{id}:holds (TB-026), and the per-tier hash TB-021/022 count against.
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");

describe("key registry", () => {
  it("builds the per-tier hash key with a hash tag", () => {
    expect(keys.tier(TIER)).toBe("ticketbox:v1:tier:{11111111-1111-4111-8111-aaaaaaaaaaaa}");
  });

  it("builds the tier's holds index under the same hash tag", () => {
    expect(keys.tierHolds(TIER)).toBe(
      "ticketbox:v1:tier:{11111111-1111-4111-8111-aaaaaaaaaaaa}:holds",
    );
  });

  it("builds the hold key from the token", () => {
    expect(keys.hold(holdToken("tok-123"))).toBe("ticketbox:v1:hold:tok-123");
  });

  it("prefixes every key with the registry prefix", () => {
    const built = [keys.tier(TIER), keys.tierHolds(TIER), keys.hold(holdToken("t"))];

    for (const key of built) expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(KEY_PREFIX).toBe("ticketbox:v1:");
  });
});
