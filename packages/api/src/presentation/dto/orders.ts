import { z } from "zod";

export const CreateOrderRequest = z.object({
  holdToken: z.uuid(),
  email: z.email(),
});

// Optional here; TB-030 makes it required and answers a retry with the
// first order. Bounded so a header cannot become a long column value.
export const IdempotencyHeaders = z.object({
  "idempotency-key": z.string().min(1).max(200).optional(),
});

export const OrderResponse = z.object({
  orderId: z.string(),
  holdToken: z.string(),
  email: z.string(),
  totalCents: z.int().nonnegative(),
  items: z.array(
    z.object({
      tierId: z.string(),
      qty: z.int().positive(),
      unitPriceCents: z.int().nonnegative(),
    }),
  ),
  createdAt: z.iso.datetime(),
});

export type CreateOrderDto = z.infer<typeof CreateOrderRequest>;
export type OrderDto = z.infer<typeof OrderResponse>;
