// Local mirrors of the API's response DTOs (packages/api/src/presentation/dto/
// events.ts), field for field. TB-015 replaces these with the shared types;
// until then a drift between the two is a typecheck-invisible bug.

export interface EventSummary {
  id: string;
  name: string;
  venue: string;
  startsAt: string;
}

export interface Tier {
  id: string;
  name: string;
  priceCents: number;
  total: number;
  remaining: number;
}

export interface EventDetail extends EventSummary {
  tiers: Tier[];
}
