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
