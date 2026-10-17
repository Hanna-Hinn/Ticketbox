import type {
  BeginOutcome,
  IdempotencyStore,
  StoredResponse,
} from "../../src/application/ports/IdempotencyStore.js";

type Entry =
  | { state: "in-progress"; fingerprint: string }
  | { state: "done"; fingerprint: string; response: StoredResponse };

// The claim and the answer on a Map. begin() decides before its first
// await, so ten concurrent requests in one process see exactly one winner,
// as SET NX gives them against Redis.
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  async begin(key: string, fingerprint: string): Promise<BeginOutcome> {
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, { state: "in-progress", fingerprint });
      return { outcome: "won" };
    }
    if (existing.fingerprint !== fingerprint) return { outcome: "mismatch" };
    if (existing.state === "in-progress") return { outcome: "in-progress" };
    return { outcome: "replay", response: existing.response };
  }

  async complete(key: string, fingerprint: string, response: StoredResponse): Promise<void> {
    this.entries.set(key, { state: "done", fingerprint, response });
  }

  async abandon(key: string): Promise<void> {
    this.entries.delete(key);
  }

  stateOf(key: string): "in-progress" | "done" | undefined {
    return this.entries.get(key)?.state;
  }
}
