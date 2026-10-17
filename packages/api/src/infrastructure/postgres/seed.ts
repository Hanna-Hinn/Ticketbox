import type { Client } from "pg";

// Every row has a fixed id and is inserted with ON CONFLICT DO NOTHING.
// That is the whole idempotency mechanism: a second run matches every
// primary key and inserts nothing. Fixed ids also let later smoke tests
// GET /events/<known id> without querying first.
//
// starts_at is an offset from the seed run, not a calendar date: GET /events
// lists *upcoming* events (TB-010 listUpcoming), and a fixed date would make
// a fresh clone seed an empty-looking box office once that date has passed.

interface SeedTier {
  id: string;
  name: string;
  priceCents: number;
  totalQty: number;
}

interface SeedEvent {
  id: string;
  name: string;
  venue: string;
  startsIn: string; // Postgres interval literal, relative to the first seed run
  tiers: SeedTier[];
}

export const SEED_EVENTS: readonly SeedEvent[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Rooftop Jazz Night",
    venue: "The Terrace, Ramallah",
    startsIn: "7 weeks",
    tiers: [
      {
        id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
        name: "General",
        priceCents: 2000,
        totalQty: 1000,
      },
      {
        id: "11111111-1111-4111-8111-bbbbbbbbbbbb",
        name: "Balcony",
        priceCents: 3500,
        totalQty: 200,
      },
      // Deliberately 0 so "sold out" is visible in the UI (TB-004 Scope line).
      { id: "11111111-1111-4111-8111-cccccccccccc", name: "VIP", priceCents: 8000, totalQty: 0 },
    ],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Late Night Comedy",
    venue: "Basement Club",
    startsIn: "8 weeks",
    tiers: [
      {
        id: "22222222-2222-4222-8222-aaaaaaaaaaaa",
        name: "General",
        priceCents: 1500,
        totalQty: 1000,
      },
      {
        id: "22222222-2222-4222-8222-bbbbbbbbbbbb",
        name: "Balcony",
        priceCents: 2500,
        totalQty: 200,
      },
      { id: "22222222-2222-4222-8222-cccccccccccc", name: "VIP", priceCents: 6000, totalQty: 50 },
    ],
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Indie Film Marathon",
    venue: "Cinema Paradiso",
    startsIn: "9 weeks",
    tiers: [
      {
        id: "33333333-3333-4333-8333-aaaaaaaaaaaa",
        name: "General",
        priceCents: 1200,
        totalQty: 1000,
      },
      {
        id: "33333333-3333-4333-8333-bbbbbbbbbbbb",
        name: "Balcony",
        priceCents: 1800,
        totalQty: 200,
      },
      { id: "33333333-3333-4333-8333-cccccccccccc", name: "VIP", priceCents: 4000, totalQty: 50 },
    ],
  },
];

export async function seed(client: Client): Promise<{ events: number; tiers: number }> {
  let events = 0;
  let tiers = 0;
  for (const event of SEED_EVENTS) {
    const inserted = await client.query(
      `INSERT INTO events (id, name, venue, starts_at)
       VALUES ($1, $2, $3, now() + $4::interval)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.name, event.venue, event.startsIn],
    );
    events += inserted.rowCount ?? 0;

    for (const tier of event.tiers) {
      const insertedTier = await client.query(
        `INSERT INTO ticket_tiers (id, event_id, name, price_cents, total_qty)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [tier.id, event.id, tier.name, tier.priceCents, tier.totalQty],
      );
      tiers += insertedTier.rowCount ?? 0;
    }
  }
  return { events, tiers };
}
