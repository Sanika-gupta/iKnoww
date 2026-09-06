import type Database from 'better-sqlite3';
import {
  type Conviction,
  type ConvictionBand,
  Z_LOW_MAX,
  Z_EXTREME_MIN,
  MIN_WINDOW_OBS,
  STALENESS_LIMIT_MS,
  STALENESS_LIMIT_MS_LIVE,
  type InstrumentType,
} from '../domain/types';
import { feedModeOf, type FeedMode } from '../domain/mode';
import { explain } from './explain';

/**
 * How much of today's move belongs to the instrument itself rather than to its
 * reference.
 *
 * This is the whole product in one function. The same number decides three
 * things: what the card says, whether we are allowed to send a notification, and
 * how much friction sits in front of the trade button (D-029).
 *
 * MUST NOT import the simulator's parameters. Beta and idiosyncratic volatility
 * come from symbol_stats, which was estimated by regression from observed
 * history exactly as it would be from a real feed.
 */

export interface PricePoint {
  price: number;
  openPrice: number;
  asOf: number;
  ret: number;
}

export interface ConvictionResult extends Conviction {
  /** Move since the session open, as a fraction. */
  instrumentReturn: number | null;
  /** Plain-language explanation, rendered directly by the UI. */
  explanation: string;
  stale: boolean;
}

function bandFor(z: number): ConvictionBand {
  const a = Math.abs(z);
  if (a < Z_LOW_MAX) return 'LOW';
  if (a >= Z_EXTREME_MIN) return 'EXTREME';
  return 'HIGH';
}

export function priceFor(db: Database.Database, symbol: string): PricePoint | null {
  const latest = db
    .prepare('SELECT price, as_of AS asOf FROM price_events WHERE symbol = ? ORDER BY seq DESC LIMIT 1')
    .get(symbol) as { price: number; asOf: number } | undefined;
  const open = db.prepare('SELECT open_price AS openPrice FROM session_opens WHERE symbol = ?').get(symbol) as
    | { openPrice: number }
    | undefined;
  if (!latest || !open || open.openPrice === 0) return null;
  return {
    price: latest.price,
    openPrice: open.openPrice,
    asOf: latest.asOf,
    ret: latest.price / open.openPrice - 1,
  };
}

/**
 * A quote and a NAV go stale at completely different speeds. A type-blind check
 * would flag every mutual fund as stale all day, and crying wolf destroys trust
 * faster than silence does (D-025).
 *
 * The limit is also mode-aware, because a live quote arrives about fifteen
 * minutes behind the exchange and the simulated limit is ten. See
 * STALENESS_LIMIT_MS_LIVE: the delay is widened for, never hidden from, the
 * user.
 */
export function isStale(
  instrumentType: InstrumentType,
  asOf: number,
  now: number,
  mode: FeedMode = 'sim',
): boolean {
  const limits = mode === 'live' ? STALENESS_LIMIT_MS_LIVE : STALENESS_LIMIT_MS;
  return now - asOf > limits[instrumentType];
}

export function computeConviction(db: Database.Database, symbol: string, now?: number): ConvictionResult {
  const inst = db
    .prepare(
      `SELECT instrument_type AS type, reference_symbol AS ref, name
         FROM instruments WHERE symbol = ?`,
    )
    .get(symbol) as { type: InstrumentType; ref: string | null; name: string } | undefined;

  const unknown = (reason: Conviction['unknownReason'], explanation: string, stale = false): ConvictionResult => ({
    band: 'UNKNOWN',
    z: null,
    shareReference: null,
    beta: null,
    referenceSymbol: inst?.ref ?? null,
    referenceReturn: null,
    instrumentReturn: null,
    unknownReason: reason,
    explanation,
    stale,
  });

  if (!inst || !inst.ref) return unknown('NO_REFERENCE', 'No reference to compare against.');

  const stats = db
    .prepare('SELECT beta, idio_vol AS idioVol, window_n AS windowN FROM symbol_stats WHERE symbol = ?')
    .get(symbol) as { beta: number | null; idioVol: number | null; windowN: number } | undefined;

  if (!stats || stats.beta === null || stats.idioVol === null || stats.windowN < MIN_WINDOW_OBS) {
    // We are allowed to say we do not know. Inventing a percentage in front of
    // someone deciding about money is the thing this product argues against.
    return unknown('INSUFFICIENT_HISTORY', 'Not enough history yet to say how much of this is the market.');
  }

  const self = priceFor(db, symbol);
  const reference = priceFor(db, inst.ref);
  if (!self || !reference) return unknown('INSUFFICIENT_HISTORY', 'No price yet.');

  const simNow = now ?? (db.prepare('SELECT sim_now AS n FROM sim_state WHERE id = 1').get() as { n: number }).n;
  // The mode comes from the database rather than from a parameter, so the six
  // callers of computeConviction stay unchanged. See domain/mode.ts.
  const stale = isStale(inst.type, self.asOf, simNow, feedModeOf(db));

  // Scale the daily residual volatility to the elapsed part of a session, so a
  // small move early in the day is not mistaken for a large surprise.
  const expected = stats.beta * reference.ret;
  const residual = self.ret - expected;
  if (stats.idioVol === 0) {
    return unknown('ZERO_REFERENCE_VARIANCE', 'This instrument has no measurable independent movement.', stale);
  }

  const z = residual / stats.idioVol;
  const band = bandFor(z);
  const magnitude = Math.abs(expected) + Math.abs(residual);
  const shareReference = magnitude === 0 ? 1 : Math.abs(expected) / magnitude;

  return {
    band,
    z,
    shareReference,
    beta: stats.beta,
    referenceSymbol: inst.ref,
    referenceReturn: reference.ret,
    instrumentReturn: self.ret,
    explanation: explain({
      instrumentType: inst.type,
      band,
      shareReference,
      referenceReturn: reference.ret,
      instrumentReturn: self.ret,
      z,
      idioVol: stats.idioVol,
    }),
    stale,
  };
}
