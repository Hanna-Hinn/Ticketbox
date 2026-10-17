// The same request twice must cost once (TB-030). The first request with a
// key claims it, does the work and stores what it answered; later ones get
// that answer back; a concurrent one is told to wait. The constraint in
// Postgres is the truth behind this; this is the speed in front of it.
export interface StoredResponse {
  readonly status: number;
  /** The serialised body, replayed byte for byte. */
  readonly body: string;
}

export type BeginOutcome =
  | { outcome: "won" }
  | { outcome: "in-progress" }
  | { outcome: "mismatch" }
  | { outcome: "replay"; response: StoredResponse };

export interface IdempotencyStore {
  /** Claim the key for this fingerprint, or learn what became of it. */
  begin(key: string, fingerprint: string): Promise<BeginOutcome>;
  /** The winner's answer, kept for as long as the claim. */
  complete(key: string, fingerprint: string, response: StoredResponse): Promise<void>;
  /** The winner failed on our side: let the next request with this key try. */
  abandon(key: string): Promise<void>;
}
