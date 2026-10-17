import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { HealthResponse, type HealthDto } from "../../dto/health.js";

// One closure per engine, written by the composition root with the driver it
// already holds. Each is pinged independently so one failure cannot hide
// another's status.
export type DependencyChecks = Readonly<Record<string, () => Promise<void>>>;

export function registerHealthRoutes(app: FastifyInstance, checks: DependencyChecks): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/health",
    { schema: { response: { 200: HealthResponse, 503: HealthResponse } } },
    async (_request, reply) => {
      const results = await Promise.all(
        Object.entries(checks).map(async ([name, ping]): Promise<[string, "ok" | "down"]> => {
          try {
            await ping();
            return [name, "ok"];
          } catch {
            return [name, "down"];
          }
        }),
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
