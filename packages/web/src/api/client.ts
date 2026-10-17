import type { ErrorDto } from "@ticketbox/api/src/presentation/dto/errors.js";
import type { EventDto, EventSummaryDto } from "@ticketbox/api/src/presentation/dto/events.js";
import type {
  CreatedHoldDto,
  CreateHoldDto,
  HoldDto,
  ReleaseDto,
} from "@ticketbox/api/src/presentation/dto/holds.js";
import type { CreateOrderDto, OrderDto } from "@ticketbox/api/src/presentation/dto/orders.js";

// The only file in packages/web that talks HTTP (enforced by lint). Response
// types are the API's own DTOs, imported as types only: nothing of the API
// package reaches the bundle, and a DTO change fails `tsc` here instead of
// drifting in a hand-written mirror.

// A non-2xx the API answered. `code` is the envelope's code, or HTTP_<status>
// when the body carried no envelope (a proxy error, a crash before the handler).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  listEvents(signal?: AbortSignal): Promise<EventSummaryDto[]>;
  getEvent(id: string, signal?: AbortSignal): Promise<EventDto>;
  createHold(input: CreateHoldDto, signal?: AbortSignal): Promise<CreatedHoldDto>;
  getHold(token: string, signal?: AbortSignal): Promise<HoldDto>;
  releaseHold(token: string, signal?: AbortSignal): Promise<ReleaseDto>;
  /** The key is the page's: the same key, the same request, the same order (TB-030). */
  createOrder(
    input: CreateOrderDto,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<OrderDto>;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// A factory so tests inject their own fetch; the pages use `api` below.
export function createApiClient(fetchFn: FetchFn = (input, init) => fetch(input, init)): ApiClient {
  async function request<T>(
    path: string,
    signal: AbortSignal | undefined,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const response = await fetchFn(path, {
      method: init.method ?? "GET",
      signal: signal ?? null,
      ...(init.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json", ...init.headers },
            body: JSON.stringify(init.body),
          }),
    });
    if (!response.ok) throw await toApiError(response);
    // The API's Zod serializer guarantees the shape on its side; the browser
    // trusts it rather than shipping the schema.
    return (await response.json()) as T;
  }

  return {
    listEvents: (signal) => request<EventSummaryDto[]>("/api/events", signal),
    getEvent: (id, signal) => request<EventDto>(`/api/events/${encodeURIComponent(id)}`, signal),
    createHold: (input, signal) =>
      request<CreatedHoldDto>("/api/holds", signal, { method: "POST", body: input }),
    getHold: (token, signal) => request<HoldDto>(`/api/holds/${encodeURIComponent(token)}`, signal),
    releaseHold: (token, signal) =>
      request<ReleaseDto>(`/api/holds/${encodeURIComponent(token)}`, signal, { method: "DELETE" }),
    createOrder: (input, idempotencyKey, signal) =>
      request<OrderDto>("/api/orders", signal, {
        method: "POST",
        body: input,
        headers: { "idempotency-key": idempotencyKey },
      }),
  };
}

export const api: ApiClient = createApiClient();

// Reads the envelope if there is one. An aborted body read is rethrown as the
// abort it is: the caller's guard decides what an abort means, and turning it
// into an ApiError wrote state for dead effects in TB-014.
async function toApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch((err: unknown) => {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return undefined;
  });
  if (isErrorEnvelope(body)) {
    return new ApiError(response.status, body.error.code, body.error.message);
  }
  // Not statusText: it is empty under HTTP/2. The status itself is on the
  // error; the message says what is missing.
  return new ApiError(response.status, `HTTP_${response.status}`, "no error details");
}

function isErrorEnvelope(body: unknown): body is ErrorDto {
  if (typeof body !== "object" || body === null || !("error" in body)) return false;
  const error: unknown = body.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}
