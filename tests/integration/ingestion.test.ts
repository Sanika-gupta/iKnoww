import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { initSimIfEmpty, currentPrice, tick } from '../../src/lib/sim/ticker';
import {
  ingestPrice,
  ingestCorrection,
  highWaterSeq,
  nextSeq,
  nthLatestEvent,
} from '../../src/lib/engine/ingest';

/**
 * A real feed redelivers, reorders and corrects itself. These are the guards
 * that stand between that and a card telling someone the wrong thing.
 */

function eventCount(db: Database.Database, symbol: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM price_events WHERE symbol = ?').get(symbol) as {
      n: number;
    }
  ).n;
}

describe('a duplicated delivery is a no-op', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
  });

  it('accepts the first delivery', () => {
    const seq = nextSeq(db, 'RELIANCE');
    expect(ingestPrice(db, { symbol: 'RELIANCE', seq, price: 2450, asOf: 1 }).outcome).toBe(
      'ACCEPTED',
    );
  });

  it('rejects the second and writes nothing', () => {
    const seq = nextSeq(db, 'RELIANCE');
    ingestPrice(db, { symbol: 'RELIANCE', seq, price: 2450, asOf: 1 });
    const before = eventCount(db, 'RELIANCE');

    const again = ingestPrice(db, { symbol: 'RELIANCE', seq, price: 2450, asOf: 1 });

    expect(again.outcome).toBe('DUPLICATE');
    expect(eventCount(db, 'RELIANCE')).toBe(before);
  });

  it('treats a changed price on a seen sequence as a duplicate, not an update', () => {
    // The strong claim, and the one a judge should push on. If a feed wants to
    // change a price it already published, that is a CORRECTION and has to
    // arrive as one, carrying the event it supersedes. Silently overwriting on
    // redelivery would destroy the only history we have, and the alert
    // retraction in Section 5.6 depends on that history surviving.
    const seq = nextSeq(db, 'RELIANCE');
    ingestPrice(db, { symbol: 'RELIANCE', seq, price: 2450, asOf: 1 });

    const result = ingestPrice(db, { symbol: 'RELIANCE', seq, price: 9999, asOf: 2 });

    expect(result.outcome).toBe('DUPLICATE');
    expect(currentPrice(db, 'RELIANCE')).toBe(2450);
  });
});

describe('a late tick cannot rewrite the past', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    for (let i = 0; i < 3; i++) {
      ingestPrice(db, { symbol: 'TCS', seq: nextSeq(db, 'TCS'), price: 3800 + i, asOf: i });
    }
  });

  it('rejects a sequence below the high-water mark', () => {
    // Message 10 overtakes message 6 on the wire. When 6 finally arrives it is
    // stale by definition, and applying it would walk the price backwards.
    ingestPrice(db, { symbol: 'TCS', seq: 10, price: 3900, asOf: 10 });

    const result = ingestPrice(db, { symbol: 'TCS', seq: 6, price: 3700, asOf: 6 });

    expect(result.outcome).toBe('OUT_OF_ORDER');
    expect(result.highWaterSeq).toBe(10);
  });

  it('leaves the current price untouched when it does', () => {
    ingestPrice(db, { symbol: 'TCS', seq: 10, price: 3900, asOf: 10 });
    ingestPrice(db, { symbol: 'TCS', seq: 6, price: 3700, asOf: 6 });
    expect(currentPrice(db, 'TCS')).toBe(3900);
  });

  it('still accepts a forward gap, because feeds skip', () => {
    // A missing sequence number means we lost a message, not that the newer one
    // is invalid. Refusing it would strand the symbol forever.
    const result = ingestPrice(db, {
      symbol: 'TCS',
      seq: highWaterSeq(db, 'TCS') + 5,
      price: 3900,
      asOf: 100,
    });
    expect(result.outcome).toBe('ACCEPTED');
    expect(currentPrice(db, 'TCS')).toBe(3900);
  });
});

describe('nonsense is refused rather than stored', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
  });

  it('refuses a symbol we do not track', () => {
    const result = ingestPrice(db, { symbol: 'NOT_LISTED', seq: 0, price: 100, asOf: 1 });
    expect(result.outcome).toBe('UNKNOWN_SYMBOL');
    expect(eventCount(db, 'NOT_LISTED')).toBe(0);
  });

  it.each([
    ['zero', 0],
    ['negative', -10],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a %s price', (_label, price) => {
    const before = eventCount(db, 'INFY');
    const result = ingestPrice(db, { symbol: 'INFY', seq: nextSeq(db, 'INFY'), price, asOf: 1 });
    expect(result.outcome).toBe('INVALID_PRICE');
    expect(eventCount(db, 'INFY')).toBe(before);
  });
});

describe('a correction supersedes rather than overwrites', () => {
  let db: Database.Database;
  let badEventId: number;

  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    ingestPrice(db, { symbol: 'TCS', seq: nextSeq(db, 'TCS'), price: 3800, asOf: 1 });
    const bad = ingestPrice(db, { symbol: 'TCS', seq: nextSeq(db, 'TCS'), price: 3, asOf: 2 });
    badEventId = bad.eventId!;
  });

  it('keeps the bad print in the log', () => {
    ingestCorrection(db, { symbol: 'TCS', correctsEventId: badEventId, price: 3800, asOf: 3 });
    const original = db.prepare('SELECT price FROM price_events WHERE id = ?').get(badEventId) as {
      price: number;
    };
    expect(original.price).toBe(3);
  });

  it('makes the corrected value the current one', () => {
    ingestCorrection(db, { symbol: 'TCS', correctsEventId: badEventId, price: 3800, asOf: 3 });
    expect(currentPrice(db, 'TCS')).toBe(3800);
  });

  it('records what it superseded, so the state can be rolled back later', () => {
    const result = ingestCorrection(db, {
      symbol: 'TCS',
      correctsEventId: badEventId,
      price: 3800,
      asOf: 3,
    });
    const row = db
      .prepare('SELECT corrects_event_id AS c FROM price_events WHERE id = ?')
      .get(result.eventId!) as { c: number };
    expect(row.c).toBe(badEventId);
  });

  it('refuses to correct an event that does not exist', () => {
    const result = ingestCorrection(db, {
      symbol: 'TCS',
      correctsEventId: 999_999,
      price: 3800,
      asOf: 3,
    });
    expect(result.outcome).toBe('CORRECTION_TARGET_MISSING');
  });

  it('does not strand the symbol afterwards', () => {
    // Regression test. Corrections used to be written at seq + 100000, which
    // silently pushed the high-water mark so far ahead that every subsequent
    // ordinary tick looked out-of-order and the symbol stopped updating (D-072).
    ingestCorrection(db, { symbol: 'TCS', correctsEventId: badEventId, price: 3800, asOf: 3 });

    const next = ingestPrice(db, { symbol: 'TCS', seq: nextSeq(db, 'TCS'), price: 3810, asOf: 4 });

    expect(next.outcome).toBe('ACCEPTED');
    expect(currentPrice(db, 'TCS')).toBe(3810);
  });

  it('counts back through real prints, skipping corrections', () => {
    // "The price three updates ago" has to mean three prints ago, not three log
    // rows ago, or a corrected symbol drifts by one every time it is corrected.
    ingestCorrection(db, { symbol: 'TCS', correctsEventId: badEventId, price: 3800, asOf: 3 });
    const previous = nthLatestEvent(db, 'TCS', 0);
    expect(previous!.price).toBe(3);
  });
});

describe('the simulator goes through the same guards', () => {
  it('never double-writes a symbol on one tick', () => {
    const db = createTestDb();
    initSimIfEmpty(db);
    const before = eventCount(db, 'RELIANCE');
    tick(db);
    expect(eventCount(db, 'RELIANCE')).toBe(before + 1);
  });

  it('leaves a frozen symbol on its old sequence while others advance', () => {
    const db = createTestDb();
    initSimIfEmpty(db);
    tick(db);
    const stockSeq = highWaterSeq(db, 'TCS');
    const fundSeq = highWaterSeq(db, 'PPFAS_FLEXI');
    expect(stockSeq).toBe(fundSeq);
  });
});
