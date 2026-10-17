import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let loadConfig: (typeof import("../../../src/main/config.js"))["loadConfig"];

// config.ts's top-level `export const config = loadConfig(process.env)` runs
// as soon as anything imports the module, regardless of which named export is
// used -- ES modules evaluate top-to-bottom. Stubbing the env before a dynamic
// import (a static import can't be delayed past the stub) keeps this scoped
// to this file, unlike a project-wide setupFiles entry that would mutate
// process.env for every unit test in the suite.
beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://ticketbox:ticketbox@localhost:5432/ticketbox");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  ({ loadConfig } = await import("../../../src/main/config.js"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const validEnv = {
  DATABASE_URL: "postgresql://ticketbox:ticketbox@localhost:5432/ticketbox",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("parses a valid environment into a typed config", () => {
    const config = loadConfig({ ...validEnv, PORT: "4000" });

    expect(config).toEqual({
      DATABASE_URL: validEnv.DATABASE_URL,
      REDIS_URL: validEnv.REDIS_URL,
      PORT: 4000,
      LOG_LEVEL: "info",
      HOLD_TTL_MS: 120_000,
    });
  });

  it("defaults LOG_LEVEL to info and accepts a pino level", () => {
    expect(loadConfig(validEnv).LOG_LEVEL).toBe("info");
    expect(loadConfig({ ...validEnv, LOG_LEVEL: "debug" }).LOG_LEVEL).toBe("debug");
  });

  it("throws when LOG_LEVEL is not a pino level", () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "loud" })).toThrowError(/LOG_LEVEL/);
  });

  it("defaults HOLD_TTL_MS to two minutes and accepts a shorter one", () => {
    expect(loadConfig(validEnv).HOLD_TTL_MS).toBe(120_000);
    expect(loadConfig({ ...validEnv, HOLD_TTL_MS: "3000" }).HOLD_TTL_MS).toBe(3000);
  });

  it("refuses a HOLD_TTL_MS that is zero or not a whole number of milliseconds", () => {
    expect(() => loadConfig({ ...validEnv, HOLD_TTL_MS: "0" })).toThrow(/HOLD_TTL_MS/);
    expect(() => loadConfig({ ...validEnv, HOLD_TTL_MS: "1.5" })).toThrow(/HOLD_TTL_MS/);
  });

  it("defaults PORT to 3000 when it's omitted", () => {
    const config = loadConfig(validEnv);

    expect(config.PORT).toBe(3000);
  });

  it("returns a frozen object", () => {
    const config = loadConfig(validEnv);

    expect(Object.isFrozen(config)).toBe(true);
  });

  it("throws naming DATABASE_URL when it's missing", () => {
    expect(() => loadConfig({ REDIS_URL: validEnv.REDIS_URL })).toThrowError(/DATABASE_URL/);
  });

  it("throws naming REDIS_URL when it's missing", () => {
    expect(() => loadConfig({ DATABASE_URL: validEnv.DATABASE_URL })).toThrowError(/REDIS_URL/);
  });

  it("throws when PORT is not numeric", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "not-a-number" })).toThrowError(/PORT/);
  });

  it("throws when PORT is outside the valid port range", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "99999" })).toThrowError(/PORT/);
  });
});
