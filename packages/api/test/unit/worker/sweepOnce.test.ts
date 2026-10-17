import pino from "pino";
import { describe, expect, it } from "vitest";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { sweepOnce } from "../../../src/worker/sweepOnce.js";

function capturing(): {
  log: pino.Logger;
  lines: () => { level: number; msg: string; token?: string; err?: unknown }[];
} {
  const raw: string[] = [];
  const log = pino({ level: "info" }, { write: (line: string) => void raw.push(line) });
  return {
    log,
    lines: () =>
      raw.map(
        (line) => JSON.parse(line) as { level: number; msg: string; token?: string; err?: unknown },
      ),
  };
}

describe("sweepOnce", () => {
  it("logs nothing when there was nothing to sweep", async () => {
    const { log, lines } = capturing();

    await sweepOnce({ execute: async () => ({ swept: 0, restored: 0, unmarked: [] }) }, log);

    expect(lines()).toEqual([]);
  });

  it("logs the counts at info, and one error line per row it could not mark, with the reason", async () => {
    const { log, lines } = capturing();
    const cause = new Error("Query read timeout");

    await sweepOnce(
      {
        execute: async () => ({
          swept: 2,
          restored: 2,
          unmarked: [{ token: holdToken("tok-a"), error: cause }],
        }),
      },
      log,
    );

    const [info, error] = lines();
    expect(lines()).toHaveLength(2);
    expect(info).toMatchObject({
      level: 30,
      msg: "swept expired holds",
      swept: 2,
      restored: 2,
      unmarked: 1,
    });
    expect(error).toMatchObject({ level: 50, token: "tok-a" });
    expect(error?.err).toMatchObject({ message: "Query read timeout" });
  });

  it("lets the sweeper's own failure escape to the loop's onError", async () => {
    const { log } = capturing();

    await expect(
      sweepOnce({ execute: () => Promise.reject(new Error("redis is away")) }, log),
    ).rejects.toThrow("redis is away");
  });
});
