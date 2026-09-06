import type Database from 'better-sqlite3';
import { fetchChart, fetchNav, rangeFromHistory, type DailyBar } from './client';
import { MFAPI_SCHEME } from './symbols';
import { saveStatsForSymbol } from '../engine/stats';
import { ingestPrice, nextSeq } from '../engine/ingest';
import type { InstrumentType } from '../domain/types';

/**
 * Real history, written into exactly the tables the simulated history goes
 * into. Nothing downstream can tell the difference, and that is the point:
 * `computeStatsForSymbol` reads `daily_returns` and nothing else, so the beta
 * behind a live card is estimated by the same regression, through the same code
 * path, as the beta behind a simulated one (D-012).
 *
 * The reason live mode needs this at all is a failure that would otherwise be
 * silent. Without `daily_returns` there is no `symbol_stats` row; without that
 * conviction is UNKNOWN; an UNKNOWN conviction routes every met trigger to
 * NEEDS_REVIEW as UNVERIFIABLE (D-080); and NEEDS_REVIEW is not alertable. Live
 * mode would have looked like it worked and never sent a single alert.
 */

/** The engine's window is 250 observations and it will not estimate below 120. */
export const MIN_USABLE_BARS = 200;

const DAY_MS = 24 * 60 * 60_000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/**
 * `daily_returns.day` is days since the epoch, in IST, for live data.
 *
 * The simulator writes a 0..N-1 index instead, and it can, because every series
 * is generated together and therefore aligns by construction. Real series do
 * not: a stock listed later, a session it was halted for, or a NAV file that
 * skipped a day all give two instruments different trading days. Since the
 * regression pairs a stock's return with its reference's return ON THIS COLUMN,
 * a per-symbol counter would quietly pair Monday's stock move with Tuesday's
 * index move and report a confident, wrong beta.
 *
 * A date-derived value makes equal days mean the same day, in both modes, and
 * it is why a symbol added on its own -- which is every live symbol after the
 * first -- lines up with an index fetched an hour earlier.
 */
function dayIndex(at: number): number {
  return Math.floor((at + IST_OFFSET_MS) / DAY_MS);
}

function writeReturns(db: Database.Database, symbol: string, bars: DailyBar[]): number {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO daily_returns (symbol, day, ret) VALUES (?, ?, ?)',
  );
  let written = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM daily_returns WHERE symbol = ?').run(symbol);
    for (let i = 1; i < bars.length; i += 1) {
      const prev = bars[i - 1].close;
      // Guarded rather than trusted: one zero here is an infinite return, and
      // an infinite return poisons the beta for every card on this symbol.
      if (!(prev > 0)) continue;
      insert.run(symbol, dayIndex(bars[i].at), bars[i].close / prev - 1);
      written += 1;
    }
  })();
  return written;
}

/**
 * The opening price for today's session, which is what every card's percentage
 * is measured against.
 *
 * Written with ON CONFLICT DO UPDATE rather than the plain INSERT the simulator
 * uses, for two reasons the simulator never meets: a live symbol is added while
 * the app is already running, and a live session rolls over to a new day. The
 * simulator writes this table exactly once, ever, and a second write would have
 * failed on the primary key.
 */
export function setSessionOpen(db: Database.Database, symbol: string, open: number): void {
  db.prepare(
    `INSERT INTO session_opens (symbol, open_price) VALUES (?, ?)
     ON CONFLICT(symbol) DO UPDATE SET open_price = excluded.open_price`,
  ).run(symbol, open);
}

export interface BackfilledSymbol {
  symbol: string;
  price: number;
  asOf: number;
  observations: number;
  /** Null when the feed gave too little history to estimate a beta honestly. */
  beta: number | null;
  session: { start: number; end: number } | null;
  name: string | null;
  /**
   * The 52-week range, from the same payload. Carried so that asking about an
   * instrument for the first time costs one call rather than two: the history
   * fetch already has it (D-133).
   */
  range52: { high: number; low: number } | null;
}

/**
 * Fetches one instrument's history and latest price, and leaves it in a state
 * the engine can evaluate: returns, statistics, an opening price and a price
 * event.
 *
 * If the history is too short we still write the price. A card with a real
 * price and an honest "not enough history yet to say how much of this is the
 * market" is a correct card (D-020); a card with no price at all is an inert
 * one that sits at zero forever.
 */
export async function backfillSymbol(
  db: Database.Database,
  symbol: string,
  type: InstrumentType,
  vendorId?: string,
): Promise<BackfilledSymbol> {
  const fetched =
    type === 'FUND'
      ? await fetchNav(symbol, vendorId ?? MFAPI_SCHEME[symbol])
      : await fetchChart(symbol);

  const observations = writeReturns(db, symbol, fetched.history);
  // saveStatsForSymbol, not computeStatsForSymbol: the latter computes without
  // storing, and an unstored beta is the same as no beta to every reader.
  if (observations >= MIN_USABLE_BARS) saveStatsForSymbol(db, symbol);

  // A fund's "open" is the previous NAV, because a NAV publishes once and does
  // not move during the day. Using today's NAV as its own open would make every
  // fund read as exactly 0.00% until tomorrow.
  const open =
    type === 'FUND'
      ? (fetched.history[fetched.history.length - 2]?.close ?? fetched.quote.price)
      : (('open' in fetched && fetched.open) || null) ?? fetched.quote.price;

  setSessionOpen(db, symbol, open);

  ingestPrice(db, {
    symbol,
    seq: nextSeq(db, symbol),
    price: fetched.quote.price,
    asOf: fetched.quote.asOf,
  });

  const stats = db
    .prepare('SELECT beta FROM symbol_stats WHERE symbol = ?')
    .get(symbol) as { beta: number | null } | undefined;

  return {
    symbol,
    price: fetched.quote.price,
    asOf: fetched.quote.asOf,
    observations,
    beta: stats?.beta ?? null,
    session: 'session' in fetched ? fetched.session : null,
    name: fetched.name,
    range52:
      'range52' in fetched ? fetched.range52 : rangeFromHistory(fetched.history, fetched.quote.asOf),
  };
}

/**
 * Everything the live database already knows about, refreshed from the feed.
 *
 * References first, because a stock's beta is estimated against its reference's
 * returns and those must exist before the regression runs. Same ordering
 * constraint the simulated backfill has, for the same reason.
 */
export async function backfillAll(db: Database.Database): Promise<BackfilledSymbol[]> {
  const rows = db
    .prepare(
      `SELECT symbol, instrument_type AS type, is_reference AS isRef
         FROM instruments ORDER BY is_reference DESC, symbol ASC`,
    )
    .all() as Array<{ symbol: string; type: InstrumentType; isRef: number }>;

  const done: BackfilledSymbol[] = [];
  for (const row of rows) {
    // Sequential on purpose. Fifteen parallel requests to an endpoint that
    // rate-limits is how the feed starts refusing us, and this runs once.
    done.push(await backfillSymbol(db, row.symbol, row.type));
  }
  return done;
}
