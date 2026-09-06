import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import {
  addItem,
  editThesis,
  removeItem,
  listItems,
  getItem,
  viewItem,
} from '../../src/lib/watchlist/items';
import { templatesFor, phraseThesis } from '../../src/lib/watchlist/templates';
import { ENTRY_CHOICES } from '../../src/lib/domain/types';

const USER = DEFAULT_USER_ID;
const LIST = DEFAULT_WATCHLIST_ID;

function givePosition(db: Database.Database, symbol: string, qty = 10): void {
  db.prepare(
    'INSERT INTO positions (user_id, symbol, quantity, avg_price) VALUES (?, ?, ?, ?)',
  ).run(USER, symbol, qty, 100);
}

function thresholdRow(db: Database.Database, itemId: string) {
  return db.prepare('SELECT * FROM threshold_index WHERE item_id = ?').get(itemId) as
    | { threshold: number; direction: string; symbol: string }
    | undefined;
}

function readCursor(db: Database.Database, itemId: string): number {
  const row = db.prepare('SELECT last_seen_seq AS s FROM read_state WHERE item_id = ?').get(itemId) as
    | { s: number }
    | undefined;
  return row?.s ?? -1;
}

function unreadCount(db: Database.Database, itemId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM thesis_events te
          JOIN read_state rs ON rs.item_id = te.item_id
         WHERE te.item_id = ? AND te.id > rs.last_seen_seq`,
      )
      .get(itemId) as { n: number }
  ).n;
}

describe('templates are gated on whether you hold the instrument', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it('offers only the entry theses when you hold nothing', () => {
    const types = templatesFor(db, USER, 'RELIANCE').map((t) => t.type);
    expect(types).toEqual(['DIP_BUY', 'BREAKOUT_BUY', 'JUST_WATCHING']);
  });

  it('unlocks the exit and add theses once a position exists', () => {
    givePosition(db, 'RELIANCE');
    const types = templatesFor(db, USER, 'RELIANCE').map((t) => t.type);
    expect(types).toContain('ADD_MORE');
    expect(types).toContain('BOOK_PROFIT');
    expect(types).toContain('PROTECT');
  });

  it('renders the threshold into the thesis sentence', () => {
    expect(phraseThesis('DIP_BUY', 3800)).toBe('Buy if it falls below ₹3,800');
    expect(phraseThesis('JUST_WATCHING')).toMatch(/No conditions/);
  });

  it('never shows the raw placeholder in the picker', () => {
    // Found by reading the picker output: every conditional template rendered
    // as "Buy if it falls below {t}". A type checker cannot see this.
    for (const choice of templatesFor(db, USER, 'RELIANCE')) {
      expect(choice.prompt).not.toContain('{t}');
    }
    const dip = templatesFor(db, USER, 'RELIANCE').find((t) => t.type === 'DIP_BUY')!;
    expect(dip.prompt).toBe('Buy if it falls below ₹—');
    expect(dip.requiresThreshold).toBe(true);
  });

  it('tells the picker which templates need a number', () => {
    const watching = templatesFor(db, USER, 'RELIANCE').find((t) => t.type === 'JUST_WATCHING')!;
    expect(watching.requiresThreshold).toBe(false);
  });

  it('offers a searched symbol exactly what the server would, flag included', () => {
    /*
     * The browser cannot ask the server for templates on an instrument that does
     * not exist yet, which is every symbol found by live search, so it falls back
     * to a list of its own. That list used to be typed out by hand and had simply
     * omitted `requiresThreshold`. The price input is gated on that flag, so on a
     * searched symbol the box never rendered: you picked "buy if it rises above",
     * were given nowhere to type a number, pressed Add, and were told the thesis
     * needs a price. Both threshold theses -- two of the three on offer -- were
     * unusable, and no test saw it because every test asked the server (D-125).
     *
     * The fallback is now derived from the same table, and this asserts the two
     * can never drift again.
     */
    expect(ENTRY_CHOICES).toEqual(templatesFor(db, USER, 'RELIANCE'));
    const above = ENTRY_CHOICES.find((t) => t.type === 'BREAKOUT_BUY')!;
    expect(above.requiresThreshold).toBe(true);
  });
});

describe('adding an item', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it('creates a card in WATCHING at version 1', () => {
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'DIP_BUY',
      params: { threshold: 3800 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.state).toBe('WATCHING');
    expect(r.item.version).toBe(1);
    expect(r.item.params.threshold).toBe(3800);
  });

  it('registers the threshold so a tick can range-query it', () => {
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'DIP_BUY',
      params: { threshold: 3800 },
    });
    if (!r.ok) throw new Error('add failed');
    expect(thresholdRow(db, r.item.id)).toMatchObject({
      symbol: 'TCS',
      threshold: 3800,
      direction: 'BELOW',
    });
  });

  it('does not hand the user their own action back as unread news', () => {
    // The creation event is real history, but it is history the user just made.
    // An unread badge here would be the app talking to itself.
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'DIP_BUY',
      params: { threshold: 3800 },
    });
    if (!r.ok) throw new Error('add failed');
    expect(unreadCount(db, r.item.id)).toBe(0);
    expect(readCursor(db, r.item.id)).toBeGreaterThan(0);
  });

  it('records why the card exists', () => {
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'DIP_BUY',
      params: { threshold: 3800 },
    });
    if (!r.ok) throw new Error('add failed');
    const event = db
      .prepare('SELECT from_state, to_state, reason FROM thesis_events WHERE item_id = ?')
      .get(r.item.id) as { from_state: string; to_state: string; reason: string };
    expect(event.from_state).toBe('NEW');
    expect(event.to_state).toBe('WATCHING');
    expect(event.reason).toContain('₹3,800');
  });

  it('creates no threshold row for JUST_WATCHING', () => {
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'ITC',
      thesisType: 'JUST_WATCHING',
    });
    if (!r.ok) throw new Error('add failed');
    expect(thresholdRow(db, r.item.id)).toBeUndefined();
  });

  it('quietly drops a threshold sent with JUST_WATCHING', () => {
    // Meaningless rather than wrong. Refusing the request would be pedantic.
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'ITC',
      thesisType: 'JUST_WATCHING',
      params: { threshold: 400 },
    });
    if (!r.ok) throw new Error('add failed');
    expect(r.item.params.threshold).toBeUndefined();
  });
});

describe('adding refuses what it cannot honour', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  const add = (over: Record<string, unknown>) =>
    addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'DIP_BUY',
      params: { threshold: 3800 },
      ...over,
    } as Parameters<typeof addItem>[1]);

  it('refuses an instrument we do not list', () => {
    expect(add({ symbol: 'NOT_LISTED' })).toMatchObject({ ok: false, error: 'UNKNOWN_SYMBOL' });
  });

  it('refuses a market index', () => {
    // An index is the yardstick, not a holding. Its conviction would be
    // permanently UNKNOWN, and the market card already shows the market's move.
    expect(add({ symbol: 'NIFTY50' })).toMatchObject({ ok: false, error: 'NOT_WATCHABLE' });
  });

  it('refuses a position thesis when there is no position, server-side', () => {
    // Gating lives here and not only in the picker, because the API is
    // reachable without the UI and a UI rule is only a suggestion.
    expect(add({ thesisType: 'PROTECT' })).toMatchObject({
      ok: false,
      error: 'POSITION_REQUIRED',
    });
  });

  it('accepts that same thesis once the position exists', () => {
    givePosition(db, 'TCS');
    expect(add({ thesisType: 'PROTECT' })).toMatchObject({ ok: true });
  });

  it('refuses a conditional thesis with no threshold', () => {
    expect(add({ params: {} })).toMatchObject({ ok: false, error: 'THRESHOLD_REQUIRED' });
  });

  it.each([
    ['zero', 0],
    ['negative', -50],
    ['NaN', Number.NaN],
  ])('refuses a %s threshold', (_label, threshold) => {
    expect(add({ params: { threshold } })).toMatchObject({
      ok: false,
      error: 'INVALID_THRESHOLD',
    });
  });

  it('reports a duplicate with the existing card, so the UI can offer an edit', () => {
    const first = add({});
    if (!first.ok) throw new Error('first add failed');
    expect(add({})).toMatchObject({ ok: false, error: 'DUPLICATE', itemId: first.item.id });
  });
});

describe('removing is soft, and re-adding restores', () => {
  let db: Database.Database;
  let itemId: string;

  beforeEach(() => {
    db = createTestDb();
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'DIP_BUY',
      params: { threshold: 3800 },
    });
    if (!r.ok) throw new Error('add failed');
    itemId = r.item.id;
  });

  it('hides the card but keeps the row', () => {
    removeItem(db, itemId);
    expect(listItems(db, LIST)).toEqual([]);
    expect(getItem(db, itemId)).not.toBeNull();
  });

  it('stops alerting the moment it is asked, not at the next sweep', () => {
    removeItem(db, itemId);
    expect(thresholdRow(db, itemId)).toBeUndefined();
  });

  it('keeps the history that orders and alerts point at', () => {
    removeItem(db, itemId);
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM thesis_events WHERE item_id = ?').get(itemId) as {
        n: number;
      }
    ).n;
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('refuses to remove twice', () => {
    removeItem(db, itemId);
    expect(removeItem(db, itemId)).toMatchObject({ ok: false, error: 'ALREADY_REMOVED' });
  });

  it('re-adds without tripping a constraint the user cannot see', () => {
    // The UNIQUE(watchlist_id, symbol) slot is still occupied by the hidden row.
    // A naive insert would report "already in your list" for a card that is not
    // in the list, which is the kind of bug that only appears in a demo.
    removeItem(db, itemId);
    const again = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'BREAKOUT_BUY',
      params: { threshold: 4200 },
    });
    expect(again).toMatchObject({ ok: true, restored: true });
    if (!again.ok) return;
    expect(again.item.id).toBe(itemId);
    expect(again.item.removedAt).toBeNull();
    expect(again.item.thesisType).toBe('BREAKOUT_BUY');
    expect(thresholdRow(db, itemId)).toMatchObject({ threshold: 4200, direction: 'ABOVE' });
  });

  it('does not hand back everything that happened while the card was gone', () => {
    removeItem(db, itemId);
    db.prepare(
      `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, at)
       VALUES (?, 'WATCHING', 'WATCHING', 'happened while removed', '{}', 1)`,
    ).run(itemId);

    addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'DIP_BUY',
      params: { threshold: 3800 },
    });

    expect(unreadCount(db, itemId)).toBe(0);
  });
});

describe('editing a thesis', () => {
  let db: Database.Database;
  let itemId: string;

  beforeEach(() => {
    db = createTestDb();
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'TCS',
      thesisType: 'DIP_BUY',
      params: { threshold: 3800 },
    });
    if (!r.ok) throw new Error('add failed');
    itemId = r.item.id;
    db.prepare("UPDATE watchlist_items SET state = 'NEEDS_REVIEW' WHERE id = ?").run(itemId);
  });

  it('resets the card to WATCHING', () => {
    // A card in NEEDS_REVIEW is making a claim about a thesis that no longer
    // exists. Leaving it there lets the app assert something it cannot justify.
    const r = editThesis(db, { itemId, thesisType: 'DIP_BUY', params: { threshold: 3600 } });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.item.state).toBe('WATCHING');
    expect(r.item.params.threshold).toBe(3600);
  });

  it('bumps the version', () => {
    const r = editThesis(db, { itemId, thesisType: 'DIP_BUY', params: { threshold: 3600 } });
    if (!r.ok) throw new Error('edit failed');
    expect(r.item.version).toBe(2);
  });

  it('moves the threshold the tick engine will query', () => {
    editThesis(db, { itemId, thesisType: 'DIP_BUY', params: { threshold: 3600 } });
    expect(thresholdRow(db, itemId)).toMatchObject({ threshold: 3600 });
  });

  it('drops the threshold entirely when switched to JUST_WATCHING', () => {
    editThesis(db, { itemId, thesisType: 'JUST_WATCHING' });
    expect(thresholdRow(db, itemId)).toBeUndefined();
  });

  it('rejects a stale version and reports the current one', () => {
    editThesis(db, { itemId, thesisType: 'DIP_BUY', params: { threshold: 3600 } });
    expect(
      editThesis(db, { itemId, thesisType: 'DIP_BUY', params: { threshold: 3500 }, version: 1 }),
    ).toMatchObject({ ok: false, error: 'VERSION_CONFLICT', currentVersion: 2 });
  });

  it('accepts a matching version', () => {
    expect(
      editThesis(db, { itemId, thesisType: 'DIP_BUY', params: { threshold: 3500 }, version: 1 }),
    ).toMatchObject({ ok: true });
  });

  it('applies the same position gate as adding', () => {
    expect(editThesis(db, { itemId, thesisType: 'PROTECT', params: { threshold: 3500 } })).toMatchObject(
      { ok: false, error: 'POSITION_REQUIRED' },
    );
  });

  it('refuses to edit a removed card', () => {
    removeItem(db, itemId);
    expect(editThesis(db, { itemId, thesisType: 'DIP_BUY', params: { threshold: 1 } })).toMatchObject(
      { ok: false, error: 'REMOVED' },
    );
  });

  it('refuses an unknown card', () => {
    expect(editThesis(db, { itemId: 'nope', thesisType: 'DIP_BUY' })).toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  it('does not make the user unread their own edit', () => {
    editThesis(db, { itemId, thesisType: 'DIP_BUY', params: { threshold: 3600 } });
    expect(unreadCount(db, itemId)).toBe(0);
  });
});

describe('the thesis decides which single action a card offers', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it.each([
    ['DIP_BUY', 'BUY', false],
    ['BREAKOUT_BUY', 'BUY', false],
    ['ADD_MORE', 'BUY', true],
    ['BOOK_PROFIT', 'SELL', true],
    ['PROTECT', 'SELL', true],
    ['JUST_WATCHING', 'NONE', false],
  ] as const)('%s offers %s', (thesisType, action, needsPosition) => {
    if (needsPosition) givePosition(db, 'INFY');
    const r = addItem(db, {
      userId: USER,
      watchlistId: LIST,
      symbol: 'INFY',
      thesisType,
      params: { threshold: 1500 },
    });
    if (!r.ok) throw new Error('add failed');
    expect(viewItem(db, r.item).action).toBe(action);
  });
});
