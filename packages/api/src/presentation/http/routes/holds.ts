import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ErrorResponse } from "../../dto/errors.js";
import { HoldTokenParams, ReleaseResponse } from "../../dto/holds.js";
import type { HoldController } from "../controllers/HoldController.js";

export function registerHoldRoutes(app: FastifyInstance, holds: HoldController): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.delete(
    "/holds/:token",
    { schema: { params: HoldTokenParams, response: { 200: ReleaseResponse, 400: ErrorResponse } } },
    async (request) => holds.release(request.params.token),
  );
}
