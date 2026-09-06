import type Database from 'better-sqlite3';
import { makeRng, makeNormal } from './random';
import { REFERENCE_PARAMS, STOCK_PARAMS, FUND_PARAMS, DEFAULT_SEED } from './params';
import { SCENARIOS_BY_ID, type Scenario } from './scenarios';
import { ingestPrice, ingestCorrection, nextSeq, nthLatestEvent } from '../engine/ingest';

/**
 * The live price feed.
 *
 * Produces price_events using the same one-factor structure as the historical
 * backfill, so intraday attribution and the estimated betas are talking about
 * the same world. Scenarios layer shocks on top.
 *
 * Two behaviours here exist purely to be tested rather than claimed:
 *   - every write goes through the same ingestion guards a real feed would hit,
 *     so a duplicated delivery is a no-op rather than a second event;
 *   - stocks can stop ticking while fund NAVs continue, because a ten-minute-old
 *     quote is stale and a fourteen-hour-old NAV is perfectly normal.
 *
 * Note that `seq` is a per-symbol event counter owned by the feed, not this
 * tick loop (D-072). Once quotes freeze, a stock's sequence stops while the
 * funds' keep advancing, which is exactly what a real feed does.
 */

const ROOT = 'NIFTY50';
const NSE_MINUTES_PER_SESSION = 375;

export interface TickResult {
  tick: number;
  simNow: number;
  scenario: string | null;
  scenarioTick: number;
  pricesWritten: number;
  frozen: boolean;
  corrections: number;
  /**
   * The events a correction superseded this tick, so the caller can retract any
   * alert those prints caused. The ticker deliberately does not do that itself:
   * ingestion knows what was corrected, the alert policy knows who was told.
   */
  correctedEvents: Array<{ symbol: string; eventId: number }>;
}

interface SimRow {
  tick: number;
  sim_now: number;
  scenario: string | null;
  scenario_tick: number;
}

/** Opening prices, session opens and the clock. Idempotent. */
export function initSimIfEmpty(db: Database.Database, startAt = Date.parse('2026-09-04T09:15:00+05:30')): boolean {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM price_events').get() as { n: number };
  if (existing.n > 0) return false;

  const insertPrice = db.prepare(
    'INSERT INTO price_events (symbol, seq, price, as_of, ingested_at) VALUES (?, 0, ?, ?, ?)',
  );
  const insertOpen = db.prepare('INSERT INTO session_opens (symbol, open_price) VALUES (?, ?)');

  db.transaction(() => {
    for (const p of [...REFERENCE_PARAMS, ...STOCK_PARAMS, ...FUND_PARAMS]) {
      insertPrice.run(p.symbol, p.basePrice, startAt, startAt);
      insertOpen.run(p.symbol, p.basePrice);
    }
    db.prepare(
      'INSERT INTO sim_state (id, tick, sim_now, scenario, scenario_tick) VALUES (1, 0, ?, NULL, 0)',
    ).run(startAt);
  })();
  return true;
}

/** The simulated clock. Every time-dependent rule in the app reads this. */
export function simNow(db: Database.Database): number {
  return (db.prepare('SELECT sim_now AS n FROM sim_state WHERE id = 1').get() as { n: number }).n;
}

export function getSimState(db: Database.Database): SimRow {
  return db.prepare('SELECT tick, sim_now, scenario, scenario_tick FROM sim_state WHERE id = 1').get() as SimRow;
}

export function startScenario(db: Database.Database, scenarioId: string | null): void {
  if (scenarioId !== null && !SCENARIOS_BY_ID[scenarioId]) {
    throw new Error(`Unknown scenario: ${scenarioId}`);
  }
  db.prepare('UPDATE sim_state SET scenario = ?, scenario_tick = 0 WHERE id = 1').run(scenarioId);
}

/** Latest price for a symbol, or null if it has never ticked. */
export function currentPrice(db: Database.Database, symbol: string): number | null {
  const row = db
    .prepare('SELECT price FROM price_events WHERE symbol = ? ORDER BY seq DESC LIMIT 1')
    .get(symbol) as { price: number } | undefined;
  return row?.price ?? null;
}

/**
 * Advances the simulated clock by one tick and writes a price for every
 * instrument that is still publishing.
 */
export function tick(db: Database.Database, seed: number = DEFAULT_SEED): TickResult {
  const correctedEvents: Array<{ symbol: string; eventId: number }> = [];
  const state = getSimState(db);
  const scenario: Scenario | null = state.scenario ? SCENARIOS_BY_ID[state.scenario] : null;
  const nextTick = state.tick + 1;
  const nextScenarioTick = scenario ? state.scenario_tick + 1 : 0;

  // Seeded on the tick number so the same tick always produces the same prices,
  // however many times a scenario is replayed.
  const normal = makeNormal(makeRng(seed + nextTick * 7919));

  const shocks = scenario ? scenario.shocks.filter((s) => s.atTick === nextScenarioTick) : [];
  const frozen = shocks.some((s) => s.freezeQuotes);
  const marketShock = shocks.reduce((sum, s) => sum + (s.market ?? 0), 0);
  const symbolShocks = new Map<string, number>();
  for (const s of shocks) {
    if (s.symbol && s.amount) symbolShocks.set(s.symbol, (symbolShocks.get(s.symbol) ?? 0) + s.amount);
  }

  const minutesPerTick = scenario?.minutesPerTick ?? 5;
  const simNow = state.sim_now + minutesPerTick * 60_000;
  // Daily volatility scaled to the length of one tick.
  const volScale = Math.sqrt(minutesPerTick / NSE_MINUTES_PER_SESSION);

  let written = 0;
  let corrections = 0;

  db.transaction(() => {
    // 1. Root market factor.
    const rootParams = REFERENCE_PARAMS.find((p) => p.symbol === ROOT)!;
    const rootRet = rootParams.idioVol * volScale * normal() + marketShock;
    const refReturns = new Map<string, number>([[ROOT, rootRet]]);
    written += writePrice(db, ROOT, rootRet, simNow);

    // 2. Other indices follow the root.
    for (const p of REFERENCE_PARAMS.filter((r) => r.symbol !== ROOT)) {
      const r = p.beta * rootRet + p.idioVol * volScale * normal();
      refReturns.set(p.symbol, r);
      written += writePrice(db, p.symbol, r, simNow);
    }

    // 3. Stocks. These stop publishing when quotes are frozen, which is what
    //    makes the freshness gate demonstrable rather than merely claimed.
    if (!frozen) {
      for (const p of STOCK_PARAMS) {
        const refRet = refReturns.get(referenceOf(db, p.symbol)) ?? 0;
        const r = p.beta * refRet + p.idioVol * volScale * normal() + (symbolShocks.get(p.symbol) ?? 0);
        written += writePrice(db, p.symbol, r, simNow);
      }
    }

    // 4. Funds always publish here. A real NAV lands once daily, and the point
    //    of keeping them moving while quotes are frozen is to prove the system
    //    does not mistake a normal NAV for a stale one.
    for (const p of FUND_PARAMS) {
      const refRet = refReturns.get(referenceOf(db, p.symbol)) ?? 0;
      const r = p.beta * refRet + p.idioVol * volScale * normal() + (symbolShocks.get(p.symbol) ?? 0);
      written += writePrice(db, p.symbol, r, simNow);
    }

    // 5. Corrections supersede an earlier event rather than overwriting it.
    //    Counted back through real prints rather than by arithmetic on the tick
    //    number, because a symbol whose quotes were frozen did not publish on
    //    every tick and "three updates ago" has to mean three updates.
    for (const s of shocks) {
      if (!s.correct) continue;
      const target = nthLatestEvent(db, s.correct.symbol, s.correct.correctsTicksAgo);
      if (!target) continue;
      // toPrice 0 means "restore what it should have been", approximated as the
      // print immediately before the bad one.
      const before = nthLatestEvent(db, s.correct.symbol, s.correct.correctsTicksAgo + 1);
      const corrected = s.correct.toPrice || before?.price || target.price;
      const result = ingestCorrection(db, {
        symbol: s.correct.symbol,
        correctsEventId: target.id,
        price: corrected,
        asOf: simNow,
      });
      if (result.outcome === 'ACCEPTED') {
        corrections++;
        correctedEvents.push({ symbol: s.correct.symbol, eventId: target.id });
      }
    }

    db.prepare('UPDATE sim_state SET tick = ?, sim_now = ?, scenario_tick = ? WHERE id = 1').run(
      nextTick,
      simNow,
      nextScenarioTick,
    );

    // A scenario that has run its course clears itself.
    if (scenario && nextScenarioTick >= scenario.lengthTicks) {
      db.prepare('UPDATE sim_state SET scenario = NULL, scenario_tick = 0 WHERE id = 1').run();
    }
  })();

  return {
    tick: nextTick,
    simNow,
    scenario: state.scenario,
    scenarioTick: nextScenarioTick,
    pricesWritten: written,
    frozen,
    corrections,
    correctedEvents,
  };
}

function writePrice(db: Database.Database, symbol: string, ret: number, simNow: number): number {
  const last = currentPrice(db, symbol);
  if (last === null) return 0;
  const price = Math.max(0.01, last * (1 + ret));
  const result = ingestPrice(db, { symbol, seq: nextSeq(db, symbol), price, asOf: simNow });
  return result.outcome === 'ACCEPTED' ? 1 : 0;
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

/** Runs a scenario to completion. Used by tests and by the demo controls. */
export function runScenario(db: Database.Database, scenarioId: string, seed = DEFAULT_SEED): TickResult[] {
  const scenario = SCENARIOS_BY_ID[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  startScenario(db, scenarioId);
  const results: TickResult[] = [];
  for (let i = 0; i < scenario.lengthTicks; i++) results.push(tick(db, seed));
  return results;
}
