import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ErrorResponse } from "../../dto/errors.js";
import { EventIdParams, EventListResponse, EventResponse } from "../../dto/events.js";
import type { EventController } from "../controllers/EventController.js";

export function registerEventRoutes(app: FastifyInstance, events: EventController): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get("/events", { schema: { response: { 200: EventListResponse } } }, async () =>
    events.list(),
  );

  routes.get(
    "/events/:id",
    { schema: { params: EventIdParams, response: { 200: EventResponse, 404: ErrorResponse } } },
    async (request) => events.get(request.params.id),
  );
}
