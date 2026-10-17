import { describe, expect, it } from "vitest";
import { UuidTokenGenerator } from "../../../../src/infrastructure/system/UuidTokenGenerator.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("UuidTokenGenerator", () => {
  it("hands out v4 uuids, a different one each time", () => {
    const tokens = new UuidTokenGenerator();

    const first = tokens.next();
    const second = tokens.next();

    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });
});
