import { describe, it, expect, beforeAll } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { initSimIfEmpty, runScenario, currentPrice } from '../../src/lib/sim/ticker';
import { computeConviction } from '../../src/lib/engine/conviction';

/**
 * The claim the entire product rests on:
 *
 *   when the whole market falls, a stock falling with it is NOT a stock-specific
 *   event, and the app must say so.
 *
 * If this test fails, the demo's central moment is a lie.
 */

describe('a market-wide fall is attributed to the market, not to your stocks', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    runScenario(db, 'market-crash');
  });

  it('actually moves the market down', () => {
    const c = computeConviction(db, 'RELIANCE');
    expect(c.referenceReturn).not.toBeNull();
    expect(c.referenceReturn!).toBeLessThan(-0.02);
  });

  it('drags every stock down with it', () => {
    for (const s of ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'MARUTI', 'ITC']) {
      const c = computeConviction(db, s);
      expect(c.instrumentReturn!, `${s} should be down`).toBeLessThan(0);
    }
  });

  it('attributes most of each stock move to the market', () => {
    // The headline number on the contradiction card. If this is not high, the
    // card cannot honestly say "this is not your dip".
    const shares = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'MARUTI', 'ITC'].map(
      (s) => computeConviction(db, s).shareReference!,
    );
    const median = shares.sort((a, b) => a - b)[Math.floor(shares.length / 2)];
    expect(median).toBeGreaterThan(0.7);
  });

  it('scores conviction LOW for the typical stock, so nothing is actionable', () => {
    const bands = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'MARUTI', 'ITC'].map(
      (s) => computeConviction(db, s).band,
    );
    const low = bands.filter((b) => b === 'LOW').length;
    // A broad fall is by definition unexceptional for most names. A handful may
    // still move oddly; that is real, and those are the ones worth surfacing.
    expect(low).toBeGreaterThanOrEqual(5);
  });

  it('produces an explanation naming the market share, not a vague warning', () => {
    const c = computeConviction(db, 'RELIANCE');
    expect(c.explanation).toMatch(/\d+% of this move is the market/);
    expect(c.explanation).toMatch(/-\d\.\d%/);
  });

  it('says the index fund is tracking rather than surprising', () => {
    // An index fund falling with its benchmark is the least surprising event in
    // finance. Reporting it as a stock-style shock would be a correctness bug,
    // and is why conviction is measured against a per-instrument reference.
    const c = computeConviction(db, 'UTI_NIFTY50');
    expect(c.band).toBe('LOW');
    expect(c.shareReference!).toBeGreaterThan(0.9);
    expect(c.explanation).toMatch(/Tracking, not diverging/);
    expect(c.explanation).toMatch(/its benchmark/);
  });
});

describe('a single-stock shock is the opposite case', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    runScenario(db, 'single-stock-shock');
  });

  it('moves the shocked stock far beyond its own normal', () => {
    const c = computeConviction(db, 'DIVISLAB');
    expect(Math.abs(c.z!)).toBeGreaterThan(2.5);
    expect(c.band).toBe('EXTREME');
  });

  it('attributes the move to the stock itself, not the market', () => {
    const c = computeConviction(db, 'DIVISLAB');
    expect(c.shareReference!).toBeLessThan(0.3);
  });

  it('leaves the untouched stocks quiet, so only one thing demands attention', () => {
    const loud = ['RELIANCE', 'TCS', 'HDFCBANK', 'ITC'].filter(
      (s) => computeConviction(db, s).band === 'EXTREME',
    );
    expect(loud).toEqual([]);
  });
});

describe('freshness is type-aware', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    // The correction scenario freezes stock quotes for its first three ticks
    // while fund NAVs keep publishing.
    runScenario(db, 'correction');
  });

  it('keeps publishing fund NAVs while stock quotes are frozen', () => {
    expect(currentPrice(db, 'PPFAS_FLEXI')).not.toBeNull();
  });

  it('never flags a fund as stale on a normal publication cadence', () => {
    // A type-blind freshness check would mark every fund stale all day. That is
    // crying wolf, and it destroys trust faster than silence.
    for (const f of ['PPFAS_FLEXI', 'HDFC_MIDCAP', 'UTI_NIFTY50']) {
      expect(computeConviction(db, f).stale, `${f} should not be stale`).toBe(false);
    }
  });

  it('records the correction as a superseding event rather than an overwrite', () => {
    // History is never silently rewritten. The bad print is still there, with a
    // later event pointing at it.
    const corrections = db
      .prepare('SELECT COUNT(*) AS n FROM price_events WHERE corrects_event_id IS NOT NULL')
      .get() as { n: number };
    expect(corrections.n).toBeGreaterThan(0);

    const original = db
      .prepare(
        `SELECT p.id FROM price_events p
         WHERE p.id IN (SELECT corrects_event_id FROM price_events WHERE corrects_event_id IS NOT NULL)`,
      )
      .all();
    expect(original.length).toBeGreaterThan(0);
  });
});
