import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "../../../src/api/client.js";

const JAZZ_ID = "11111111-1111-4111-8111-111111111111";
const jazz = {
  id: JAZZ_ID,
  name: "Rooftop Jazz Night",
  venue: "The Terrace, Ramallah",
  startsAt: "2026-12-05T15:27:00.000Z",
  tiers: [{ id: "t-1", name: "General", priceCents: 2000, total: 1000, remaining: 1000 }],
};

// A fetch that answers every call the same way and remembers what was asked.
function fetchAnswering(
  status: number,
  body?: string,
): {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetchFn: (input) => {
      calls.push(input);
      return Promise.resolve(new Response(body, { status }));
    },
  };
}

describe("api client", () => {
  it("parses a 200 event into the DTO shape, asking for the encoded id", async () => {
    const { fetchFn, calls } = fetchAnswering(200, JSON.stringify(jazz));
    const client = createApiClient(fetchFn);

    const event = await client.getEvent("a/b c");

    expect(event).toEqual(jazz);
    expect(calls).toEqual(["/api/events/a%2Fb%20c"]);
  });

  it("parses a 200 event list", async () => {
    const summary = { id: JAZZ_ID, name: jazz.name, venue: jazz.venue, startsAt: jazz.startsAt };
    const { fetchFn, calls } = fetchAnswering(200, JSON.stringify([summary]));

    const events = await createApiClient(fetchFn).listEvents();

    expect(events).toEqual([summary]);
    expect(calls).toEqual(["/api/events"]);
  });

  it("surfaces a 404 envelope as an ApiError with the API's code and message", async () => {
    const { fetchFn } = fetchAnswering(
      404,
      JSON.stringify({ error: { code: "NOT_FOUND", message: `event ${JAZZ_ID} not found` } }),
    );

    const failure = createApiClient(fetchFn).getEvent(JAZZ_ID);

    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: `event ${JAZZ_ID} not found`,
    });
  });

  it("surfaces a non-JSON failure by status alone, never by statusText", async () => {
    const { fetchFn } = fetchAnswering(502, "<html>Bad Gateway</html>");

    const failure = createApiClient(fetchFn).listEvents();

    await expect(failure).rejects.toMatchObject({
      status: 502,
      code: "HTTP_502",
      message: "no error details",
    });
  });

  it("rethrows an abort during the body read of a failed response as the abort", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    const response = new Response("", { status: 500 });
    Object.defineProperty(response, "json", { value: () => Promise.reject(abort) });

    const failure = createApiClient(() => Promise.resolve(response)).listEvents();

    await expect(failure).rejects.toBe(abort);
  });

  it("forwards the caller's AbortSignal to fetch, and null when there is none", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchFn = (_input: string, init?: RequestInit): Promise<Response> => {
      seen.push(init?.signal);
      return Promise.resolve(new Response("[]", { status: 200 }));
    };
    const client = createApiClient(fetchFn);
    const controller = new AbortController();

    await client.listEvents(controller.signal);
    await client.getEvent(JAZZ_ID, controller.signal);
    await client.listEvents();

    expect(seen).toEqual([controller.signal, controller.signal, null]);
  });

  it("rejects a 200 whose body is not JSON, and not as an ApiError", async () => {
    const { fetchFn } = fetchAnswering(200, "<html>not json</html>");

    const failure = createApiClient(fetchFn).listEvents();

    await expect(failure).rejects.toThrow(SyntaxError);
    await expect(failure).rejects.not.toBeInstanceOf(ApiError);
  });

  it("treats a 4xx whose JSON is not the envelope as a status-only failure", async () => {
    const { fetchFn } = fetchAnswering(422, JSON.stringify({ message: "x" }));

    const failure = createApiClient(fetchFn).getEvent(JAZZ_ID);

    await expect(failure).rejects.toMatchObject({
      status: 422,
      code: "HTTP_422",
      message: "no error details",
    });
  });

  it("passes a transport failure through untouched", async () => {
    const down = new TypeError("fetch failed");

    const failure = createApiClient(() => Promise.reject(down)).listEvents();

    await expect(failure).rejects.toBe(down);
  });
});

describe("api client, the hold calls", () => {
  const hold = {
    token: "11111111-1111-4111-8111-aaaaaaaaaaa1",
    eventId: JAZZ_ID,
    tierId: "t-1",
    qty: 2,
    expiresAt: "2026-12-05T15:29:00.000Z",
  };

  it("creates a hold with a JSON POST and returns the 201 body", async () => {
    const seen: RequestInit[] = [];
    const client = createApiClient((_input, init) => {
      if (init !== undefined) seen.push(init);
      return Promise.resolve(
        new Response(JSON.stringify({ ...hold, remaining: 998 }), { status: 201 }),
      );
    });

    const created = await client.createHold({ eventId: JAZZ_ID, tierId: "t-1", qty: 2 });

    expect(created).toEqual({ ...hold, remaining: 998 });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe(JSON.stringify({ eventId: JAZZ_ID, tierId: "t-1", qty: 2 }));
    expect(new Headers(seen[0]?.headers).get("content-type")).toBe("application/json");
  });

  it("fetches a hold by its encoded token", async () => {
    const { fetchFn, calls } = fetchAnswering(200, JSON.stringify({ ...hold, remainingMs: 1 }));

    const fetched = await createApiClient(fetchFn).getHold("a/b");

    expect(fetched).toEqual({ ...hold, remainingMs: 1 });
    expect(calls).toEqual(["/api/holds/a%2Fb"]);
  });

  it("releases with DELETE and returns the released flag", async () => {
    const seen: RequestInit[] = [];
    const client = createApiClient((_input, init) => {
      if (init !== undefined) seen.push(init);
      return Promise.resolve(new Response(JSON.stringify({ released: true }), { status: 200 }));
    });

    const released = await client.releaseHold(hold.token);

    expect(released).toEqual({ released: true });
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.body).toBeUndefined();
  });

  it("turns a 409 envelope into an ApiError carrying its code", async () => {
    const { fetchFn } = fetchAnswering(
      409,
      JSON.stringify({ error: { code: "INSUFFICIENT", message: "not enough tickets left" } }),
    );

    const attempt = createApiClient(fetchFn).createHold({
      eventId: JAZZ_ID,
      tierId: "t-1",
      qty: 2,
    });

    await expect(attempt).rejects.toMatchObject({ status: 409, code: "INSUFFICIENT" });
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
  });
});
