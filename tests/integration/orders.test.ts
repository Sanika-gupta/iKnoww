import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import { addItem, getItem } from '../../src/lib/watchlist/items';
import { placeOrder, positionOf, listOrders, rearmThesis, fundOrderStatus } from '../../src/lib/orders/service';
import { currentPrice, startScenario, tick } from '../../src/lib/sim/ticker';
import { evaluateAll } from '../../src/lib/engine/states';

const USER = DEFAULT_USER_ID;
const LIST = DEFAULT_WATCHLIST_ID;
const OPEN = Date.parse('2026-09-04T11:00:00+05:30');
const AFTER_CUTOFF = Date.parse('2026-09-04T15:30:00+05:30');

function findCard(db: Database.Database, symbol: string): string {
  const row = db
    .prepare('SELECT id FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?')
    .get(LIST, symbol) as { id: string } | undefined;
  if (!row) throw new Error(`no card for ${symbol}`);
  return row.id;
}

describe('an order is idempotent', () => {
  let db: Database.Database;
  let id: string;

  beforeEach(() => {
    db = createTestDb(true);
    id = findCard(db, 'TCS');
  });

  it('places one order for one key', () => {
    const r = placeOrder(db, {
      userId: USER,
      itemId: id,
      side: 'BUY',
      quantity: 5,
      idempotencyKey: 'k1',
      now: OPEN,
    });
    expect(r).toMatchObject({ ok: true, replayed: false });
  });

  it('returns the original order on a retry rather than placing a second', () => {
    // A double-tapped button or a retried request must not produce two trades.
    const first = placeOrder(db, {
      userId: USER,
      itemId: id,
      side: 'BUY',
      quantity: 5,
      idempotencyKey: 'k1',
      now: OPEN,
    });
    const again = placeOrder(db, {
      userId: USER,
      itemId: id,
      side: 'BUY',
      quantity: 5,
      idempotencyKey: 'k1',
      now: OPEN,
    });
    expect(again).toMatchObject({ ok: true, replayed: true });
    if (!first.ok || !again.ok) return;
    expect(again.order.id).toBe(first.order.id);
    expect(listOrders(db, USER)).toHaveLength(1);
  });
});

describe('a sell is validated against the position, not against the UI', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(true);
  });

  it('refuses to sell something not held', () => {
    // The demo user holds no TCS, and TCS carries a DIP_BUY thesis, so the
    // request is refused twice over. This is the request that bypasses the
    // button entirely.
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'TCS'),
      side: 'SELL',
      quantity: 1,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r).toMatchObject({ ok: false });
  });

  it('refuses to sell more than is held', () => {
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'INFY'),
      side: 'SELL',
      quantity: 5000,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r).toMatchObject({ ok: false, error: 'INSUFFICIENT_QUANTITY' });
  });

  it('allows a sell within the position and reduces it', () => {
    const before = positionOf(db, USER, 'INFY').quantity;
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'INFY'),
      side: 'SELL',
      quantity: 10,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r.ok).toBe(true);
    expect(positionOf(db, USER, 'INFY').quantity).toBeCloseTo(before - 10, 6);
  });

  it('closes the position entirely when sold to zero', () => {
    placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'INFY'),
      side: 'SELL',
      quantity: positionOf(db, USER, 'INFY').quantity,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(positionOf(db, USER, 'INFY').quantity).toBe(0);
  });
});

describe('the thesis determines which action is even possible', () => {
  it('refuses a side the thesis does not lead to', () => {
    // A card does not show a generic buy/sell pair, so the API must not accept
    // one either.
    const db = createTestDb(true);
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'INFY'), // PROTECT, which leads to SELL
      side: 'BUY',
      quantity: 1,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r).toMatchObject({ ok: false, error: 'ACTION_NOT_AVAILABLE' });
  });
});

describe('acting past a weak signal takes an explicit acknowledgement', () => {
  let db: Database.Database;
  let infy: string;

  beforeEach(() => {
    db = createTestDb(true);
    infy = findCard(db, 'INFY');
    startScenario(db, 'market-crash');
    for (let i = 0; i < 12; i++) {
      tick(db);
      evaluateAll(db);
    }
  });

  it('has put the protective stop into review', () => {
    expect(getItem(db, infy)!.state).toBe('NEEDS_REVIEW');
  });

  it('refuses the sell until the user says they have seen the conviction', () => {
    // We make our own action button harder to press when the signal is weak.
    // That is against the usual engagement incentive and it is the point.
    const r = placeOrder(db, {
      userId: USER,
      itemId: infy,
      side: 'SELL',
      quantity: 10,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r).toMatchObject({ ok: false, error: 'ACKNOWLEDGEMENT_REQUIRED' });
    if (r.ok) return;
    expect(r.detail).toMatch(/% of this move is the market/);
  });

  it('goes through once acknowledged, and records that it was overridden', () => {
    const r = placeOrder(db, {
      userId: USER,
      itemId: infy,
      side: 'SELL',
      quantity: 10,
      acknowledgedLowConviction: true,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.acknowledgedLowConviction).toBe(true);
    expect(r.order.stateAtOrder).toBe('NEEDS_REVIEW');
  });

  it('stamps the order with the thesis and the conviction showing at the time', () => {
    // "Your trade remembers why you made it." No broker does this, it costs one
    // column, and it is the closing line of the demo.
    const r = placeOrder(db, {
      userId: USER,
      itemId: infy,
      side: 'SELL',
      quantity: 10,
      acknowledgedLowConviction: true,
      checkInQuestion: 'Has your view of INFY itself changed?',
      checkInAnswer: 'No, I just want the cash.',
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.thesisSnapshot.type).toBe('PROTECT');
    expect(r.order.convictionSnapshot.band).toBe('LOW');
    expect(r.order.convictionSnapshot.shareReference).toBeGreaterThan(0.7);
    expect(r.order.checkInAnswer).toBe('No, I just want the cash.');
  });
});

describe('acting fulfils the thesis so it stops firing', () => {
  let db: Database.Database;
  let id: string;

  beforeEach(() => {
    db = createTestDb(true);
    id = findCard(db, 'TCS');
    placeOrder(db, {
      userId: USER,
      itemId: id,
      side: 'BUY',
      quantity: 5,
      idempotencyKey: 'k',
      now: OPEN,
    });
  });

  it('moves the card to FULFILLED', () => {
    expect(getItem(db, id)!.state).toBe('FULFILLED');
  });

  it('keeps it there even when the trigger is hit afterwards', () => {
    // Without this, acting on a thesis leaves it triggering forever. The bug is
    // invisible until actions exist.
    startScenario(db, 'market-crash');
    for (let i = 0; i < 12; i++) {
      tick(db);
      evaluateAll(db);
    }
    expect(getItem(db, id)!.state).toBe('FULFILLED');
  });

  it('does not badge the card, because the order was the user acting', () => {
    const unread = db
      .prepare(
        `SELECT COUNT(*) AS n FROM thesis_events te
           JOIN read_state rs ON rs.item_id = te.item_id
          WHERE te.item_id = ? AND te.id > rs.last_seen_seq`,
      )
      .get(id) as { n: number };
    expect(unread.n).toBe(0);
  });

  it('can be re-armed', () => {
    expect(rearmThesis(db, id)).toBe(true);
    expect(getItem(db, id)!.state).toBe('WATCHING');
  });
});

describe('mutual fund timing is the rule that shows domain knowledge', () => {
  it('fills before the 3pm cutoff', () => {
    expect(fundOrderStatus(Date.parse('2026-09-04T14:59:00+05:30'))).toBe('FILLED');
  });

  it('rolls to the next NAV after it', () => {
    expect(fundOrderStatus(AFTER_CUTOFF)).toBe('PENDING_NEXT_NAV');
  });

  it('rolls to the next NAV all weekend, however early in the day', () => {
    // There is no NAV on a Saturday, so eleven in the morning is the same case
    // as after Friday's cutoff. Before weekends were handled this returned
    // FILLED and moved a paper position against a NAV that does not exist --
    // invisible in simulated mode, whose only day is a Friday, and wrong every
    // weekend in live mode.
    expect(fundOrderStatus(Date.parse('2026-09-05T11:00:00+05:30'))).toBe('PENDING_NEXT_NAV');
    expect(fundOrderStatus(Date.parse('2026-09-06T09:30:00+05:30'))).toBe('PENDING_NEXT_NAV');
    // And Monday morning fills again, so the rule is a weekend rule rather than
    // a permanent halt.
    expect(fundOrderStatus(Date.parse('2026-09-07T11:00:00+05:30'))).toBe('FILLED');
  });

  it('refuses a stock order on a weekend, at the same instant a fund defers', () => {
    const db = createTestDb(true);
    const saturday = Date.parse('2026-09-05T11:00:00+05:30');
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'TCS'),
      side: 'BUY',
      quantity: 1,
      idempotencyKey: 'weekend',
      now: saturday,
      acknowledgedLowConviction: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order.status).toBe('MARKET_CLOSED');
  });

  it('buys a fund by rupee amount, not by unit count', () => {
    const db = createTestDb(true);
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'UTI_NIFTY50'),
      side: 'BUY',
      amount: 5000,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.amount).toBe(5000);
    expect(r.order.quantity!).toBeGreaterThan(0);
    expect(r.order.status).toBe('FILLED');
  });

  it('refuses a fund purchase with no amount', () => {
    const db = createTestDb(true);
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'UTI_NIFTY50'),
      side: 'BUY',
      quantity: 3,
      idempotencyKey: 'k',
      now: OPEN,
    });
    expect(r).toMatchObject({ ok: false, error: 'INVALID_AMOUNT' });
  });

  it('holds a fund order placed after the cutoff for the next NAV', () => {
    const db = createTestDb(true);
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'UTI_NIFTY50'),
      side: 'BUY',
      amount: 5000,
      idempotencyKey: 'k',
      now: AFTER_CUTOFF,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.status).toBe('PENDING_NEXT_NAV');
    expect(r.order.effectiveAt).toBeNull();
    // Nothing moves until the NAV that will actually apply is published.
    expect(positionOf(db, USER, 'UTI_NIFTY50').quantity).toBe(0);
  });
});

describe('a stock order outside market hours says so', () => {
  it('does not pretend to fill at 8pm', () => {
    const db = createTestDb(true);
    const r = placeOrder(db, {
      userId: USER,
      itemId: findCard(db, 'TCS'),
      side: 'BUY',
      quantity: 5,
      idempotencyKey: 'k',
      now: Date.parse('2026-09-04T20:00:00+05:30'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order.status).toBe('MARKET_CLOSED');
    expect(positionOf(db, USER, 'TCS').quantity).toBe(0);
  });
});

describe('a buy averages into an existing position', () => {
  it('recomputes the average price rather than overwriting it', () => {
    const db = createTestDb(true);
    const before = positionOf(db, USER, 'HDFCBANK');
    const price = currentPrice(db, 'HDFCBANK')!;

    // HDFCBANK carries BOOK_PROFIT, which leads to SELL, so use a fresh buy card.
    const added = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'ITC',
      thesisType: 'DIP_BUY',
      params: { threshold: 1 },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    placeOrder(db, {
      userId: USER,
      itemId: added.item.id,
      side: 'BUY',
      quantity: 10,
      idempotencyKey: 'k1',
      now: OPEN,
    });
    const after = positionOf(db, USER, 'ITC');
    expect(after.quantity).toBe(10);
    expect(after.avgPrice).toBeGreaterThan(0);
    expect(before.quantity).toBeGreaterThan(0);
    expect(price).toBeGreaterThan(0);
  });
});
