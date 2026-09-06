import type Database from 'better-sqlite3';

/**
 * Read state.
 *
 * The whole design is one line of SQL, and the reason it is only one line is the
 * point: `last_seen_seq` only ever moves forward, so merging two devices is
 * taking the larger of two numbers. Duplicate deliveries, out-of-order arrivals
 * and two devices writing at the same moment all converge on the same answer,
 * with no locking and no last-writer-wins race, because `max` does not care
 * about order.
 *
 * It is a grow-only register, the simplest conflict-free replicated data type
 * there is. We get the property without importing a CRDT library because the
 * data already has the right shape.
 *
 * Two things it is deliberately NOT:
 *
 *   Not a per-user "last opened" timestamp. Glance at two cards out of twelve
 *   and a timestamp cursor marks all twelve seen; the ten you never looked at
 *   are gone forever and the app tells you nothing changed. That defect lives in
 *   the read model, so no amount of event logging fixes it.
 *
 *   Not keyed on the symbol. The same stock can sit in two lists carrying two
 *   different theses, and those are two independent read positions (D-043).
 */

export interface ReadResult {
  itemId: string;
  lastSeenSeq: number;
  /** True when this call actually advanced the cursor. */
  advanced: boolean;
}

export function readCursor(db: Database.Database, itemId: string): number {
  const row = db.prepare('SELECT last_seen_seq AS s FROM read_state WHERE item_id = ?').get(itemId) as
    | { s: number }
    | undefined;
  return row?.s ?? 0;
}

/** The newest event on a card. What a client posts back when it opens one. */
export function latestSeq(db: Database.Database, itemId: string): number {
  const row = db
    .prepare('SELECT MAX(id) AS m FROM thesis_events WHERE item_id = ?')
    .get(itemId) as { m: number | null };
  return row.m ?? 0;
}

export function unreadCount(db: Database.Database, itemId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM thesis_events te
         LEFT JOIN read_state rs ON rs.item_id = te.item_id
        WHERE te.item_id = ? AND te.id > COALESCE(rs.last_seen_seq, 0)`,
    )
    .get(itemId) as { n: number };
  return row.n;
}

/**
 * Marks a card seen up to a point the client actually saw.
 *
 * The client sends the sequence it rendered rather than the server assuming
 * "everything up to now". That is what makes a second device with a staler view
 * unable to swallow events it never showed anyone.
 */
export function markRead(db: Database.Database, itemId: string, seq: number): ReadResult {
  const before = readCursor(db, itemId);
  db.prepare(
    `INSERT INTO read_state (item_id, last_seen_seq) VALUES (?, ?)
     ON CONFLICT (item_id) DO UPDATE SET last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq)`,
  ).run(itemId, Math.max(0, Math.floor(seq)));
  const after = readCursor(db, itemId);
  return { itemId, lastSeenSeq: after, advanced: after > before };
}

export interface Change {
  itemId: string;
  symbol: string;
  seq: number;
  fromState: string;
  toState: string;
  reason: string;
  at: number;
  /** Set when this change was delivered as an alert but the card is still unread. */
  notifiedAt: number | null;
}

/**
 * What changed since you last looked.
 *
 * Costs O(changes), not O(watchlist size). A two-hundred item watchlist with
 * three changes returns three rows, which is exactly why a large watchlist is
 * nearly free here and why capping the size was never necessary (D-039).
 */
export function changesSince(db: Database.Database, watchlistId: string): Change[] {
  return db
    .prepare(
      `SELECT te.item_id AS itemId, wi.symbol, te.id AS seq, te.from_state AS fromState,
              te.to_state AS toState, te.reason, te.at, te.notified_at AS notifiedAt
         FROM thesis_events te
         JOIN watchlist_items wi ON wi.id = te.item_id
         LEFT JOIN read_state rs ON rs.item_id = te.item_id
        WHERE wi.watchlist_id = ?
          AND wi.removed_at IS NULL
          AND te.id > COALESCE(rs.last_seen_seq, 0)
        ORDER BY te.id DESC`,
    )
    .all(watchlistId) as Change[];
}

/** Every transition on one card, newest first. The card's own history. */
export function historyFor(db: Database.Database, itemId: string, limit = 12): Change[] {
  return db
    .prepare(
      `SELECT te.item_id AS itemId, wi.symbol, te.id AS seq, te.from_state AS fromState,
              te.to_state AS toState, te.reason, te.at, te.notified_at AS notifiedAt
         FROM thesis_events te
         JOIN watchlist_items wi ON wi.id = te.item_id
        WHERE te.item_id = ?
        ORDER BY te.id DESC
        LIMIT ?`,
    )
    .all(itemId, limit) as Change[];
}
