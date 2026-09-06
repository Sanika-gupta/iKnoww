import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import { addItem, removeItem } from '../../src/lib/watchlist/items';
import {
  markRead,
  readCursor,
  latestSeq,
  unreadCount,
  changesSince,
  historyFor,
} from '../../src/lib/watchlist/read';
import { currentPrice, initSimIfEmpty } from '../../src/lib/sim/ticker';
import { ingestPrice, nextSeq } from '../../src/lib/engine/ingest';
import { evaluateAll } from '../../src/lib/engine/states';

const USER = DEFAULT_USER_ID;
const LIST = DEFAULT_WATCHLIST_ID;

/** An empty watchlist with live prices, so each test controls exactly what moves. */
function freshDb(): Database.Database {
  const db = createTestDb();
  initSimIfEmpty(db);
  return db;
}

function card(db: Database.Database, symbol: string, ratio: number): string {
  const r = addItem(db, {
    userId: USER,
    watchlistId: LIST,
    symbol,
    thesisType: 'DIP_BUY',
    params: { threshold: Math.round(currentPrice(db, symbol)! * ratio) },
  });
  if (!r.ok) throw new Error(`add failed: ${r.error}`);
  return r.item.id;
}

/** Moves a symbol and settles the states, producing real events to be read. */
function move(db: Database.Database, symbol: string, factor: number, at: number): void {
  ingestPrice(db, {
    symbol,
    seq: nextSeq(db, symbol),
    price: currentPrice(db, symbol)! * factor,
    asOf: at,
  });
  evaluateAll(db, at);
}

describe('the merge is max, and that is the whole design', () => {
  let db: Database.Database;
  let id: string;

  beforeEach(() => {
    db = freshDb();
    id = card(db, 'TCS', 0.5);
    const now = Date.now();
    move(db, 'TCS', 0.4, now);
    move(db, 'TCS', 1.9, now + 1000);
    move(db, 'TCS', 0.4, now + 2000);
  });

  it('advances the cursor forward', () => {
    const seq = latestSeq(db, id);
    expect(markRead(db, id, seq)).toMatchObject({ lastSeenSeq: seq, advanced: true });
  });

  it('is idempotent: marking the same point twice changes nothing', () => {
    const seq = latestSeq(db, id);
    markRead(db, id, seq);
    expect(markRead(db, id, seq)).toMatchObject({ lastSeenSeq: seq, advanced: false });
  });

  it('is order-independent: a late, staler post cannot rewind it', () => {
    // This is the property the whole cross-device story rests on. A second
    // device with an older view posts an older sequence; taking the maximum
    // means it cannot swallow events it never showed anyone.
    const seq = latestSeq(db, id);
    markRead(db, id, seq);
    markRead(db, id, seq - 2);
    expect(readCursor(db, id)).toBe(seq);
  });

  it('converges however two devices interleave', () => {
    const seq = latestSeq(db, id);
    // Device A saw everything, device B saw one event less, in either order.
    const a = freshDb();
    const idA = card(a, 'TCS', 0.5);
    markRead(a, idA, 5);
    markRead(a, idA, 3);

    const b = freshDb();
    const idB = card(b, 'TCS', 0.5);
    markRead(b, idB, 3);
    markRead(b, idB, 5);

    expect(readCursor(a, idA)).toBe(readCursor(b, idB));
    expect(seq).toBeGreaterThan(0);
  });

  it('refuses a negative sequence rather than corrupting the cursor', () => {
    markRead(db, id, latestSeq(db, id));
    const before = readCursor(db, id);
    markRead(db, id, -50);
    expect(readCursor(db, id)).toBe(before);
  });
});

describe('what counts as unread', () => {
  let db: Database.Database;
  let tcs: string;
  let infy: string;

  beforeEach(() => {
    db = freshDb();
    tcs = card(db, 'TCS', 0.5);
    infy = card(db, 'INFY', 0.5);
    const now = Date.now();
    move(db, 'TCS', 0.4, now);
    move(db, 'INFY', 0.4, now + 1000);
  });

  it('counts what happened past the cursor', () => {
    expect(unreadCount(db, tcs)).toBeGreaterThan(0);
  });

  it('clears only the card that was opened, never its neighbours', () => {
    // The silent swallow: glance at two cards out of twelve and a last-visit
    // timestamp marks all twelve seen. The ten you never looked at vanish, and
    // the app tells you nothing changed. That defect lives in the read model,
    // so no amount of event logging fixes it.
    markRead(db, tcs, latestSeq(db, tcs));
    expect(unreadCount(db, tcs)).toBe(0);
    expect(unreadCount(db, infy)).toBeGreaterThan(0);
  });

  it('keeps two independent positions for the same stock in two lists', () => {
    // The same symbol can carry different theses in different lists, so it
    // carries different read positions too. Keying on the symbol would merge
    // them and lose one (D-043).
    db.prepare('INSERT INTO watchlists (id, user_id, name, position) VALUES (?,?,?,1)').run(
      'wl_second',
      USER,
      'Second list',
    );
    const other = addItem(db, {
      userId: USER,
      watchlistId: 'wl_second',
      symbol: 'TCS',
      thesisType: 'BREAKOUT_BUY',
      params: { threshold: 1 },
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;

    markRead(db, tcs, latestSeq(db, tcs));
    expect(other.item.id).not.toBe(tcs);
    expect(readCursor(db, other.item.id)).not.toBe(readCursor(db, tcs));
  });
});

describe('the catch-up digest', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    card(db, 'TCS', 0.5);
    card(db, 'INFY', 0.5);
    card(db, 'RELIANCE', 0.5);
    const now = Date.now();
    move(db, 'TCS', 0.4, now);
    move(db, 'INFY', 0.4, now + 1000);
  });

  it('costs what actually changed, not the size of the watchlist', () => {
    // A two-hundred item list with three changes returns three rows. That is
    // exactly why a large watchlist is nearly free here, and why capping the
    // size was never the right answer to "how does it scale" (D-039).
    const changes = changesSince(db, LIST);
    const symbols = new Set(changes.map((c) => c.symbol));
    expect(symbols.has('TCS')).toBe(true);
    expect(symbols.has('INFY')).toBe(true);
    expect(symbols.has('RELIANCE')).toBe(false);
  });

  it('shrinks as cards are opened', () => {
    const before = changesSince(db, LIST).length;
    const tcsChange = changesSince(db, LIST).find((c) => c.symbol === 'TCS')!;
    markRead(db, tcsChange.itemId, tcsChange.seq);
    expect(changesSince(db, LIST).length).toBeLessThan(before);
  });

  it('newest first, so the top of the list is the most recent thing', () => {
    const changes = changesSince(db, LIST);
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i - 1].seq).toBeGreaterThan(changes[i].seq);
    }
  });

  it('ignores cards the user removed', () => {
    const change = changesSince(db, LIST).find((c) => c.symbol === 'TCS')!;
    removeItem(db, change.itemId);
    expect(changesSince(db, LIST).some((c) => c.symbol === 'TCS')).toBe(false);
  });
});

describe('a card keeps its own history', () => {
  it('records every transition, newest first', () => {
    const db = freshDb();
    const id = card(db, 'TCS', 0.5);
    const now = Date.now();
    move(db, 'TCS', 0.4, now);
    move(db, 'TCS', 1.9, now + 1000);

    const history = historyFor(db, id);
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history[0].seq).toBeGreaterThan(history[history.length - 1].seq);
    for (const h of history) expect(h.reason.length).toBeGreaterThan(0);
  });
});
