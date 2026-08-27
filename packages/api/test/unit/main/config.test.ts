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
    });
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
