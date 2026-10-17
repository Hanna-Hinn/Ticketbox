import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { StatsResponse } from "../../dto/stats.js";
import type { StatsController } from "../controllers/StatsController.js";

// Operational, unauthenticated like /health: a learning project with no
// auth (handbook). The /debug page (TB-038) reads it.
export function registerStatsRoutes(app: FastifyInstance, stats: StatsController): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get("/_stats", { schema: { response: { 200: StatsResponse } } }, async () => stats.get());
}
