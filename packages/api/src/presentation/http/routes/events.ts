import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ErrorResponse,
  EventIdParams,
  EventListResponse,
  EventResponse,
} from "../../dto/events.js";
import type { EventController } from "../controllers/EventController.js";

export function registerEventRoutes(app: FastifyInstance, events: EventController): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get("/events", { schema: { response: { 200: EventListResponse } } }, async () =>
    events.list(),
  );

  routes.get(
    "/events/:id",
    { schema: { params: EventIdParams, response: { 200: EventResponse, 404: ErrorResponse } } },
    async (request, reply) => {
      const dto = await events.get(request.params.id);
      // HTTP mapping, not a domain rule. TB-012's error handler takes this over.
      if (dto === null) {
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: `event ${request.params.id} not found` } });
      }
      return dto;
    },
  );
}
