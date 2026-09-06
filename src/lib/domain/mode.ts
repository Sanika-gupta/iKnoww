import type Database from 'better-sqlite3';

/**
 * Which feed a database is running against.
 *
 * There are two modes and one engine. Simulated mode is the default, is
 * self-contained, and is byte-identical to what it was before live mode
 * existed. Live mode runs the SAME conviction model, state machine, alert
 * policy, orders and Ask panel against real NSE prices.
 *
 * The mode lives in three places and nowhere else:
 *
 *   1. `?mode=live` on the request, read by `modeFrom` below. It is a SEARCH
 *      PARAM rather than a body field because five handlers and the SSE stream
 *      read no body at all, and a rule with five exceptions is how a request
 *      ends up silently hitting the wrong database.
 *   2. The database handle it selects, which is a different file per mode.
 *   3. A `mode` column on `sim_state`, so code deep in the engine can ask what
 *      it is running against without every function growing a parameter.
 *
 * The third is the one worth explaining. The staleness gate differs by mode: a
 * live quote is fifteen minutes behind the exchange, and the stock limit is ten
 * minutes, so without a wider limit in live mode every real quote would be
 * stale and no card could ever change state. Threading a `mode` argument down
 * to it would have touched six call sites through conviction, states, board,
 * ask and orders. The engine already holds the database handle, and the handle
 * already knows its own mode, so it reads it from there.
 */

export type FeedMode = 'sim' | 'live';

export const DEFAULT_MODE: FeedMode = 'sim';

export function isFeedMode(value: unknown): value is FeedMode {
  return value === 'sim' || value === 'live';
}

/**
 * The mode a request is asking for. Anything unrecognised, absent or malformed
 * falls back to simulated, because that is the mode that always works.
 */
export function modeFrom(request: Request): FeedMode {
  const raw = new URL(request.url).searchParams.get('mode');
  return isFeedMode(raw) ? raw : DEFAULT_MODE;
}

/**
 * The mode a database is running against, read from its own `sim_state` row.
 *
 * Defaults to simulated when the row is missing, which is what a half-built
 * test fixture looks like. That is the safe direction: the simulated staleness
 * limits are the stricter pair, so a wrong answer here makes the engine more
 * cautious rather than less.
 */
export function feedModeOf(db: Database.Database): FeedMode {
  const row = db.prepare('SELECT mode FROM sim_state WHERE id = 1').get() as
    | { mode: string }
    | undefined;
  return isFeedMode(row?.mode) ? row.mode : DEFAULT_MODE;
}
