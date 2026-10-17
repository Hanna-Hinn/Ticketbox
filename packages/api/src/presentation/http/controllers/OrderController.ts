import type { ConfirmOrderUseCase } from "../../../application/use-cases/ConfirmOrder.js";
import { HoldGone } from "../../../domain/errors/HoldGone.js";
import { holdToken } from "../../../domain/value-objects/HoldToken.js";
import type { CreateOrderDto, OrderDto } from "../../dto/orders.js";

export class OrderController {
  constructor(private readonly confirmOrder: ConfirmOrderUseCase) {}

  async create(body: CreateOrderDto, idempotencyKey: string | undefined): Promise<OrderDto> {
    const result = await this.confirmOrder.execute({
      holdToken: holdToken(body.holdToken),
      email: body.email,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    if (!result.ok) throw new HoldGone(body.holdToken);
    return {
      orderId: result.orderId,
      holdToken: result.holdToken,
      email: result.email,
      totalCents: result.totalCents,
      items: result.items.map((item) => ({ ...item })),
      createdAt: result.createdAt.toISOString(),
    };
  }
}
