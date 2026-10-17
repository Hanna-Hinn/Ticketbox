import { holdToken, type HoldToken } from "../../domain/value-objects/HoldToken.js";

// The member of a tier's holds index: "<token>:<qty>" (TB-026). The hold
// hash carries the quantity only for the hold's life; the index outlives
// it, so the index carries the quantity too. Tokens are UUIDs and contain
// no colon; the last colon is the split in case that ever changes.
export function encodeMember(token: HoldToken, qty: number): string {
  return `${token}:${qty}`;
}

// null for a member this version did not write — a bare token from before
// TB-026 — which the sweeper removes and warns about rather than guessing.
export function decodeMember(member: string): { token: HoldToken; qty: number } | null {
  const at = member.lastIndexOf(":");
  if (at <= 0) return null;
  const qty = Number(member.slice(at + 1));
  if (!Number.isInteger(qty) || qty < 1) return null;
  return { token: holdToken(member.slice(0, at)), qty };
}
