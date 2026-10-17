// Branded IDs: a TierId is not assignable to an EventId even though both are
// strings at runtime. This domain passes the wrong ID around constantly if
// the compiler is not told the difference.
export type EventId = string & { readonly __brand: "EventId" };
export type TierId = string & { readonly __brand: "TierId" };
export type OrderId = string & { readonly __brand: "OrderId" };

// The constructors validate nothing: whether a string is a well-formed UUID is
// the boundary's job (Zod, TB-011). These are the only places a plain string
// becomes an ID, which is why each cast is acceptable here and nowhere else.
export function eventId(value: string): EventId {
  return value as EventId; // brand cast — see above
}

export function tierId(value: string): TierId {
  return value as TierId; // brand cast — see above
}

export function orderId(value: string): OrderId {
  return value as OrderId; // brand cast — see above
}
