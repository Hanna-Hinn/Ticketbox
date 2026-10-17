import pg from "pg";

// pg's defaults wait forever: for a connection to a host that black-holes
// SYNs (~127 s per attempt on Linux) and for a query blocked behind a row
// lock (TB-029's checkout transaction will lock exactly the rows the
// sweeper marks). A request or a sweep that never settles is worse than
// one that fails — the sweeper's overlap guard would skip every later
// tick, silently, for as long as the first one hangs (TB-026 review).
// Five seconds is far above any query this system runs (the computed
// count is ~23 ms, TB-013) and far below "forever".
export interface PoolTimeouts {
  readonly connectionTimeoutMs: number;
  readonly queryTimeoutMs: number;
}

export const DEFAULT_POOL_TIMEOUTS: PoolTimeouts = {
  connectionTimeoutMs: 5_000,
  queryTimeoutMs: 5_000,
};

export function createPool(
  connectionString: string,
  timeouts: PoolTimeouts = DEFAULT_POOL_TIMEOUTS,
): pg.Pool {
  return new pg.Pool({
    connectionString,
    connectionTimeoutMillis: timeouts.connectionTimeoutMs,
    query_timeout: timeouts.queryTimeoutMs,
  });
}
