import type pg from "pg";
import type { EventRepository } from "../../application/ports/EventRepository.js";
import { Event } from "../../domain/entities/Event.js";
import { TicketTier } from "../../domain/entities/TicketTier.js";
import { eventId, tierId, type EventId } from "../../domain/value-objects/Ids.js";
import { Money } from "../../domain/value-objects/Money.js";

// Kind A: what exists. The computed availability here is the Postgres half
// of ADR 0002 — the number the live counter is rebuilt from, and the query
// TB-013 benchmarks unindexed before adding the composite index.

interface EventRow {
  id: string;
  name: string;
  venue: string;
  starts_at: Date;
}

interface TierRow {
  id: string;
  event_id: string;
  name: string;
  price_cents: number;
  total_qty: number;
  remaining: number;
}

// "Active" means the mirror row's status, nothing about expires_at: this
// adapter has no clock, and a hold the sweeper has not yet marked expired
// still counts as held here (under-reports, never over-sells — ADR 0002).
// SUM over an integer column is bigint, which node-postgres hands back as a
// string; the ::int cast keeps that out of the mapper.
const TIERS_FOR_EVENTS = `
  SELECT t.id, t.event_id, t.name, t.price_cents, t.total_qty,
         GREATEST(0, t.total_qty
           - COALESCE((SELECT SUM(oi.qty) FROM order_items oi WHERE oi.tier_id = t.id), 0)
           - COALESCE((SELECT SUM(h.qty)  FROM holds h       WHERE h.tier_id = t.id AND h.status = 'active'), 0)
         )::int AS remaining
  FROM ticket_tiers t
  WHERE t.event_id = ANY($1)
  ORDER BY t.event_id, t.price_cents`;

export class PgEventRepository implements EventRepository {
  // A Pool for the composition root; a ClientBase (Client or PoolClient) so a
  // test can wrap each case in BEGIN … ROLLBACK on one connection.
  constructor(private readonly db: pg.Pool | pg.ClientBase) {}

  async findById(id: EventId): Promise<Event | null> {
    const events = await this.db.query<EventRow>(
      "SELECT id, name, venue, starts_at FROM events WHERE id = $1",
      [id],
    );
    const row = events.rows[0];
    if (row === undefined) return null;
    const tiers = await this.tiersFor([row.id]);
    return toEvent(row, tiers.get(row.id) ?? []);
  }

  async listUpcoming(now: Date): Promise<readonly Event[]> {
    const events = await this.db.query<EventRow>(
      "SELECT id, name, venue, starts_at FROM events WHERE starts_at > $1 ORDER BY starts_at, id",
      [now],
    );
    const tiers = await this.tiersFor(events.rows.map((row) => row.id));
    return events.rows.map((row) => toEvent(row, tiers.get(row.id) ?? []));
  }

  private async tiersFor(ids: readonly string[]): Promise<Map<string, TicketTier[]>> {
    const grouped = new Map<string, TicketTier[]>();
    if (ids.length === 0) return grouped;
    const result = await this.db.query<TierRow>(TIERS_FOR_EVENTS, [ids]);
    for (const row of result.rows) {
      const list = grouped.get(row.event_id) ?? [];
      list.push(toTier(row));
      grouped.set(row.event_id, list);
    }
    return grouped;
  }
}

function toEvent(row: EventRow, tiers: readonly TicketTier[]): Event {
  return Event.create({
    id: eventId(row.id),
    name: row.name,
    venue: row.venue,
    startsAt: row.starts_at,
    tiers,
  });
}

function toTier(row: TierRow): TicketTier {
  return TicketTier.create({
    id: tierId(row.id),
    eventId: eventId(row.event_id),
    name: row.name,
    price: Money.fromCents(row.price_cents),
    total: row.total_qty,
    remaining: row.remaining,
  });
}
