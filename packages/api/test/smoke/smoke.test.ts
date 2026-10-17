import { describe, expect, it } from "vitest";
import { SEED_EVENTS } from "../../src/infrastructure/postgres/seed.js";

// Handbook §4.1: six assertions against the running system, from outside.
// Three of them name routes or packages that do not exist yet; each is a
// todo carrying the task that makes it real, not a test pretending to pass.

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const webUrl = process.env.SMOKE_WEB_URL ?? "http://localhost:5173";
const firstSeedEvent = SEED_EVENTS[0];
if (firstSeedEvent === undefined) throw new Error("SEED_EVENTS is empty; smoke needs a seeded id");
const seededEventId: string = firstSeedEvent.id;

describe("smoke", () => {
  it("GET /health is 200 with both engines ok", async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { postgres: "ok", redis: "ok" },
    });
  });

  it("GET /events returns a non-empty array (seed data loaded)", async () => {
    const response = await fetch(`${baseUrl}/events`);

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).not.toHaveLength(0);
  });

  it("GET /events/:id is 200 for a seeded id", async () => {
    const response = await fetch(`${baseUrl}/events/${seededEventId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: seededEventId });
  });

  it("POST /holds for 1 ticket is 201, and the hold is released again afterwards", async () => {
    // The seed wrote the live counters (TB-025); releasing leaves them as
    // they were for the next suite.
    const firstTier = firstSeedEvent.tiers[0];
    if (firstTier === undefined) throw new Error("the first seed event has no tiers");

    const created = await fetch(`${baseUrl}/holds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: seededEventId, tierId: firstTier.id, qty: 1 }),
    });
    const body: unknown = await created.json();
    const token =
      typeof body === "object" && body !== null && "token" in body ? String(body.token) : "";
    const released = await fetch(`${baseUrl}/holds/${token}`, { method: "DELETE" });

    expect(created.status).toBe(201);
    expect(body).toMatchObject({ eventId: seededEventId, tierId: firstTier.id, qty: 1 });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released: true });
  });
  it("DELETE /holds/:token is 200 with released: false for a token nobody holds", async () => {
    const response = await fetch(`${baseUrl}/holds/00000000-0000-4000-8000-000000000000`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ released: false });
  });
  it("the web app's root HTML is served (needs pnpm dev:web)", async () => {
    const response = await fetch(`${webUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root">');
  });
});
