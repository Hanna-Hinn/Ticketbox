import { z } from "zod";

export const CreateOrderRequest = z.object({
  holdToken: z.uuid(),
  email: z.email(),
});

// Required (TB-030): the same request twice must cost once, and the key is
// how the server knows it is the same. Bounded so a header cannot become a
// long column value or a long Redis key.
export const IdempotencyHeaders = z.object({
  "idempotency-key": z.string().min(1).max(200),
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
