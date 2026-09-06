import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { Result } from './items';

/**
 * Named watchlists.
 *
 * The `watchlists` table and `UNIQUE(watchlist_id, symbol)` have been in the
 * schema since day one (D-042), and read state was keyed on the item rather
 * than the symbol precisely so one stock could sit in two lists under two
 * different theses and keep two independent read positions (D-043). So this
 * file is the missing half of a decision already made, not a migration.
 *
 * The product argument is intent. "Long term" and "waiting for dips" are
 * different reasons to watch the same market, and the reason is what this whole
 * product is built on. It also closes a promise the design had already made and
 * could not keep: the soft nudge at around thirty items offers to SPLIT a list,
 * which is impossible when a user can only have one.
 */

export interface WatchlistSummary {
  id: string;
  name: string;
  position: number;
  itemCount: number;
  /**
   * Cards this list wants something from you about, by exactly the rule the
   * board itself uses. Two counts of the same thing that disagree is the defect
   * D-082 was about, so there is one rule and both callers apply it.
   */
  attentionCount: number;
  unreadCount: number;
}

export type ListError =
  | 'EMPTY_NAME'
  | 'NAME_TOO_LONG'
  | 'DUPLICATE_NAME'
  | 'UNKNOWN_WATCHLIST'
  | 'LAST_WATCHLIST'
  | 'TOO_MANY_WATCHLISTS';

export const MAX_NAME_LENGTH = 40;

/**
 * Resource protection, not a product opinion about attention (Section 10.6).
 * The opinion is the soft nudge on list SIZE, which never blocks. Conflating
 * the two is the mistake that section exists to name.
 */
export const MAX_WATCHLISTS = 20;

function newId(): string {
  return `wl_${randomBytes(6).toString('hex')}`;
}

/** Collapses runs of whitespace so " Long   term " and "Long term" collide. */
function normalise(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

const SUMMARY_SQL = `
  SELECT w.id, w.name, w.position,
         (SELECT COUNT(*) FROM watchlist_items i
           WHERE i.watchlist_id = w.id AND i.removed_at IS NULL) AS itemCount,
         (SELECT COUNT(*) FROM watchlist_items i
           WHERE i.watchlist_id = w.id AND i.removed_at IS NULL
             AND i.state != 'WATCHING' AND i.state != 'FULFILLED') AS attentionCount,
         (SELECT COUNT(*) FROM watchlist_items i
             JOIN thesis_events te ON te.item_id = i.id
             LEFT JOIN read_state rs ON rs.item_id = i.id
           WHERE i.watchlist_id = w.id AND i.removed_at IS NULL
             AND te.id > COALESCE(rs.last_seen_seq, 0)) AS unreadCount
    FROM watchlists w`;

export function listWatchlists(db: Database.Database, userId: string): WatchlistSummary[] {
  return db
    .prepare(
      `${SUMMARY_SQL}
        WHERE w.user_id = ? AND w.removed_at IS NULL
        ORDER BY w.position ASC, w.name ASC`,
    )
    .all(userId) as WatchlistSummary[];
}

export function getWatchlist(
  db: Database.Database,
  watchlistId: string,
  userId: string,
): WatchlistSummary | null {
  const row = db
    .prepare(`${SUMMARY_SQL} WHERE w.id = ? AND w.user_id = ? AND w.removed_at IS NULL`)
    .get(watchlistId, userId) as WatchlistSummary | undefined;
  return row ?? null;
}

/**
 * Resolves the list a request is about, falling back to the user's first list.
 *
 * A stale id in a browser tab must not produce an empty screen or a crash, and
 * a user always has at least one list because the last one cannot be deleted.
 */
export function resolveWatchlist(
  db: Database.Database,
  userId: string,
  requested?: string | null,
): WatchlistSummary | null {
  if (requested) {
    const found = getWatchlist(db, requested, userId);
    if (found) return found;
  }
  return listWatchlists(db, userId)[0] ?? null;
}

function validateName(
  db: Database.Database,
  userId: string,
  raw: string,
  excludingId?: string,
): { ok: true; name: string } | { ok: false; error: ListError } {
  const name = normalise(raw);
  if (name.length === 0) return { ok: false, error: 'EMPTY_NAME' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: 'NAME_TOO_LONG' };

  // Case-insensitive, because two lists called "Long term" and "long term" are
  // the same list to the person reading the tab bar.
  // Only live lists collide. A name freed by a removal is reusable, and reusing
  // it makes a NEW empty list rather than resurrecting the old one: a list name
  // is a label, where a symbol re-added to a list is the same thesis coming back
  // (D-074). Restoring someone's deleted cards because they reused a word would
  // be a surprise, not a kindness.
  const clash = db
    .prepare(
      `SELECT id FROM watchlists
        WHERE user_id = ? AND LOWER(name) = LOWER(?) AND removed_at IS NULL
          AND id != COALESCE(?, '')`,
    )
    .get(userId, name, excludingId ?? null) as { id: string } | undefined;
  if (clash) return { ok: false, error: 'DUPLICATE_NAME' };

  return { ok: true, name };
}

export function createWatchlist(
  db: Database.Database,
  userId: string,
  rawName: string,
): Result<{ watchlist: WatchlistSummary }, ListError> {
  const existing = listWatchlists(db, userId);
  if (existing.length >= MAX_WATCHLISTS) return { ok: false, error: 'TOO_MANY_WATCHLISTS' };

  const checked = validateName(db, userId, rawName);
  if (!checked.ok) return { ok: false, error: checked.error };

  const id = newId();
  const position = existing.reduce((max, w) => Math.max(max, w.position), -1) + 1;
  db.prepare('INSERT INTO watchlists (id, user_id, name, position) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    checked.name,
    position,
  );
  return { ok: true, watchlist: getWatchlist(db, id, userId)! };
}

export function renameWatchlist(
  db: Database.Database,
  watchlistId: string,
  userId: string,
  rawName: string,
): Result<{ watchlist: WatchlistSummary }, ListError> {
  if (!getWatchlist(db, watchlistId, userId)) return { ok: false, error: 'UNKNOWN_WATCHLIST' };

  const checked = validateName(db, userId, rawName, watchlistId);
  if (!checked.ok) return { ok: false, error: checked.error };

  db.prepare('UPDATE watchlists SET name = ? WHERE id = ? AND user_id = ?').run(
    checked.name,
    watchlistId,
    userId,
  );
  return { ok: true, watchlist: getWatchlist(db, watchlistId, userId)! };
}

/**
 * Removing a list soft-removes it AND its items, exactly as removing one card
 * does (D-074). Orders and alert history survive, because you cannot un-place a
 * trade by tidying up a tab.
 *
 * The list row itself is kept rather than deleted, and that is not tidiness: a
 * soft-removed item still points at its list, so a hard delete fails the
 * foreign key, and forcing it through would take the history of every card in
 * the list with it. Found by the test below rather than by reading the schema.
 *
 * The last list cannot be removed. That is not a limit, it is the invariant
 * every other query already assumes: a user always has somewhere to put a
 * thesis, so nothing has to handle the zero-list case.
 */
export function deleteWatchlist(
  db: Database.Database,
  watchlistId: string,
  userId: string,
  now = Date.now(),
): Result<{ removedItems: number }, ListError> {
  if (!getWatchlist(db, watchlistId, userId)) return { ok: false, error: 'UNKNOWN_WATCHLIST' };
  if (listWatchlists(db, userId).length <= 1) return { ok: false, error: 'LAST_WATCHLIST' };

  const removed = db.transaction(() => {
    const items = db
      .prepare('SELECT id FROM watchlist_items WHERE watchlist_id = ? AND removed_at IS NULL')
      .all(watchlistId) as Array<{ id: string }>;

    for (const item of items) {
      db.prepare('UPDATE watchlist_items SET removed_at = ? WHERE id = ?').run(now, item.id);
      // "Stops alerting" has to be true the moment it is asked, not at the next
      // sweep, so the threshold row goes now rather than later (D-074).
      db.prepare('DELETE FROM threshold_index WHERE item_id = ?').run(item.id);
    }

    db.prepare('UPDATE watchlists SET removed_at = ? WHERE id = ? AND user_id = ?').run(
      now,
      watchlistId,
      userId,
    );
    return items.length;
  })();

  return { ok: true, removedItems: removed };
}
