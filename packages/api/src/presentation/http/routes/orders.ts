import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ErrorResponse } from "../../dto/errors.js";
import { CreateOrderRequest, IdempotencyHeaders, OrderResponse } from "../../dto/orders.js";
import type { OrderController } from "../controllers/OrderController.js";

// The body carries an email: the request body is never logged at info
// (CLAUDE.md), and nothing here prints it.
export function registerOrderRoutes(app: FastifyInstance, orders: OrderController): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/orders",
    {
      schema: {
        body: CreateOrderRequest,
        headers: IdempotencyHeaders,
        response: {
          201: OrderResponse,
          400: ErrorResponse,
          409: ErrorResponse,
          410: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const order = await orders.create(request.body, request.headers["idempotency-key"]);
      return reply.code(201).send(order);
    },
  );
}
