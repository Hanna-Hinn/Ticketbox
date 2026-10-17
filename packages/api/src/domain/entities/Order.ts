import { InvalidOrder } from "../errors/InvalidOrder.js";
import type { HoldToken } from "../value-objects/HoldToken.js";
import type { OrderId, TierId } from "../value-objects/Ids.js";
import { Money } from "../value-objects/Money.js";
import type { Quantity } from "../value-objects/Quantity.js";

export interface OrderItem {
  readonly tierId: TierId;
  readonly qty: Quantity;
  readonly unitPrice: Money;
}

export interface OrderProps {
  readonly id: OrderId;
  readonly holdToken: HoldToken;
  readonly email: string;
  readonly items: readonly OrderItem[];
  readonly createdAt: Date;
  /** The client's Idempotency-Key, when it sent one (TB-029); TB-030 makes it mandatory. */
  readonly idempotencyKey?: string;
}

// A hold that was confirmed before its timer ran out. Permanent.
export class Order {
  readonly id: OrderId;
  readonly holdToken: HoldToken;
  readonly email: string;
  readonly items: readonly OrderItem[];
  readonly idempotencyKey: string | null;
  private readonly createdAtMs: number;

  private constructor(props: OrderProps) {
    this.id = props.id;
    this.holdToken = props.holdToken;
    this.email = props.email;
    // A copy, frozen: the caller still holds the original array, and an
    // order whose items grow after creation is an order whose total changes.
    this.items = Object.freeze([...props.items]);
    this.idempotencyKey = props.idempotencyKey ?? null;
    this.createdAtMs = props.createdAt.getTime();
  }

  static create(props: OrderProps): Order {
    if (props.items.length === 0) throw new InvalidOrder("an order needs at least one item");
    if (props.idempotencyKey !== undefined && props.idempotencyKey.length === 0) {
      throw new InvalidOrder("an idempotency key cannot be empty");
    }
    return new Order(props);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  total(): Money {
    return this.items.reduce(
      (sum, item) => sum.add(item.unitPrice.times(item.qty.value)),
      Money.zero(),
    );
  }
}
