import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import {
  createWatchlist,
  deleteWatchlist,
  getWatchlist,
  listWatchlists,
  renameWatchlist,
  resolveWatchlist,
  MAX_NAME_LENGTH,
  MAX_WATCHLISTS,
} from '../../src/lib/watchlist/lists';
import { addItem, listItems } from '../../src/lib/watchlist/items';
import { markRead, unreadCount } from '../../src/lib/watchlist/read';

const USER = DEFAULT_USER_ID;

/**
 * Named watchlists.
 *
 * The case that actually matters is the last describe block: one symbol in two
 * lists under two theses. Everything else here is guarding the edges around it.
 */
describe('watchlists', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('naming', () => {
    it('creates a named list and returns it in order', () => {
      const made = createWatchlist(db, USER, 'Waiting for dips');
      expect(made.ok).toBe(true);

      const all = listWatchlists(db, USER);
      expect(all).toHaveLength(2);
      expect(all.map((w) => w.name)).toEqual(['My watchlist', 'Waiting for dips']);
    });

    it('trims and collapses whitespace so two spellings cannot both exist', () => {
      const made = createWatchlist(db, USER, '  Long   term  ');
      expect(made.ok && made.watchlist.name).toBe('Long term');

      expect(createWatchlist(db, USER, 'Long term')).toMatchObject({
        ok: false,
        error: 'DUPLICATE_NAME',
      });
    });

    it('rejects a duplicate name regardless of case, because a tab bar cannot show the difference', () => {
      createWatchlist(db, USER, 'Long term');
      expect(createWatchlist(db, USER, 'LONG TERM')).toMatchObject({
        ok: false,
        error: 'DUPLICATE_NAME',
      });
    });

    it('rejects an empty or whitespace-only name', () => {
      expect(createWatchlist(db, USER, '')).toMatchObject({ ok: false, error: 'EMPTY_NAME' });
      expect(createWatchlist(db, USER, '   ')).toMatchObject({ ok: false, error: 'EMPTY_NAME' });
    });

    it('rejects a name too long to render in a tab', () => {
      expect(createWatchlist(db, USER, 'x'.repeat(MAX_NAME_LENGTH + 1))).toMatchObject({
        ok: false,
        error: 'NAME_TOO_LONG',
      });
      expect(createWatchlist(db, USER, 'x'.repeat(MAX_NAME_LENGTH)).ok).toBe(true);
    });

    it('renames, and lets a list keep its own name in a different case', () => {
      const made = createWatchlist(db, USER, 'Dips');
      const id = made.ok ? made.watchlist.id : '';

      expect(renameWatchlist(db, id, USER, 'DIPS').ok).toBe(true);
      expect(getWatchlist(db, id, USER)?.name).toBe('DIPS');
    });

    it('refuses to rename onto another list', () => {
      const made = createWatchlist(db, USER, 'Dips');
      const id = made.ok ? made.watchlist.id : '';
      expect(renameWatchlist(db, id, USER, 'My watchlist')).toMatchObject({
        ok: false,
        error: 'DUPLICATE_NAME',
      });
    });

    it('refuses to rename a list that is not yours', () => {
      expect(renameWatchlist(db, 'wl_nope', USER, 'Anything')).toMatchObject({
        ok: false,
        error: 'UNKNOWN_WATCHLIST',
      });
    });

    it('stops at the ceiling, which is resource protection rather than a product opinion', () => {
      for (let i = 1; i < MAX_WATCHLISTS; i += 1) {
        expect(createWatchlist(db, USER, `List ${i}`).ok).toBe(true);
      }
      expect(listWatchlists(db, USER)).toHaveLength(MAX_WATCHLISTS);
      expect(createWatchlist(db, USER, 'One too many')).toMatchObject({
        ok: false,
        error: 'TOO_MANY_WATCHLISTS',
      });
    });
  });

  describe('removal', () => {
    it('soft-removes the cards in it and drops their threshold rows immediately', () => {
      const made = createWatchlist(db, USER, 'Dips');
      const id = made.ok ? made.watchlist.id : '';
      const added = addItem(db, {
        userId: USER,
        watchlistId: id,
        symbol: 'TCS',
        thesisType: 'DIP_BUY',
        params: { threshold: 3000 },
      });
      const itemId = added.ok ? added.item.id : '';

      const result = deleteWatchlist(db, id, USER);
      expect(result).toMatchObject({ ok: true, removedItems: 1 });

      // Soft, not hard: the row and its history survive so orders still resolve.
      const row = db
        .prepare('SELECT removed_at AS removedAt FROM watchlist_items WHERE id = ?')
        .get(itemId) as { removedAt: number | null };
      expect(row.removedAt).not.toBeNull();

      // "Stops alerting" has to be true when asked, not at the next sweep.
      const threshold = db
        .prepare('SELECT item_id FROM threshold_index WHERE item_id = ?')
        .get(itemId);
      expect(threshold).toBeUndefined();

      expect(listWatchlists(db, USER)).toHaveLength(1);
    });

    it('refuses to remove the last list, because a thesis needs somewhere to live', () => {
      expect(deleteWatchlist(db, DEFAULT_WATCHLIST_ID, USER)).toMatchObject({
        ok: false,
        error: 'LAST_WATCHLIST',
      });
      expect(listWatchlists(db, USER)).toHaveLength(1);
    });

    it('refuses to remove a list that is not yours', () => {
      createWatchlist(db, USER, 'Dips');
      expect(deleteWatchlist(db, 'wl_nope', USER)).toMatchObject({
        ok: false,
        error: 'UNKNOWN_WATCHLIST',
      });
    });
  });

  describe('resolution', () => {
    it('falls back to the first list when a tab asks for one that has been deleted', () => {
      const made = createWatchlist(db, USER, 'Dips');
      const id = made.ok ? made.watchlist.id : '';
      deleteWatchlist(db, id, USER);

      // A browser tab left open still holds the old id. It must land somewhere
      // real rather than render an empty screen.
      expect(resolveWatchlist(db, USER, id)?.id).toBe(DEFAULT_WATCHLIST_ID);
      expect(resolveWatchlist(db, USER, null)?.id).toBe(DEFAULT_WATCHLIST_ID);
    });
  });

  describe('summaries', () => {
    it('counts only live cards, and counts attention by the board rule', () => {
      addItem(db, {
        userId: USER,
        watchlistId: DEFAULT_WATCHLIST_ID,
        symbol: 'TCS',
        thesisType: 'JUST_WATCHING',
      });
      addItem(db, {
        userId: USER,
        watchlistId: DEFAULT_WATCHLIST_ID,
        symbol: 'INFY',
        thesisType: 'JUST_WATCHING',
      });

      const before = getWatchlist(db, DEFAULT_WATCHLIST_ID, USER)!;
      expect(before.itemCount).toBe(2);
      // WATCHING and FULFILLED are not attention, exactly as the board counts it.
      expect(before.attentionCount).toBe(0);

      db.prepare("UPDATE watchlist_items SET state = 'FULFILLED' WHERE symbol = 'INFY'").run();
      expect(getWatchlist(db, DEFAULT_WATCHLIST_ID, USER)!.attentionCount).toBe(0);

      db.prepare("UPDATE watchlist_items SET state = 'NEEDS_REVIEW' WHERE symbol = 'TCS'").run();
      expect(getWatchlist(db, DEFAULT_WATCHLIST_ID, USER)!.attentionCount).toBe(1);
    });
  });

  /**
   * This is the block the whole feature rests on. If one symbol in two lists
   * shared a thesis or a read position, multiple lists would be two views of
   * one thing rather than two intents, and read state keyed on the item
   * (D-043) would have been pointless.
   */
  describe('one symbol in two lists', () => {
    it('carries two independent theses and two independent read positions', () => {
      const made = createWatchlist(db, USER, 'Waiting for dips');
      const dips = made.ok ? made.watchlist.id : '';

      const longTerm = addItem(db, {
        userId: USER,
        watchlistId: DEFAULT_WATCHLIST_ID,
        symbol: 'RELIANCE',
        thesisType: 'DIP_BUY',
        params: { threshold: 2000 },
      });
      const shortTerm = addItem(db, {
        userId: USER,
        watchlistId: dips,
        symbol: 'RELIANCE',
        thesisType: 'DIP_BUY',
        params: { threshold: 2400 },
      });

      expect(longTerm.ok).toBe(true);
      expect(shortTerm.ok).toBe(true);
      const a = longTerm.ok ? longTerm.item.id : '';
      const b = shortTerm.ok ? shortTerm.item.id : '';
      expect(a).not.toBe(b);

      // Two theses on one stock, because the reason for watching differs.
      expect(listItems(db, DEFAULT_WATCHLIST_ID)[0].params.threshold).toBe(2000);
      expect(listItems(db, dips)[0].params.threshold).toBe(2400);

      // And two read positions. Reading one must not silently mark the other.
      db.prepare(
        `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, at)
         VALUES (?, 'WATCHING', 'NEEDS_REVIEW', 'test', '{}', 0)`,
      ).run(a);
      db.prepare(
        `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, at)
         VALUES (?, 'WATCHING', 'NEEDS_REVIEW', 'test', '{}', 0)`,
      ).run(b);

      expect(unreadCount(db, a)).toBe(1);
      expect(unreadCount(db, b)).toBe(1);

      const seq = db.prepare('SELECT MAX(id) AS m FROM thesis_events WHERE item_id = ?').get(a) as {
        m: number;
      };
      markRead(db, a, seq.m);

      expect(unreadCount(db, a)).toBe(0);
      expect(unreadCount(db, b)).toBe(1);
    });

    it('still refuses the same symbol twice within one list', () => {
      addItem(db, {
        userId: USER,
        watchlistId: DEFAULT_WATCHLIST_ID,
        symbol: 'TCS',
        thesisType: 'JUST_WATCHING',
      });
      expect(
        addItem(db, {
          userId: USER,
          watchlistId: DEFAULT_WATCHLIST_ID,
          symbol: 'TCS',
          thesisType: 'JUST_WATCHING',
        }),
      ).toMatchObject({ ok: false, error: 'DUPLICATE' });
    });
  });
});
