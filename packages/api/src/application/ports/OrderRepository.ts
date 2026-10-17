import type { Order } from "../../domain/entities/Order.js";

// Kind A: what happened. An order and its items land together (TB-029).
export interface OrderRepository {
  save(order: Order): Promise<void>;
}
