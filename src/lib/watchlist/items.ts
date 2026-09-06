import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  THESIS_TEMPLATES,
  type ItemState,
  type ThesisParams,
  type ThesisType,
} from '../domain/types';
import { isTemplateAllowed, phraseThesis, positionQuantity } from './templates';
import { evaluateItem } from '../engine/states';

/**
 * Watchlist CRUD.
 *
 * Three things here are less obvious than they look, and each one is tested:
 *
 * 1. A soft-removed item still occupies its UNIQUE(watchlist_id, symbol) slot,
 *    so re-adding a symbol you once removed must RESTORE it rather than fail on
 *    a constraint the user cannot see.
 * 2. Read state is seeded on add and advanced on every edit, so your own actions
 *    never come back to you as unread news.
 * 3. Removal deletes the threshold row immediately, because "stops alerting" has
 *    to be true the moment the user asks for it, not at the next sweep.
 *
 * Results are returned as a discriminated union rather than thrown, because
 * every failure here is an expected API response with its own status code, not
 * an exceptional condition.
 */

export interface WatchlistItem {
  id: string;
  watchlistId: string;
  userId: string;
  symbol: string;
  thesisType: ThesisType;
  params: ThesisParams;
  state: ItemState;
  version: number;
  removedAt: number | null;
  createdAt: number;
}

export type AddError =
  | 'UNKNOWN_SYMBOL'
  | 'NOT_WATCHABLE'
  | 'UNKNOWN_WATCHLIST'
  | 'UNKNOWN_TEMPLATE'
  | 'POSITION_REQUIRED'
  | 'THRESHOLD_REQUIRED'
  | 'INVALID_THRESHOLD'
  | 'DUPLICATE';

export type Result<T, E> =
  | ({ ok: true } & T)
  | ({ ok: false; error: E } & Record<string, unknown>);

interface ItemRow {
  id: string;
  watchlist_id: string;
  user_id: string;
  symbol: string;
  thesis_type: string;
  thesis_params: string;
  state: string;
  version: number;
  removed_at: number | null;
  created_at: number;
}

function hydrate(row: ItemRow): WatchlistItem {
  return {
    id: row.id,
    watchlistId: row.watchlist_id,
    userId: row.user_id,
    symbol: row.symbol,
    thesisType: row.thesis_type as ThesisType,
    params: JSON.parse(row.thesis_params) as ThesisParams,
    state: row.state as ItemState,
    version: row.version,
    removedAt: row.removed_at,
    createdAt: row.created_at,
  };
}

function newId(): string {
  return `it_${randomBytes(6).toString('hex')}`;
}

export function getItem(db: Database.Database, itemId: string): WatchlistItem | null {
  const row = db.prepare('SELECT * FROM watchlist_items WHERE id = ?').get(itemId) as
    | ItemRow
    | undefined;
  return row ? hydrate(row) : null;
}

/** Live cards only. A soft-removed item is invisible until it is restored. */
export function listItems(db: Database.Database, watchlistId: string): WatchlistItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM watchlist_items
        WHERE watchlist_id = ? AND removed_at IS NULL
        ORDER BY created_at ASC`,
    )
    .all(watchlistId) as ItemRow[];
  return rows.map(hydrate);
}

// ------------------------------------------------------------------ internals

/**
 * Appends a transition. `from_state` is 'NEW' on creation, which is not an
 * ItemState because the item did not exist yet; every other value is one.
 */
function appendEvent(
  db: Database.Database,
  itemId: string,
  fromState: ItemState | 'NEW',
  toState: ItemState,
  reason: string,
  at: number,
): number {
  const info = db
    .prepare(
      `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, at)
       VALUES (?, ?, ?, ?, '{}', ?)`,
    )
    .run(itemId, fromState, toState, reason, at);
  return Number(info.lastInsertRowid);
}

/**
 * Moves the read cursor past everything that exists right now.
 *
 * Called after the user's own add or edit. An unread badge on a card because you
 * just edited it yourself is the app talking to itself, and being unreasonably
 * hospitable means never spending someone's attention on their own keystrokes.
 */
function markSeenThroughNow(db: Database.Database, itemId: string): void {
  const row = db.prepare('SELECT MAX(id) AS m FROM thesis_events').get() as { m: number | null };
  const seq = row.m ?? 0;
  db.prepare(
    `INSERT INTO read_state (item_id, last_seen_seq) VALUES (?, ?)
     ON CONFLICT (item_id) DO UPDATE SET last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq)`,
  ).run(itemId, seq);
}

/**
 * Evaluates the card the user just touched, then marks the result seen.
 *
 * The state may legitimately change, but it changed because of an action the
 * user took while looking at this card, so it must not raise an unread badge
 * (D-073). Your own keystrokes are never news.
 */
function settle(db: Database.Database, itemId: string): void {
  const transition = evaluateItem(db, itemId);
  if (transition) markSeenThroughNow(db, itemId);
}

function syncThresholdIndex(
  db: Database.Database,
  itemId: string,
  symbol: string,
  thesisType: ThesisType,
  params: ThesisParams,
): void {
  db.prepare('DELETE FROM threshold_index WHERE item_id = ?').run(itemId);
  const direction = THESIS_TEMPLATES[thesisType].direction;
  if (!direction || params.threshold === undefined) return;
  db.prepare(
    'INSERT INTO threshold_index (item_id, symbol, threshold, direction) VALUES (?, ?, ?, ?)',
  ).run(itemId, symbol, params.threshold, direction);
}

/** Shared by add and edit: the thesis has to be coherent before it is stored. */
function validateThesis(
  db: Database.Database,
  userId: string,
  symbol: string,
  thesisType: ThesisType,
  params: ThesisParams,
): { ok: true; params: ThesisParams } | { ok: false; error: AddError } {
  const template = THESIS_TEMPLATES[thesisType];
  if (!template) return { ok: false, error: 'UNKNOWN_TEMPLATE' };

  if (!isTemplateAllowed(db, userId, symbol, thesisType)) {
    return { ok: false, error: 'POSITION_REQUIRED' };
  }

  if (template.direction === null) {
    // JUST_WATCHING. A threshold sent alongside it is meaningless rather than
    // wrong, so drop it quietly instead of refusing the request.
    return { ok: true, params: {} };
  }

  const t = params.threshold;
  if (t === undefined || t === null) return { ok: false, error: 'THRESHOLD_REQUIRED' };
  if (!Number.isFinite(t) || t <= 0) return { ok: false, error: 'INVALID_THRESHOLD' };
  return { ok: true, params: { threshold: t } };
}

// ------------------------------------------------------------------------ add

export interface AddInput {
  userId: string;
  watchlistId: string;
  symbol: string;
  thesisType: ThesisType;
  params?: ThesisParams;
  now?: number;
}

export function addItem(
  db: Database.Database,
  input: AddInput,
): Result<{ item: WatchlistItem; restored: boolean }, AddError> {
  const now = input.now ?? Date.now();

  const instrument = db
    .prepare('SELECT symbol, is_reference AS isReference FROM instruments WHERE symbol = ?')
    .get(input.symbol) as { symbol: string; isReference: number } | undefined;
  if (!instrument) return { ok: false, error: 'UNKNOWN_SYMBOL' };
  // An index is the yardstick, not a holding. It has no reference of its own, so
  // its conviction would be permanently UNKNOWN, and the market card already
  // shows the market's move more prominently than a card ever could.
  if (instrument.isReference === 1) return { ok: false, error: 'NOT_WATCHABLE' };

  const list = db.prepare('SELECT id FROM watchlists WHERE id = ?').get(input.watchlistId);
  if (!list) return { ok: false, error: 'UNKNOWN_WATCHLIST' };

  const existing = db
    .prepare('SELECT * FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?')
    .get(input.watchlistId, input.symbol) as ItemRow | undefined;

  if (existing && existing.removed_at === null) {
    // Section 6.2: offer to edit the thesis rather than report a constraint.
    return { ok: false, error: 'DUPLICATE', itemId: existing.id };
  }

  const validated = validateThesis(
    db,
    input.userId,
    input.symbol,
    input.thesisType,
    input.params ?? {},
  );
  if (!validated.ok) return { ok: false, error: validated.error };

  const id = existing ? existing.id : newId();
  const restored = existing !== undefined;
  const priorState = existing ? (existing.state as ItemState) : 'WATCHING';

  db.transaction(() => {
    if (restored) {
      db.prepare(
        `UPDATE watchlist_items
            SET thesis_type = ?, thesis_params = ?, state = 'WATCHING',
                version = version + 1, removed_at = NULL
          WHERE id = ?`,
      ).run(input.thesisType, JSON.stringify(validated.params), id);
    } else {
      db.prepare(
        `INSERT INTO watchlist_items
           (id, watchlist_id, user_id, symbol, thesis_type, thesis_params, state, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'WATCHING', 1, ?)`,
      ).run(
        id,
        input.watchlistId,
        input.userId,
        input.symbol,
        input.thesisType,
        JSON.stringify(validated.params),
        now,
      );
    }

    syncThresholdIndex(db, id, input.symbol, input.thesisType, validated.params);
    const line = phraseThesis(input.thesisType, validated.params.threshold);
    appendEvent(
      db,
      id,
      restored ? priorState : 'NEW',
      'WATCHING',
      restored ? `Restored to the watchlist. ${line}` : `Added to the watchlist. ${line}`,
      now,
    );
    // Seeded AFTER the creation event, so the user does not return to a backlog
    // consisting of their own action and, on a restore, does not inherit
    // everything that happened while the card was gone.
    markSeenThroughNow(db, id);
  })();

  // A thesis can be met the moment it is written. Evaluating here rather than
  // waiting for the next crossing is what stops "buy below 4000", set while the
  // stock sits at 3700, from staying in WATCHING forever (D-078).
  settle(db, id);

  return { ok: true, item: getItem(db, id)!, restored };
}

// ----------------------------------------------------------------------- edit

export type EditError = AddError | 'NOT_FOUND' | 'REMOVED' | 'VERSION_CONFLICT';

export interface EditInput {
  itemId: string;
  thesisType: ThesisType;
  params?: ThesisParams;
  /** Optimistic concurrency. Omit only from trusted internal callers. */
  version?: number;
  now?: number;
}

/**
 * Editing a thesis resets the card to WATCHING and bumps the version.
 *
 * The reset is not housekeeping. A card sitting in NEEDS_REVIEW is making a
 * claim about a thesis that no longer exists, and leaving it there would let the
 * app assert something it can no longer justify.
 */
export function editThesis(
  db: Database.Database,
  input: EditInput,
): Result<{ item: WatchlistItem }, EditError> {
  const now = input.now ?? Date.now();
  const current = getItem(db, input.itemId);
  if (!current) return { ok: false, error: 'NOT_FOUND' };
  if (current.removedAt !== null) return { ok: false, error: 'REMOVED' };
  if (input.version !== undefined && input.version !== current.version) {
    return { ok: false, error: 'VERSION_CONFLICT', currentVersion: current.version };
  }

  const validated = validateThesis(
    db,
    current.userId,
    current.symbol,
    input.thesisType,
    input.params ?? {},
  );
  if (!validated.ok) return { ok: false, error: validated.error };

  db.transaction(() => {
    db.prepare(
      `UPDATE watchlist_items
          SET thesis_type = ?, thesis_params = ?, state = 'WATCHING', version = version + 1
        WHERE id = ?`,
    ).run(input.thesisType, JSON.stringify(validated.params), input.itemId);

    syncThresholdIndex(db, input.itemId, current.symbol, input.thesisType, validated.params);
    appendEvent(
      db,
      input.itemId,
      current.state,
      'WATCHING',
      `Thesis changed. ${phraseThesis(input.thesisType, validated.params.threshold)}`,
      now,
    );
    markSeenThroughNow(db, input.itemId);
  })();

  settle(db, input.itemId);

  return { ok: true, item: getItem(db, input.itemId)! };
}

// --------------------------------------------------------------------- remove

export type RemoveError = 'NOT_FOUND' | 'ALREADY_REMOVED';

/**
 * Soft delete. Thesis events, orders and alert history all survive, because you
 * cannot un-place a trade by removing a card.
 */
export function removeItem(
  db: Database.Database,
  itemId: string,
  now: number = Date.now(),
): Result<{ item: WatchlistItem }, RemoveError> {
  const current = getItem(db, itemId);
  if (!current) return { ok: false, error: 'NOT_FOUND' };
  if (current.removedAt !== null) return { ok: false, error: 'ALREADY_REMOVED' };

  db.transaction(() => {
    db.prepare('UPDATE watchlist_items SET removed_at = ? WHERE id = ?').run(now, itemId);
    // Alerting has to stop the moment the user asks, not at the next sweep.
    db.prepare('DELETE FROM threshold_index WHERE item_id = ?').run(itemId);
    appendEvent(db, itemId, current.state, current.state, 'Removed from the watchlist.', now);
  })();

  return { ok: true, item: getItem(db, itemId)! };
}

/** Everything a card needs to render, resolved in one place. */
export interface ItemView extends WatchlistItem {
  thesisLine: string;
  positionQuantity: number;
  action: 'BUY' | 'SELL' | 'NONE';
}

export function viewItem(db: Database.Database, item: WatchlistItem): ItemView {
  return {
    ...item,
    thesisLine: phraseThesis(item.thesisType, item.params.threshold),
    positionQuantity: positionQuantity(db, item.userId, item.symbol),
    // The thesis determines the button. No card shows a generic Buy/Sell pair (D-034).
    action: THESIS_TEMPLATES[item.thesisType].action,
  };
}
