import type Database from 'better-sqlite3';
import { backfillSymbol } from './backfill';
import {
  fetchChartByTicker,
  fetchNav,
  rangeFromHistory,
  searchFunds,
  searchIndices,
  searchStocks,
  type SearchHit,
} from './client';
import type { InstrumentType } from '../domain/types';

/**
 * Adding an instrument the app has never heard of.
 *
 * In simulated mode the universe is twelve rows written once at boot. In live
 * mode it grows: someone searches for a stock, picks it, and it has to become a
 * fully working card. "Fully working" is a longer list than it looks, and every
 * item on it is something that fails silently if skipped:
 *
 *   - an `instruments` row, or `ingestPrice` drops every tick for it as
 *     UNKNOWN_SYMBOL and `addItem` refuses it outright;
 *   - a reference, or conviction has nothing to attribute the move against;
 *   - `daily_returns`, or there is no beta;
 *   - a `symbol_stats` row, or conviction is UNKNOWN, which routes every
 *     trigger to NEEDS_REVIEW and means the card can never alert;
 *   - a `session_opens` row, or `priceFor` returns null and `evaluateSymbol`
 *     returns an empty array with no error at all -- the card sits at zero,
 *     in WATCHING, forever;
 *   - a price event, or there is nothing to render.
 *
 * `backfillSymbol` does the last four. This module does the first two and ties
 * the whole thing to one transaction boundary.
 */

/**
 * Every live stock is attributed against the Nifty 50, and every unknown fund
 * against the Nifty 500.
 *
 * For a stock that is simply correct: it is the market index, which is what a
 * single-factor model means by "the market".
 *
 * For a fund it is an ASSUMPTION and the card says so. mfapi does not carry a
 * scheme's stated benchmark, and a broad-market index is the least wrong stand-in
 * for a diversified equity fund. It is genuinely wrong for a sector or debt
 * fund, which is exactly why it is labelled rather than quietly applied: a
 * single-factor model against the wrong reference produces a plausible number,
 * and a plausible wrong number about someone's money is what this product
 * exists to argue against.
 */
export const LIVE_STOCK_REFERENCE = 'NIFTY50';
export const LIVE_FUND_REFERENCE = 'NIFTY500';

export interface EnsureResult {
  symbol: string;
  name: string;
  type: InstrumentType;
  /** True when the reference is a stand-in rather than the fund's stated one. */
  assumedBenchmark: boolean;
  observations: number;
  beta: number | null;
  price: number;
  /**
   * The 52-week range, when this call fetched history and the payload carried
   * one. Null for an instrument that was already known, whose caller can make
   * one light call for it instead of re-downloading two years (D-135).
   */
  range52: { high: number; low: number } | null;
}

export function isKnown(db: Database.Database, symbol: string): boolean {
  const row = db.prepare('SELECT 1 AS n FROM instruments WHERE symbol = ?').get(symbol);
  return row !== undefined;
}

/**
 * Makes a searched instrument into one this app can evaluate, or leaves the
 * database exactly as it found it.
 *
 * The instrument row is written first because `ingestPrice` and
 * `computeStatsForSymbol` both refuse an unknown symbol, and it is rolled back
 * by hand if the fetch then fails. A half-added instrument -- a row with no
 * history and no opening price -- is the worst of the outcomes here, because it
 * produces a permanently inert card rather than an error anyone can see.
 */
export async function ensureInstrument(
  db: Database.Database,
  hit: SearchHit,
): Promise<EnsureResult> {
  const existing = db
    .prepare('SELECT name, instrument_type AS type, reference_symbol AS ref FROM instruments WHERE symbol = ?')
    .get(hit.symbol) as { name: string; type: InstrumentType; ref: string | null } | undefined;

  /*
   * An index is never an instrument (D-074). Refused here, on the server, in
   * the one function every add path and the Ask path share, so that widening
   * the search to indices for one panel cannot leak an index onto the board
   * through any route -- a UI rule alone would be a suggestion (D-075).
   */
  if (hit.type === 'INDEX') {
    throw new Error(`${hit.symbol} is an index and cannot be watched as a card`);
  }

  if (existing) {
    const stats = db
      .prepare('SELECT beta FROM symbol_stats WHERE symbol = ?')
      .get(hit.symbol) as { beta: number | null } | undefined;
    const obs = (
      db.prepare('SELECT COUNT(*) AS n FROM daily_returns WHERE symbol = ?').get(hit.symbol) as {
        n: number;
      }
    ).n;
    const price = (
      db
        .prepare('SELECT price FROM price_events WHERE symbol = ? ORDER BY seq DESC LIMIT 1')
        .get(hit.symbol) as { price: number } | undefined
    )?.price;
    return {
      symbol: hit.symbol,
      name: existing.name,
      type: existing.type,
      assumedBenchmark: existing.type === 'FUND' && existing.ref === LIVE_FUND_REFERENCE,
      observations: obs,
      beta: stats?.beta ?? null,
      price: price ?? 0,
      range52: null,
    };
  }

  const reference = hit.type === 'FUND' ? LIVE_FUND_REFERENCE : LIVE_STOCK_REFERENCE;
  db.prepare(
    `INSERT INTO instruments (symbol, name, instrument_type, reference_symbol, sector, is_reference)
     VALUES (?, ?, ?, ?, NULL, 0)`,
  ).run(hit.symbol, hit.name, hit.type as InstrumentType, reference);

  let filled;
  try {
    filled = await backfillSymbol(db, hit.symbol, hit.type as InstrumentType, hit.vendorId);
  } catch (err) {
    // Undo by hand rather than with a transaction, because the fetch in the
    // middle is asynchronous and better-sqlite3's transactions are synchronous.
    // Order matters: the child rows first, or the foreign key refuses.
    db.prepare('DELETE FROM daily_returns WHERE symbol = ?').run(hit.symbol);
    db.prepare('DELETE FROM session_opens WHERE symbol = ?').run(hit.symbol);
    db.prepare('DELETE FROM symbol_stats WHERE symbol = ?').run(hit.symbol);
    db.prepare('DELETE FROM price_events WHERE symbol = ?').run(hit.symbol);
    db.prepare('DELETE FROM instruments WHERE symbol = ?').run(hit.symbol);
    throw err;
  }

  return {
    symbol: hit.symbol,
    name: filled.name ?? hit.name,
    type: hit.type,
    assumedBenchmark: hit.type === 'FUND',
    observations: filled.observations,
    beta: filled.beta,
    price: filled.price,
    range52: filled.range52,
  };
}

/**
 * Search, split by instrument type because the two go to different APIs.
 *
 * The type is chosen by the user before they type, and that is a requirement
 * rather than a convenience: `instrument_type` decides the reference, the
 * staleness limit, which thesis templates apply and the order unit. A merged
 * search would have to guess it from the result shape, and a fund landing as a
 * stock would be flagged stale all day, which is the wolf-crying D-025 exists
 * to prevent.
 *
 * Anything already in the watchlist is still returned. The duplicate rule lives
 * in addItem and offers to edit the existing thesis, which is a better answer
 * than a result silently missing from a search.
 */
export async function searchInstruments(
  type: InstrumentType | 'INDEX',
  query: string,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  if (type === 'INDEX') return searchIndices(q);
  return type === 'FUND' ? searchFunds(q) : searchStocks(q);
}

/**
 * An index, read and not stored.
 *
 * Reversing D-074 for the Ask panel bought exactly one thing: the ability to
 * say what an index did today. It writes nothing -- no instrument row, no
 * returns, no statistics -- because an index has no reference to be measured
 * against and a stats row for it would be a confident number about nothing.
 * The three references the engine already tracks are answered from the board
 * instead (see `knownReferenceFor`), which is where their history lives.
 */
export interface IndexQuote {
  price: number;
  asOf: number;
  /** Move since today's open as a fraction, when the payload carries an open. */
  changeSinceOpen: number | null;
  high52: number | null;
  low52: number | null;
  name: string | null;
}

export async function indexQuote(vendorId: string): Promise<IndexQuote> {
  const chart = await fetchChartByTicker(vendorId, '1d');
  const open = chart.open;
  return {
    price: chart.quote.price,
    asOf: chart.quote.asOf,
    changeSinceOpen: open !== null && open > 0 ? chart.quote.price / open - 1 : null,
    high52: chart.range52?.high ?? null,
    low52: chart.range52?.low ?? null,
    name: chart.name,
  };
}

/**
 * The price and 52-week range for something that is not on the board yet.
 *
 * This exists for one moment: the form asks for a threshold, and until now it
 * asked for it with nothing on screen to judge it against. You would type
 * "buy if it rises above" into a blank against a stock whose price you could
 * not see, and a number outside the last year's range is a thesis that cannot
 * fire (D-126).
 *
 * It is one extra call per instrument someone actually considers, and it goes
 * through the same client, timeout and rate-limit back-off as everything else.
 * A failure returns null rather than throwing: the anchor is help, and help
 * that can block an add is worse than no help.
 */
export interface InstrumentQuote {
  price: number;
  asOf: number;
  high52: number | null;
  low52: number | null;
}

export async function quoteFor(
  type: InstrumentType,
  vendorId: string,
): Promise<InstrumentQuote> {
  if (type === 'FUND') {
    const nav = await fetchNav(vendorId, vendorId);
    const range = rangeFromHistory(nav.history, Date.now());
    return {
      price: nav.quote.price,
      asOf: nav.quote.asOf,
      high52: range?.high ?? null,
      low52: range?.low ?? null,
    };
  }
  // One day of bars, not two years: the range comes from the exchange's own
  // field in the same payload, so the history would be fetched and thrown away.
  const chart = await fetchChartByTicker(vendorId, '1d');
  return {
    price: chart.quote.price,
    asOf: chart.quote.asOf,
    high52: chart.range52?.high ?? null,
    low52: chart.range52?.low ?? null,
  };
}
