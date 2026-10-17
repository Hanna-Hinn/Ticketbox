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

  it.todo("POST /holds for 1 ticket returns 201 — TB-025 (route) over TB-022 (Lua reserve)");
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
