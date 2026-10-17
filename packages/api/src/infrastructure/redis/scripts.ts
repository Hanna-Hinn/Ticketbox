import { readFileSync } from "node:fs";
import type { ClientContext, Redis, Result } from "ioredis";

// The Lua lives at the repository root (handbook §2.4), five levels up from
// this file — the way the migration runner finds migrations/.
const LUA_DIR = new URL("../../../../../scripts/lua/", import.meta.url);

export const CREATE_HOLD_LUA = readFileSync(new URL("create_hold.lua", LUA_DIR), "utf8");
export const RELEASE_HOLD_LUA = readFileSync(new URL("release_hold.lua", LUA_DIR), "utf8");
export const SWEEP_HOLD_LUA = readFileSync(new URL("sweep_hold.lua", LUA_DIR), "utf8");
export const CONSUME_HOLD_LUA = readFileSync(new URL("consume_hold.lua", LUA_DIR), "utf8");

// ioredis adds a defined command to the client at runtime only. Its
// RedisCommander interface is left open for exactly this augmentation; the
// signature here is the script's KEYS then ARGV, in order. The augmentation
// is global to the module: every Redis value in this package types both
// commands, but only a client that went through defineHoldScripts has them
// at runtime — call them from RedisHoldStore and nowhere else.
declare module "ioredis" {
  interface RedisCommander<Context extends ClientContext = { type: "default" }> {
    createHold(
      tierKey: string,
      holdKey: string,
      tierHoldsKey: string,
      qty: number,
      token: string,
      tierId: string,
      createdAtMs: number,
      expiresAtMs: number,
      ttlMs: number,
      eventId: string,
    ): Result<number, Context>;
    releaseHold(
      holdKey: string,
      tierKey: string,
      tierHoldsKey: string,
      token: string,
      tierId: string,
    ): Result<number, Context>;
    sweepHold(
      tierHoldsKey: string,
      tierKey: string,
      holdKey: string,
      member: string,
      qty: number,
      nowMs: number,
    ): Result<number, Context>;
    consumeHold(
      holdKey: string,
      tierHoldsKey: string,
      token: string,
      tierId: string,
    ): Result<number, Context>;
  }
}

// First call on a socket goes as EVAL, later ones as EVALSHA, and a NOSCRIPT
// reply (a restarted Redis) is resent as EVAL — ioredis's Script class, read
// in node_modules/ioredis/built/Script.js.
export function defineHoldScripts(redis: Redis): void {
  redis.defineCommand("createHold", { numberOfKeys: 3, lua: CREATE_HOLD_LUA });
  redis.defineCommand("releaseHold", { numberOfKeys: 3, lua: RELEASE_HOLD_LUA });
  redis.defineCommand("sweepHold", { numberOfKeys: 3, lua: SWEEP_HOLD_LUA });
  redis.defineCommand("consumeHold", { numberOfKeys: 2, lua: CONSUME_HOLD_LUA });
}
