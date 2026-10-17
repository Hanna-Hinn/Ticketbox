import type { Event } from "../../domain/entities/Event.js";
import type { EventId } from "../../domain/value-objects/Ids.js";

// Kind A: what exists. Postgres behind it (TB-010). Every Event comes back
// with its tiers loaded: the type can say "no tiers" but cannot say "not
// loaded", so a half-loaded Event would be indistinguishable from a real one.
export interface EventRepository {
  findById(id: EventId): Promise<Event | null>;
  // starts_at after `now`. The repository is not allowed to ask the system
  // clock either; the caller passes the instant in.
  listUpcoming(now: Date): Promise<readonly Event[]>;
}
