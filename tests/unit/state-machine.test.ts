import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import { addItem, editThesis, getItem } from '../../src/lib/watchlist/items';
import {
  targetState,
  conditionMet,
  evaluateSymbol,
  evaluateAll,
  acknowledge,
} from '../../src/lib/engine/states';
import { initSimIfEmpty, currentPrice, tick, startScenario } from '../../src/lib/sim/ticker';
import { ingestPrice, nextSeq } from '../../src/lib/engine/ingest';
import type { ItemState, ThesisType } from '../../src/lib/domain/types';

const USER = DEFAULT_USER_ID;
const LIST = DEFAULT_WATCHLIST_ID;

describe('the condition is only ever price-below or price-above', () => {
  it.each([
    ['DIP_BUY', 3800, 3799, true],
    ['DIP_BUY', 3800, 3801, false],
    ['DIP_BUY', 3800, 3800, true],
    ['PROTECT', 1500, 1499, true],
    ['BREAKOUT_BUY', 4000, 4001, true],
    ['BREAKOUT_BUY', 4000, 3999, false],
    ['BOOK_PROFIT', 4000, 4001, true],
  ] as const)('%s at %d with price %d', (thesisType, threshold, price, expected) => {
    expect(conditionMet(thesisType as ThesisType, { threshold }, price)).toBe(expected);
  });

  it('is never met for a thesis with no threshold', () => {
    expect(conditionMet('JUST_WATCHING', {}, 1)).toBe(false);
  });
});

describe('a met condition does not mean act', () => {
  it('routes a high-conviction trigger to ACTIONABLE', () => {
    expect(targetState('WATCHING', true, 'HIGH', 1.6)).toEqual({
      state: 'ACTIONABLE',
      review: null,
    });
  });

  it('routes a diluted trigger to review, because the move was the reference', () => {
    expect(targetState('WATCHING', true, 'LOW', 0.2)).toEqual({
      state: 'NEEDS_REVIEW',
      review: 'DILUTED',
    });
  });

  it('routes a confounded trigger to review, because a shock is not a drift', () => {
    expect(targetState('WATCHING', true, 'EXTREME', 3.4)).toEqual({
      state: 'NEEDS_REVIEW',
      review: 'CONFOUNDED',
    });
  });

  it('refuses to say act when it cannot verify the move at all', () => {
    // The condition is genuinely met, but with no usable history we cannot say
    // whether this is about the instrument. Saying ACTIONABLE would be
    // fabricating the one thing this product exists to check.
    expect(targetState('WATCHING', true, 'UNKNOWN', null)).toEqual({
      state: 'NEEDS_REVIEW',
      review: 'UNVERIFIABLE',
    });
  });
});

describe('a surprise nobody asked about still surfaces', () => {
  it('fires UNEXPLAINED with no condition met', () => {
    expect(targetState('WATCHING', false, 'EXTREME', 4.1).state).toBe('UNEXPLAINED');
  });

  it('stays UNEXPLAINED until it is acknowledged', () => {
    // A surprise that quietly disappears before anyone looked at it has been
    // swallowed, and nothing here is allowed to be silently swallowed.
    expect(targetState('UNEXPLAINED', false, 'LOW', 0.1).state).toBe('UNEXPLAINED');
  });

  it('gives way once a real trigger is hit', () => {
    expect(targetState('UNEXPLAINED', true, 'HIGH', 1.5).state).toBe('ACTIONABLE');
  });
});

describe('the lapsed and fulfilled cases', () => {
  it('returns an actionable card to WATCHING when the trigger stops being met', () => {
    expect(targetState('ACTIONABLE', false, 'LOW', 0.3).state).toBe('WATCHING');
  });

  it('returns a review card to WATCHING too', () => {
    expect(targetState('NEEDS_REVIEW', false, 'LOW', 0.3).state).toBe('WATCHING');
  });

  it('lets a review card recover to ACTIONABLE when conviction improves', () => {
    expect(targetState('NEEDS_REVIEW', true, 'HIGH', 1.4).state).toBe('ACTIONABLE');
  });

  it('never re-fires a thesis the user already acted on', () => {
    // Without this, acting on a thesis leaves it triggering forever. The bug is
    // invisible until actions exist.
    for (const met of [true, false]) {
      expect(targetState('FULFILLED', met, 'HIGH', 3).state).toBe('FULFILLED');
    }
  });
});

// --------------------------------------------------------------- end to end

function seedCard(
  db: Database.Database,
  symbol: string,
  thesisType: ThesisType,
  threshold?: number,
): string {
  const r = addItem(db, {
    userId: USER,
    watchlistId: LIST,
    symbol,
    thesisType,
    params: threshold === undefined ? {} : { threshold },
  });
  if (!r.ok) throw new Error(`add failed: ${r.error}`);
  return r.item.id;
}

function stateOf(db: Database.Database, itemId: string): ItemState {
  return getItem(db, itemId)!.state;
}

function push(db: Database.Database, symbol: string, price: number, asOf: number): void {
  ingestPrice(db, { symbol, seq: nextSeq(db, symbol), price, asOf });
}

describe('the crash: triggers fire and every one is sent to review', () => {
  let db: Database.Database;
  const cards: Record<string, string> = {};

  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    db.prepare(
      'INSERT INTO positions (user_id, symbol, quantity, avg_price) VALUES (?,?,?,?)',
    ).run(USER, 'INFY', 50, 1480);

    cards.tcs = seedCard(db, 'TCS', 'DIP_BUY', Math.round(currentPrice(db, 'TCS')! * 0.98));
    cards.infy = seedCard(db, 'INFY', 'PROTECT', Math.round(currentPrice(db, 'INFY')! * 0.98));
    cards.divis = seedCard(db, 'DIVISLAB', 'JUST_WATCHING');

    // Evaluate after every tick, exactly as the live loop does, so a card can
    // transition mid-slide rather than only at the end.
    startScenario(db, 'market-crash');
    for (let i = 0; i < 12; i++) {
      tick(db);
      evaluateAll(db);
    }
  });

  it('sends the dip trigger to review rather than to action', () => {
    expect(stateOf(db, cards.tcs)).toBe('NEEDS_REVIEW');
  });

  it('says out loud that this is not your dip', () => {
    const e = db
      .prepare('SELECT reason FROM thesis_events WHERE item_id = ? ORDER BY id DESC LIMIT 1')
      .get(cards.tcs) as { reason: string };
    expect(e.reason).toContain('This is not your dip.');
    expect(e.reason).toMatch(/% of this move is the market/);
  });

  it('sends the protective stop to review with the sentence that matters most', () => {
    // Panic-selling into a market-wide fall is the most destructive thing a
    // retail investor does, and a stop firing on a market move is exactly how
    // good positions get shaken out at the bottom.
    expect(stateOf(db, cards.infy)).toBe('NEEDS_REVIEW');
    const e = db
      .prepare('SELECT reason, conviction FROM thesis_events WHERE item_id = ? ORDER BY id DESC LIMIT 1')
      .get(cards.infy) as { reason: string; conviction: string };
    expect(e.reason).toContain('You would be selling the market, not exiting your thesis.');
    expect(JSON.parse(e.conviction).review).toBe('DILUTED');
  });

  it('describes a fund in fund language, never in stock language', () => {
    // A fund has a benchmark and a category, not a market and a stock. "This is
    // not your dip" on a mutual fund is stock copy wearing a fund's name, which
    // is what the card actually said until it was read out loud (D-079).
    const fundCard = seedCard(
      db,
      'UTI_NIFTY50',
      'DIP_BUY',
      Math.round(currentPrice(db, 'UTI_NIFTY50')! * 1.02),
    );
    evaluateAll(db);
    const e = db
      .prepare('SELECT reason FROM thesis_events WHERE item_id = ? ORDER BY id DESC LIMIT 1')
      .get(fundCard) as { reason: string };
    expect(e.reason).toContain('category-wide fall, not a fund problem');
    expect(e.reason).not.toContain('your dip');
    expect(e.reason).not.toContain('the stock itself');
  });

  it('leaves the card with no thesis alone, because nothing odd happened to it', () => {
    expect(stateOf(db, cards.divis)).toBe('WATCHING');
  });

  it('never lets a card sit in a state it cannot explain', () => {
    const blank = db
      .prepare("SELECT COUNT(*) AS n FROM thesis_events WHERE reason IS NULL OR TRIM(reason) = ''")
      .get() as { n: number };
    expect(blank.n).toBe(0);
  });

  it('records the price event that caused each transition', () => {
    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM thesis_events
          WHERE from_state != 'NEW' AND price_event_id IS NULL`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });
});

describe('a single-stock shock is the one that earns attention', () => {
  let db: Database.Database;
  let divis: string;
  let itc: string;

  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    divis = seedCard(db, 'DIVISLAB', 'JUST_WATCHING');
    itc = seedCard(db, 'ITC', 'JUST_WATCHING');

    const start = currentPrice(db, 'DIVISLAB')!;
    push(db, 'DIVISLAB', start * 1.065, Date.now());
    evaluateAll(db, Date.now());
  });

  it('flags the shocked card as UNEXPLAINED even though it declared no thesis', () => {
    // The surprise detector has to work for people who never configured
    // anything, or value is gated behind onboarding.
    expect(stateOf(db, divis)).toBe('UNEXPLAINED');
  });

  it('says nothing in the thesis covers it', () => {
    const e = db
      .prepare('SELECT reason FROM thesis_events WHERE item_id = ? ORDER BY id DESC LIMIT 1')
      .get(divis) as { reason: string };
    expect(e.reason).toContain('Nothing in your thesis covers this.');
  });

  it('leaves every other card silent', () => {
    expect(stateOf(db, itc)).toBe('WATCHING');
  });
});

describe('the freshness gate is type-aware', () => {
  let db: Database.Database;
  let tcs: string;
  let fund: string;

  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    tcs = seedCard(db, 'TCS', 'DIP_BUY', Math.round(currentPrice(db, 'TCS')! * 0.99));
    fund = seedCard(db, 'PPFAS_FLEXI', 'DIP_BUY', Math.round(currentPrice(db, 'PPFAS_FLEXI')! * 0.99));
  });

  it('refuses to move a card on a quote that is too old', () => {
    const now = Date.now();
    push(db, 'TCS', currentPrice(db, 'TCS')! * 0.95, now);
    // Ask an hour later. The quote is an hour stale, well past the 10-minute
    // limit for a stock, so the trigger must not move the card.
    const transitions = evaluateSymbol(db, 'TCS', now + 60 * 60 * 1000);
    expect(transitions).toEqual([]);
    expect(stateOf(db, tcs)).toBe('WATCHING');
  });

  it('moves the same card once the price is fresh', () => {
    const now = Date.now();
    push(db, 'TCS', currentPrice(db, 'TCS')! * 0.95, now);
    evaluateSymbol(db, 'TCS', now);
    expect(stateOf(db, tcs)).not.toBe('WATCHING');
  });

  it('treats a fourteen-hour-old NAV as perfectly normal', () => {
    // A type-blind gate would freeze every fund card all day. Crying wolf
    // destroys trust faster than silence does.
    const now = Date.now();
    push(db, 'PPFAS_FLEXI', currentPrice(db, 'PPFAS_FLEXI')! * 0.95, now);
    const transitions = evaluateSymbol(db, 'PPFAS_FLEXI', now + 14 * 60 * 60 * 1000);
    expect(transitions.length).toBeGreaterThan(0);
    expect(stateOf(db, fund)).not.toBe('WATCHING');
  });
});

describe('transitions are events, and only real changes are', () => {
  let db: Database.Database;
  let tcs: string;

  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    tcs = seedCard(db, 'TCS', 'DIP_BUY', Math.round(currentPrice(db, 'TCS')! * 0.99));
  });

  it('does not append an event when nothing changed', () => {
    // Re-appending the same state every tick would turn the log into noise and
    // the unread badge into a lie.
    const now = Date.now();
    push(db, 'TCS', currentPrice(db, 'TCS')! * 0.95, now);
    const first = evaluateSymbol(db, 'TCS', now);
    expect(first.length).toBe(1);

    push(db, 'TCS', currentPrice(db, 'TCS')! * 0.999, now + 1000);
    const second = evaluateSymbol(db, 'TCS', now + 1000);
    expect(second).toEqual([]);
  });

  it('returns the card to WATCHING when the price recovers past the trigger', () => {
    const now = Date.now();
    const open = currentPrice(db, 'TCS')!;
    push(db, 'TCS', open * 0.95, now);
    evaluateSymbol(db, 'TCS', now);

    push(db, 'TCS', open * 1.01, now + 1000);
    const back = evaluateSymbol(db, 'TCS', now + 1000);

    expect(back).toHaveLength(1);
    expect(back[0].to).toBe('WATCHING');
    expect(back[0].reason).toContain('back above');
    expect(stateOf(db, tcs)).toBe('WATCHING');
  });
});

describe('a thesis that is already true when you write it', () => {
  it('does not sit in WATCHING waiting for a crossing that will never come', () => {
    // The range query only finds thresholds the price has just crossed. A
    // thesis added between price moves may already be met, and "buy below 4000"
    // set while the stock sits at 3700 would otherwise wait forever for the
    // price to cross 4000 from above (D-078).
    const db = createTestDb();
    initSimIfEmpty(db);
    const price = currentPrice(db, 'TCS')!;
    const id = seedCard(db, 'TCS', 'DIP_BUY', Math.round(price * 1.05));
    expect(stateOf(db, id)).not.toBe('WATCHING');
  });

  it('does not badge the card, because the user is looking straight at it', () => {
    const db = createTestDb();
    initSimIfEmpty(db);
    const price = currentPrice(db, 'TCS')!;
    const id = seedCard(db, 'TCS', 'DIP_BUY', Math.round(price * 1.05));
    const unread = db
      .prepare(
        `SELECT COUNT(*) AS n FROM thesis_events te
           JOIN read_state rs ON rs.item_id = te.item_id
          WHERE te.item_id = ? AND te.id > rs.last_seen_seq`,
      )
      .get(id) as { n: number };
    expect(unread.n).toBe(0);
  });

  it('applies the same rule when a thesis is edited into range', () => {
    const db = createTestDb();
    initSimIfEmpty(db);
    const price = currentPrice(db, 'TCS')!;
    const id = seedCard(db, 'TCS', 'DIP_BUY', Math.round(price * 0.5));
    expect(stateOf(db, id)).toBe('WATCHING');

    const edited = editThesis(db, {
      itemId: id,
      thesisType: 'DIP_BUY',
      params: { threshold: Math.round(price * 1.05) },
    });
    expect(edited.ok).toBe(true);
    expect(stateOf(db, id)).not.toBe('WATCHING');
  });
});

describe('acknowledging is the user speaking', () => {
  let db: Database.Database;
  let tcs: string;

  beforeEach(() => {
    db = createTestDb();
    initSimIfEmpty(db);
    tcs = seedCard(db, 'TCS', 'DIP_BUY', Math.round(currentPrice(db, 'TCS')! * 0.99));
    const now = Date.now();
    push(db, 'TCS', currentPrice(db, 'TCS')! * 0.95, now);
    evaluateSymbol(db, 'TCS', now);
  });

  it('turns a reviewed card into an actionable one', () => {
    expect(stateOf(db, tcs)).toBe('NEEDS_REVIEW');
    const r = acknowledge(db, tcs);
    expect(r.ok).toBe(true);
    expect(stateOf(db, tcs)).toBe('ACTIONABLE');
  });

  it('records that the user chose to go ahead, not that the market changed', () => {
    acknowledge(db, tcs);
    const e = db
      .prepare('SELECT reason FROM thesis_events WHERE item_id = ? ORDER BY id DESC LIMIT 1')
      .get(tcs) as { reason: string };
    expect(e.reason).toContain('You reviewed the conviction');
  });

  it('refuses on a card that is not asking for anything', () => {
    acknowledge(db, tcs);
    acknowledge(db, tcs);
    expect(acknowledge(db, tcs)).toMatchObject({ ok: false, error: 'NOT_REVIEWABLE' });
  });

  it('refuses on a card that does not exist', () => {
    expect(acknowledge(db, 'nope')).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });
});

describe('evaluation only looks at cards that could have changed', () => {
  it('ignores a symbol nobody is watching', () => {
    const db = createTestDb();
    initSimIfEmpty(db);
    seedCard(db, 'TCS', 'DIP_BUY', 1);
    const symbols = db
      .prepare('SELECT DISTINCT symbol FROM watchlist_items WHERE removed_at IS NULL')
      .all() as Array<{ symbol: string }>;
    expect(symbols).toEqual([{ symbol: 'TCS' }]);
  });

  it('skips a card whose threshold the price never came near', () => {
    // The scale claim in one test: a thesis can only change state if its
    // threshold lies in the band the price crossed, so a far-away trigger is
    // never even considered.
    const db = createTestDb();
    initSimIfEmpty(db);
    const far = seedCard(db, 'TCS', 'DIP_BUY', 1);
    const now = Date.now();
    push(db, 'TCS', currentPrice(db, 'TCS')! * 0.999, now);
    expect(evaluateSymbol(db, 'TCS', now)).toEqual([]);
    expect(stateOf(db, far)).toBe('WATCHING');
  });
});
