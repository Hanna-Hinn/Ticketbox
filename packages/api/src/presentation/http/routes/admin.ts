import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ReconcileParams, ReconcileResponse } from "../../dto/admin.js";
import { ErrorResponse } from "../../dto/errors.js";
import type { AdminController } from "../controllers/AdminController.js";

// Operational, unauthenticated like /_stats and /health: a learning project
// with no auth (handbook). The _admin prefix is the whole access control;
// TB-032 is where limits arrive.
export function registerAdminRoutes(app: FastifyInstance, admin: AdminController): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/_admin/reconcile/:eventId",
    {
      schema: {
        params: ReconcileParams,
        response: { 200: ReconcileResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => admin.reconcileEvent(request.params.eventId),
  );
}
