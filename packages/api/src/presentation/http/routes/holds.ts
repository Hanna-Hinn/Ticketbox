import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ErrorResponse } from "../../dto/errors.js";
import {
  CreatedHoldResponse,
  CreateHoldRequest,
  HoldResponse,
  HoldTokenParams,
  ReleaseResponse,
} from "../../dto/holds.js";
import type { HoldController } from "../controllers/HoldController.js";

export function registerHoldRoutes(app: FastifyInstance, holds: HoldController): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/holds",
    {
      schema: {
        body: CreateHoldRequest,
        response: {
          201: CreatedHoldResponse,
          400: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const created = await holds.create(request.body);
      return reply.code(201).send(created);
    },
  );

  routes.get(
    "/holds/:token",
    { schema: { params: HoldTokenParams, response: { 200: HoldResponse, 404: ErrorResponse } } },
    async (request) => holds.get(request.params.token),
  );

  routes.delete(
    "/holds/:token",
    { schema: { params: HoldTokenParams, response: { 200: ReleaseResponse, 400: ErrorResponse } } },
    async (request) => holds.release(request.params.token),
  );
}
