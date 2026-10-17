import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { HealthResponse, type HealthDto } from "../../dto/health.js";

// One closure per engine, written by the composition root with the driver it
// already holds. It is a Record, not { postgres, redis }, because the Redis
// closure only exists from TB-017 onwards.
export type DependencyChecks = Readonly<Record<string, () => Promise<void>>>;

// A check that never settles is a failure, not a pending answer: without a
// bound, one hung engine would hide the other's status behind a request
// that never returns. The driver's own timeout eventually settles the
// dangling ping; nothing here waits for it.
const CHECK_TIMEOUT_MS = 2_000;

async function pingWithin(ping: () => Promise<void>): Promise<"ok" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`health check exceeded ${CHECK_TIMEOUT_MS}ms`)),
      CHECK_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([ping(), deadline]);
    return "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealthRoutes(app: FastifyInstance, checks: DependencyChecks): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/health",
    { schema: { response: { 200: HealthResponse, 503: HealthResponse } } },
    async (_request, reply) => {
      const results = await Promise.all(
        Object.entries(checks).map(async ([name, ping]): Promise<[string, "ok" | "down"]> => [
          name,
          await pingWithin(ping),
        ]),
      );
      const healthy = results.every(([, status]) => status === "ok");
      const body: HealthDto = {
        status: healthy ? "ok" : "degraded",
        checks: Object.fromEntries(results),
      };
      return reply.code(healthy ? 200 : 503).send(body);
    },
  );
}
