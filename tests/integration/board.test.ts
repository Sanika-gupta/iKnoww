import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import {
  buildBoard,
  buildInstruments,
  triggerDistanceOf,
  asOfLineFor,
  unrealisedOf,
} from '../../src/lib/api/board';
import { DEFAULT_USER_ID } from '../../src/lib/db/seed';
import { startScenario, tick, currentPrice } from '../../src/lib/sim/ticker';
import { resetSession } from '../../src/lib/sim/session';
import { evaluateAll, acknowledge } from '../../src/lib/engine/states';

/**
 * The screen a judge actually opens, tested through the same function that
 * renders it.
 */

function runCrash(db: Database.Database): void {
  startScenario(db, 'market-crash');
  for (let i = 0; i < 12; i++) {
    tick(db);
    evaluateAll(db);
  }
}

describe('a stranger opening the app sees something', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb(true);
  });

  it('arrives at a watchlist that is not empty', () => {
    // Judges run the app themselves with no video to explain it, so an empty
    // first screen would put a data-entry task between them and the idea.
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(board.cards.length).toBeGreaterThanOrEqual(5);
  });

  it('covers both instrument types and both sides of the action', () => {
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(board.cards.some((c) => c.instrumentType === 'FUND')).toBe(true);
    expect(board.cards.some((c) => c.action === 'BUY')).toBe(true);
    expect(board.cards.some((c) => c.action === 'SELL')).toBe(true);
    expect(board.cards.some((c) => c.thesisType === 'JUST_WATCHING')).toBe(true);
  });

  it('offers every scenario as a labelled control', () => {
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(board.scenarios.map((s) => s.id)).toContain('market-crash');
    for (const s of board.scenarios) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
    }
  });

  it('starts calm, and says so rather than showing nothing', () => {
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(board.attentionCount).toBe(0);
    for (const c of board.cards) {
      expect(c.state).toBe('WATCHING');
      // A calm card must describe the present, not repeat the reason it was
      // created. "Added to the watchlist" forever is the past, not the now.
      expect(c.line).not.toContain('Added to the watchlist');
    }
  });

  it('never offers a thesis the server would refuse', () => {
    const instruments = buildInstruments(db, DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID);
    const unheld = instruments.find((i) => i.symbol === 'ITC')!;
    expect(unheld.templates.map((t) => t.type)).not.toContain('PROTECT');
    const held = instruments.find((i) => i.symbol === 'INFY')!;
    expect(held.templates.map((t) => t.type)).toContain('PROTECT');
  });

  it('gives the picker a price to anchor the threshold against', () => {
    /*
     * The form asks for a number -- "buy if it falls below" -- and until this
     * it asked for it against a blank screen. You cannot judge ₹3,800 for a
     * stock whose price you cannot see, and nothing on the board shows it,
     * because an instrument you have not added yet has no card (D-126).
     *
     * Every seeded instrument has price events, so this is a row read rather
     * than anything new being computed or fetched.
     */
    for (const i of buildInstruments(db, DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID)) {
      expect(i.price).not.toBeNull();
      expect(i.price!).toBeGreaterThan(0);
    }
  });

  it('says how far a thesis is from firing, and stops once it has', () => {
    /*
     * The card showed a price and a sentence containing a threshold, and left
     * the subtraction to the reader. This is the number that answers "is this
     * thesis live or dormant", which is the question the product is about.
     *
     * It goes null once the condition is met, deliberately: the state badge and
     * its sentence already say so, and "0.4% past your trigger" would be a
     * second, weaker way of saying the same thing (D-130).
     */
    expect(triggerDistanceOf('DIP_BUY', 3800, 4000, 'WATCHING')).toBeCloseTo(0.05, 6);
    expect(triggerDistanceOf('BREAKOUT_BUY', 4200, 4000, 'WATCHING')).toBeCloseTo(0.05, 6);
    // No trigger to be far from.
    expect(triggerDistanceOf('JUST_WATCHING', undefined, 4000, 'WATCHING')).toBeNull();
  });

  it('goes quiet on a card that has fired, even inside the hysteresis band', () => {
    /*
     * Found by reading the real board after a crash: INFY sat in NEEDS_REVIEW
     * and the line under it read "0.1% from your ₹1,519 trigger" -- a card
     * saying it had fired and had not fired in consecutive lines.
     *
     * The cause is that a price comparison is not the condition. The condition
     * is a Schmitt trigger, armed at the threshold and disarmed only a quarter
     * of a percent back past it (D-087), so inside that band the two disagree.
     * Keying on the state means the screen cannot contradict the engine, which
     * is the rule D-107 settled for the session badge.
     */
    expect(triggerDistanceOf('PROTECT', 1519, 1520.5, 'NEEDS_REVIEW')).toBeNull();
    expect(triggerDistanceOf('DIP_BUY', 3800, 4000, 'ACTIONABLE')).toBeNull();
    expect(triggerDistanceOf('DIP_BUY', 3800, 4000, 'FULFILLED')).toBeNull();
    // And the same price on a card that has not fired still reports the gap.
    expect(triggerDistanceOf('PROTECT', 1519, 1520.5, 'WATCHING')).toBeCloseTo(0.000986, 5);
  });

  it('says when every price was measured, not only the broken ones', () => {
    /*
     * Freshness is type-aware (D-025), but it only ever SPOKE when something
     * was wrong -- so the reassurance that a fourteen-hour NAV is entirely
     * normal, which is the whole point of that rule, was invisible.
     */
    const at = Date.parse('2026-09-04T09:40:00+05:30');
    expect(asOfLineFor('STOCK', at, at)).toBe('Price as of 9:40 AM');
    // The delay is measured from the feed's own stamp, never assumed.
    expect(asOfLineFor('STOCK', at, at + 15 * 60_000)).toBe(
      'Price as of 9:40 AM · 15 min behind the exchange',
    );
    /*
     * Yesterday evening's NAV, read this morning: 15 hours old and entirely
     * normal, which is the case the 30-hour fund window exists for and the one
     * a type-blind staleness rule would cry wolf about.
     */
    const nav = Date.parse('2026-09-03T18:00:00+05:30');
    expect(asOfLineFor('FUND', nav, at)).toBe('NAV as of 6:00 PM Thu 3 Sep · normal for a fund');
    // A NAV published this morning needs no reassurance, and saying it anyway
    // would be explaining something that is not happening.
    expect(asOfLineFor('FUND', at, at)).toBe('NAV as of 9:40 AM');
  });

  it('does not tell you the exchange is running late when it is shut', () => {
    /*
     * Read off a real live card on a Saturday: "Price as of 3:15 PM · 1604 min
     * behind the exchange". Arithmetically true and nonsense as English -- the
     * exchange is not twenty-six hours late, it closed on Friday afternoon.
     *
     * The delay is the number that matters WHILE trading, because it is what
     * the 20-minute live staleness gate is judging. Outside trading it is
     * meaningless, so the card says when the last trade was instead.
     */
    const friday = Date.parse('2026-09-04T15:15:00+05:30');
    const saturday = Date.parse('2026-09-05T17:30:00+05:30');
    expect(asOfLineFor('STOCK', friday, saturday, false)).toBe(
      'Last trade 3:15 PM Fri 4 Sep · the market is closed',
    );
    // Same day, after the bell.
    const fridayEvening = Date.parse('2026-09-04T18:00:00+05:30');
    expect(asOfLineFor('STOCK', friday, fridayEvening, false)).toBe(
      'Last trade 3:15 PM · the market has closed since',
    );
    // And while it IS trading, the delay is exactly what should be shown.
    expect(asOfLineFor('STOCK', friday, friday + 15 * 60_000, true)).toBe(
      'Price as of 3:15 PM · 15 min behind the exchange',
    );
  });

  it('gives a holding a cost basis, because a quantity alone decides nothing', () => {
    /*
     * "holding 40" is inert on the one card where it matters most: a protective
     * stop firing in a crash, which is the moment this product exists for.
     */
    expect(unrealisedOf(40, 100, 110)).toEqual({ amount: 400, pct: 0.1 });
    expect(unrealisedOf(40, 100, 90)!.amount).toBeCloseTo(-400, 6);
    // No holding, nothing to say.
    expect(unrealisedOf(0, 100, 110)).toBeNull();
  });

  it('carries all three onto the card itself', () => {
    const cards = buildBoard(db, DEFAULT_WATCHLIST_ID).cards;
    for (const c of cards) {
      expect(c.asOfLine).not.toBe('');
      // Every seeded card has a price, so none should be reporting none.
      expect(c.asOfLine).not.toBe('No price yet');
      if (c.positionQuantity > 0) expect(c.unrealised).not.toBeNull();
      else expect(c.unrealised).toBeNull();
    }
    // At least one seeded thesis is waiting on a trigger it has not reached.
    expect(cards.some((c) => c.triggerDistance !== null)).toBe(true);
  });

  it('leaves the anchor null rather than guessing when there is no price', () => {
    db.prepare("DELETE FROM price_events WHERE symbol = 'ITC'").run();
    const itc = buildInstruments(db, DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID).find(
      (i) => i.symbol === 'ITC',
    )!;
    expect(itc.price).toBeNull();
  });
});

describe('the crash, as the screen renders it', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb(true);
    runCrash(db);
  });

  it('puts the market move at the top and counts what moved with it', () => {
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(board.market.changePct!).toBeLessThan(-0.02);
    expect(board.market.headline).toContain('Broad decline');
    expect(board.market.movingWithReference).toBeGreaterThanOrEqual(4);
  });

  it('agrees with itself: every card quotes the same market move as the header', () => {
    // Found by running it: cards froze the reason at the moment they fired, so
    // a card said "the market (-2.5%)" under a header reading -3.2%. Both were
    // true when written, which is no defence when they sit two inches apart.
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    const header = `${(board.market.changePct! * 100).toFixed(1)}%`;
    const quoting = board.cards.filter((c) => c.line.includes('%) ') || c.line.includes('moving -'));
    expect(quoting.length).toBeGreaterThan(0);
    for (const c of quoting) {
      if (c.referenceSymbol === 'NIFTY50') expect(c.line).toContain(header);
    }
  });

  it('sends triggers to review rather than to action', () => {
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    const review = board.cards.filter((c) => c.state === 'NEEDS_REVIEW');
    expect(review.length).toBeGreaterThanOrEqual(2);
    expect(board.cards.filter((c) => c.state === 'ACTIONABLE')).toEqual([]);
  });
});

describe('acting past a weak signal does not launder it', () => {
  it('keeps saying the move was the market after the user overrides', () => {
    // The card becomes actionable because the user chose it, not because
    // conviction improved. Claiming otherwise would quietly turn a weak signal
    // into a strong one on the strength of a button press.
    const db = createTestDb(true);
    runCrash(db);
    const before = buildBoard(db, DEFAULT_WATCHLIST_ID).cards.find(
      (c) => c.state === 'NEEDS_REVIEW',
    )!;
    acknowledge(db, before.id);

    const after = buildBoard(db, DEFAULT_WATCHLIST_ID).cards.find((c) => c.id === before.id)!;
    expect(after.state).toBe('ACTIONABLE');
    expect(after.line).toContain('You chose to act on this anyway');
    expect(after.line).toMatch(/% of this move is the market/);
    expect(after.line).not.toContain('really is about');
  });
});

describe('resetting rewinds the day rather than adopting it', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb(true);
    runCrash(db);
    resetSession(db);
  });

  it('returns every card to a calm state', () => {
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(board.attentionCount).toBe(0);
    expect(board.market.headline).toContain('Quiet day');
  });

  it('puts prices back at the open rather than leaving them crashed', () => {
    // The first version adopted whatever the prices happened to be. It looked
    // right until the demo ran twice: every trigger had already been crossed,
    // so nothing could cross it again and the second run sat silent.
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    for (const c of board.cards) expect(Math.abs(c.changePct!)).toBeLessThan(0.0001);
  });

  it('does not delete the history it rewound past', () => {
    const events = db.prepare('SELECT COUNT(*) AS n FROM price_events').get() as { n: number };
    expect(events.n).toBeGreaterThan(50);
  });

  it('leaves no unread badge, because the reset was the user asking', () => {
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    for (const c of board.cards) expect(c.unread).toBe(0);
  });

  it('replays the same scenario identically, so a rehearsed demo is reproducible', () => {
    const first = buildBoardPrices(db);
    runCrash(db);
    const crashed = buildBoardPrices(db);
    resetSession(db);
    runCrash(db);
    const again = buildBoardPrices(db);

    expect(crashed).not.toEqual(first);
    expect(again).toEqual(crashed);
  });
});

function buildBoardPrices(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of buildBoard(db, DEFAULT_WATCHLIST_ID).cards) {
    out[c.symbol] = Number(currentPrice(db, c.symbol)!.toFixed(4));
  }
  return out;
}
