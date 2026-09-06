import type Database from 'better-sqlite3';
import { makeRng, makeNormal } from './random';
import {
  REFERENCE_PARAMS,
  STOCK_PARAMS,
  FUND_PARAMS,
  BACKFILL_DAYS,
  DEFAULT_SEED,
} from './params';

/**
 * Generates the price history the conviction engine learns from.
 *
 * The factor model, for instrument i on day t against its reference:
 *
 *     r(i,t)  =  beta(i) * r(ref,t)  +  idioVol(i) * N(0,1)
 *
 * NIFTY50 is the root factor and is generated first; the other two indices are
 * generated from it, which is why a broad fall moves everything at once and why
 * "82% of this move was the market" is a true statement rather than a slogan.
 *
 * Written into daily_returns. The engine reads ONLY this table, never the
 * generator parameters that produced it.
 */

const ROOT = 'NIFTY50';

export interface BackfillResult {
  days: number;
  symbols: number;
  rows: number;
}

export function backfillIfEmpty(
  db: Database.Database,
  seed: number = DEFAULT_SEED,
  days: number = BACKFILL_DAYS,
): BackfillResult | null {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM daily_returns').get() as { n: number };
  if (existing.n > 0) return null;
  return backfill(db, seed, days);
}

export function backfill(
  db: Database.Database,
  seed: number = DEFAULT_SEED,
  days: number = BACKFILL_DAYS,
): BackfillResult {
  const rng = makeRng(seed);
  const normal = makeNormal(rng);

  // Day-by-day so that every instrument on day t sees the SAME reference return.
  // Generating per-symbol instead would destroy the correlation structure and
  // the whole product with it.
  const returns = new Map<string, number[]>();
  const root = REFERENCE_PARAMS.find((p) => p.symbol === ROOT)!;
  const otherRefs = REFERENCE_PARAMS.filter((p) => p.symbol !== ROOT);
  const nonRefs = [...STOCK_PARAMS, ...FUND_PARAMS];

  for (const p of [...REFERENCE_PARAMS, ...nonRefs]) returns.set(p.symbol, []);

  for (let day = 0; day < days; day++) {
    // 1. The root market factor moves.
    const rootRet = root.idioVol * normal();
    returns.get(ROOT)!.push(rootRet);

    // 2. The other indices are driven by it, plus a little of their own.
    const refReturns = new Map<string, number>([[ROOT, rootRet]]);
    for (const p of otherRefs) {
      const r = p.beta * rootRet + p.idioVol * normal();
      returns.get(p.symbol)!.push(r);
      refReturns.set(p.symbol, r);
    }

    // 3. Stocks and funds are driven by their own reference.
    for (const p of nonRefs) {
      const refSymbol = referenceOf(db, p.symbol);
      const refRet = refReturns.get(refSymbol) ?? 0;
      const r = p.beta * refRet + p.idioVol * normal();
      returns.get(p.symbol)!.push(r);
    }
  }

  const insert = db.prepare(
    'INSERT INTO daily_returns (symbol, day, ret) VALUES (?, ?, ?)',
  );
  let rows = 0;
  db.transaction(() => {
    for (const [symbol, series] of returns) {
      for (let day = 0; day < series.length; day++) {
        insert.run(symbol, day, series[day]);
        rows++;
      }
    }
  })();

  return { days, symbols: returns.size, rows };
}

/*
 * Keyed on the DATABASE as well as the symbol, and that is not defensive
 * clutter. This map is module-level, so it outlives any one request. With two
 * databases -- a simulated one and a live one -- a symbol whose reference was
 * resolved in one mode would be answered from the other's cache, silently, for
 * the life of the process. A WeakMap also lets a closed database be collected
 * rather than pinning it here forever.
 */
const refCache = new WeakMap<Database.Database, Map<string, string>>();

function referenceOf(db: Database.Database, symbol: string): string {
  let perDb = refCache.get(db);
  if (!perDb) {
    perDb = new Map<string, string>();
    refCache.set(db, perDb);
  }
  const hit = perDb.get(symbol);
  if (hit) return hit;
  const row = db
    .prepare('SELECT reference_symbol AS ref FROM instruments WHERE symbol = ?')
    .get(symbol) as { ref: string | null } | undefined;
  const ref = row?.ref ?? ROOT;
  perDb.set(symbol, ref);
  return ref;
}
