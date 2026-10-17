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
}

// A hold that was confirmed before its timer ran out. Permanent.
export class Order {
  readonly id: OrderId;
  readonly holdToken: HoldToken;
  readonly email: string;
  readonly items: readonly OrderItem[];
  readonly createdAt: Date;

  private constructor(props: OrderProps) {
    this.id = props.id;
    this.holdToken = props.holdToken;
    this.email = props.email;
    this.items = props.items;
    this.createdAt = props.createdAt;
  }

  static create(props: OrderProps): Order {
    if (props.items.length === 0) throw new InvalidOrder("an order needs at least one item");
    return new Order(props);
  }

  total(): Money {
    return this.items.reduce(
      (sum, item) => sum.add(item.unitPrice.times(item.qty.value)),
      Money.zero(),
    );
  }
}
