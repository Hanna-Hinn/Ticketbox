import { Order } from "../../domain/entities/Order.js";
import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { OrderId, TierId } from "../../domain/value-objects/Ids.js";
import type { Clock } from "../ports/Clock.js";
import type { EventRepository } from "../ports/EventRepository.js";
import type { HoldStore } from "../ports/HoldStore.js";
import type { OrderIdGenerator } from "../ports/OrderIdGenerator.js";
import type { OrderRepository } from "../ports/OrderRepository.js";

export interface ConfirmOrderInput {
  readonly holdToken: HoldToken;
  readonly email: string;
  readonly idempotencyKey?: string;
}

export type ConfirmOrderOutput =
  | {
      ok: true;
      orderId: OrderId;
      holdToken: HoldToken;
      email: string;
      totalCents: number;
      items: readonly { tierId: TierId; qty: number; unitPriceCents: number }[];
      createdAt: Date;
    }
  | { ok: false; reason: "hold-gone" };

// The irreversible step. Redis decides — the consume is the one atomic
// "is it still held, and now it is sold" — and Postgres records, in that
// order (ADR 0007): the other way round lets the sweeper restore a ticket
// an order already owns. A Postgres failure after the consume leaves the
// hold gone and no order: an under-sell reconcile repairs, never an
// oversell. The store's find is the data; the consume is the decision.
export class ConfirmOrderUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly holds: HoldStore,
    private readonly orders: OrderRepository,
    private readonly clock: Clock,
    private readonly ids: OrderIdGenerator,
  ) {}

  async execute(input: ConfirmOrderInput): Promise<ConfirmOrderOutput> {
    const hold = await this.holds.find(input.holdToken);
    if (hold === null) return { ok: false, reason: "hold-gone" };

    // A hold references an event with its tier; their absence is a bug, not
    // a thing to tell the customer.
    const event = await this.events.findById(hold.eventId);
    if (event === null)
      throw new Error(`hold ${hold.token} references event ${hold.eventId}, which does not exist`);
    const tier = event.tiers.find((candidate) => candidate.id === hold.tierId);
    if (tier === undefined) {
      throw new Error(
        `hold ${hold.token} references tier ${hold.tierId}, which is not on its event`,
      );
    }

    // Built before any write: Order.create is where the items are validated,
    // and a consume followed by a throw is a ticket nobody can sell.
    const order = Order.create({
      id: this.ids.nextOrderId(),
      holdToken: hold.token,
      email: input.email,
      items: [{ tierId: tier.id, qty: hold.qty, unitPrice: tier.price }],
      createdAt: this.clock.now(),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });

    // The decision. Expired, swept, released or confirmed since the read:
    // all the same answer, and nothing has been written.
    const consumed = await this.holds.consume(hold.token);
    if (!consumed) return { ok: false, reason: "hold-gone" };

    await this.orders.save(order);

    return {
      ok: true,
      orderId: order.id,
      holdToken: order.holdToken,
      email: order.email,
      totalCents: order.total().cents,
      items: order.items.map((item) => ({
        tierId: item.tierId,
        qty: item.qty.value,
        unitPriceCents: item.unitPrice.cents,
      })),
      createdAt: order.createdAt,
    };
  }
}
