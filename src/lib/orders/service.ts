import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { THESIS_TEMPLATES, type ItemState } from '../domain/types';
import { computeConviction } from '../engine/conviction';
import { getItem } from '../watchlist/items';
import { phraseThesis } from '../watchlist/templates';
import { isMarketOpen, isWeekend, istMinutesOfDay, fetchedSession } from '../alerts/policy';

/**
 * Paper orders.
 *
 * An ACTIONABLE state that leads nowhere is a dead end, so every card carries
 * the one action its thesis leads to. Two things stop this being a plain button:
 *
 *   Friction where conviction is low. Acting past a diluted trigger requires an
 *   explicit acknowledgement naming the reason, and the order records that the
 *   user overrode it. We make our own action button harder to press when the
 *   signal is weak, which is against the usual engagement incentive and is the
 *   entire point.
 *
 *   The conviction snapshot. Every order is stamped with the thesis and the
 *   attribution showing at the moment it was placed, so a trade remembers why it
 *   was made. No broker does this, it costs one column, and it is the closing
 *   line of the demo.
 *
 * These orders move no money and every screen says so. Faking a convincing real
 * confirmation would be exactly the fabricated record the Responsible
 * commandment exists to prevent.
 */

export const NAV_CUTOFF_MIN = 15 * 60; // 3:00 pm IST

export type OrderStatus = 'FILLED' | 'PENDING_NEXT_NAV' | 'MARKET_CLOSED';

export type OrderError =
  | 'ITEM_NOT_FOUND'
  | 'ITEM_REMOVED'
  | 'NO_POSITION'
  | 'INSUFFICIENT_QUANTITY'
  | 'INVALID_QUANTITY'
  | 'INVALID_AMOUNT'
  | 'ACTION_NOT_AVAILABLE'
  | 'ACKNOWLEDGEMENT_REQUIRED';

export interface PlaceOrderInput {
  userId: string;
  itemId: string;
  side: 'BUY' | 'SELL';
  /** Shares, for a stock. */
  quantity?: number;
  /** Rupees, for a fund purchase. */
  amount?: number;
  /** The user has seen the conviction and chosen to proceed anyway. */
  acknowledgedLowConviction?: boolean;
  checkInQuestion?: string;
  checkInAnswer?: string;
  idempotencyKey: string;
  now?: number;
}

export interface Order {
  id: string;
  userId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number | null;
  amount: number | null;
  status: OrderStatus;
  thesisSnapshot: { type: string; params: unknown; line: string };
  convictionSnapshot: Record<string, unknown>;
  stateAtOrder: ItemState;
  acknowledgedLowConviction: boolean;
  checkInQuestion: string | null;
  checkInAnswer: string | null;
  placedAt: number;
  effectiveAt: number | null;
}

export type PlaceResult =
  | { ok: true; order: Order; replayed: boolean }
  | { ok: false; error: OrderError; detail?: string };

/**
 * A mutual fund order placed after 3:00 pm IST gets the NEXT day's NAV.
 *
 * Kept even though the equivalent stock rule was cut, because it is the more
 * interesting of the two timing rules and the one that shows real domain
 * knowledge. Getting it wrong is how a paper-trading demo stops being credible
 * to anyone who actually invests.
 *
 * A weekend is the same case as after the cutoff: there is no NAV today, so the
 * order takes the next published one. This used to be wrong in a way nobody
 * would have noticed in simulated mode, whose only day is a Friday: a fund BUY
 * at eleven on a Saturday reported FILLED and moved the paper position against
 * a NAV that does not exist.
 */
export function fundOrderStatus(now: number): OrderStatus {
  if (isWeekend(now)) return 'PENDING_NEXT_NAV';
  return istMinutesOfDay(now) < NAV_CUTOFF_MIN ? 'FILLED' : 'PENDING_NEXT_NAV';
}

export function positionOf(
  db: Database.Database,
  userId: string,
  symbol: string,
): { quantity: number; avgPrice: number } {
  const row = db
    .prepare('SELECT quantity, avg_price AS avgPrice FROM positions WHERE user_id = ? AND symbol = ?')
    .get(userId, symbol) as { quantity: number; avgPrice: number } | undefined;
  return row ?? { quantity: 0, avgPrice: 0 };
}

function hydrateOrder(row: Record<string, unknown>): Order {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    symbol: row.symbol as string,
    side: row.side as 'BUY' | 'SELL',
    quantity: row.quantity as number | null,
    amount: row.amount as number | null,
    status: row.status as OrderStatus,
    thesisSnapshot: JSON.parse(row.thesis_snapshot as string),
    convictionSnapshot: JSON.parse(row.conviction_snapshot as string),
    stateAtOrder: row.state_at_order as ItemState,
    acknowledgedLowConviction: (row.acknowledged_low_conviction as number) === 1,
    checkInQuestion: row.check_in_question as string | null,
    checkInAnswer: row.check_in_answer as string | null,
    placedAt: row.placed_at as number,
    effectiveAt: row.effective_at as number | null,
  };
}

export function getOrderByKey(
  db: Database.Database,
  userId: string,
  key: string,
): Order | null {
  const row = db
    .prepare('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?')
    .get(userId, key) as Record<string, unknown> | undefined;
  return row ? hydrateOrder(row) : null;
}

export function listOrders(db: Database.Database, userId: string, limit = 25): Order[] {
  const rows = db
    .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY placed_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit) as Array<Record<string, unknown>>;
  return rows.map(hydrateOrder);
}

export function placeOrder(db: Database.Database, input: PlaceOrderInput): PlaceResult {
  // A retry returns the original order rather than placing a second one. The
  // client supplies the key, so a double-tapped button or a retried request
  // cannot produce two trades.
  const existing = getOrderByKey(db, input.userId, input.idempotencyKey);
  if (existing) return { ok: true, order: existing, replayed: true };

  const item = getItem(db, input.itemId);
  if (!item) return { ok: false, error: 'ITEM_NOT_FOUND' };
  if (item.removedAt !== null) return { ok: false, error: 'ITEM_REMOVED' };

  const instrument = db
    .prepare('SELECT instrument_type AS type FROM instruments WHERE symbol = ?')
    .get(item.symbol) as { type: 'STOCK' | 'FUND' };

  const template = THESIS_TEMPLATES[item.thesisType];
  if (template.action !== 'NONE' && template.action !== input.side) {
    // The thesis determines the button. A card does not show a generic buy/sell
    // pair, so the API should not accept one either.
    return { ok: false, error: 'ACTION_NOT_AVAILABLE', detail: `thesis leads to ${template.action}` };
  }

  const now = input.now ?? Date.now();
  const conviction = computeConviction(db, item.symbol, now);

  // Acting past a diluted or confounded trigger requires the user to say so.
  // Enforced here rather than only in the UI, for the same reason as everything
  // else: the API is reachable without the button.
  const weak = conviction.band === 'LOW' || conviction.band === 'EXTREME' || conviction.band === 'UNKNOWN';
  if (weak && item.state === 'NEEDS_REVIEW' && !input.acknowledgedLowConviction) {
    return { ok: false, error: 'ACKNOWLEDGEMENT_REQUIRED', detail: conviction.explanation };
  }

  const position = positionOf(db, input.userId, item.symbol);
  const latest = db
    .prepare('SELECT price FROM price_events WHERE symbol = ? ORDER BY seq DESC LIMIT 1')
    .get(item.symbol) as { price: number } | undefined;
  const unitPrice = latest?.price ?? 0;

  let quantity: number | null = null;
  let amount: number | null = null;

  if (instrument.type === 'FUND' && input.side === 'BUY') {
    // Funds are bought by rupee amount, not by unit count.
    if (input.amount === undefined || !Number.isFinite(input.amount) || input.amount <= 0) {
      return { ok: false, error: 'INVALID_AMOUNT' };
    }
    amount = input.amount;
    quantity = unitPrice > 0 ? amount / unitPrice : null;
  } else {
    if (input.quantity === undefined || !Number.isFinite(input.quantity) || input.quantity <= 0) {
      return { ok: false, error: 'INVALID_QUANTITY' };
    }
    quantity = input.quantity;
    amount = unitPrice * quantity;
  }

  if (input.side === 'SELL') {
    // Validated against the stored position, never against what the UI claims.
    if (position.quantity <= 0) return { ok: false, error: 'NO_POSITION' };
    if ((quantity ?? 0) > position.quantity + 1e-9) {
      return {
        ok: false,
        error: 'INSUFFICIENT_QUANTITY',
        detail: `holding ${position.quantity}`,
      };
    }
  }

  const status: OrderStatus =
    instrument.type === 'FUND'
      ? fundOrderStatus(now)
      : isMarketOpen(now, fetchedSession(db))
        ? 'FILLED'
        : 'MARKET_CLOSED';

  const id = `or_${randomBytes(6).toString('hex')}`;
  const thesisSnapshot = {
    type: item.thesisType,
    // Rendered through the same function the card uses, so order history and the
    // card cannot disagree about how a thesis reads.
    line: phraseThesis(item.thesisType, item.params.threshold),
    params: item.params,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO orders
         (id, user_id, symbol, side, quantity, amount, status, thesis_snapshot,
          conviction_snapshot, state_at_order, acknowledged_low_conviction,
          check_in_question, check_in_answer, idempotency_key, placed_at, effective_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.userId,
      item.symbol,
      input.side,
      quantity,
      amount,
      status,
      JSON.stringify(thesisSnapshot),
      JSON.stringify(conviction),
      item.state,
      input.acknowledgedLowConviction ? 1 : 0,
      input.checkInQuestion ?? null,
      input.checkInAnswer ?? null,
      input.idempotencyKey,
      now,
      status === 'FILLED' ? now : null,
    );

    if (status === 'FILLED') applyToPosition(db, input.userId, item.symbol, input.side, quantity!, unitPrice);

    // A thesis the user has acted on stops firing. Without this, acting leaves
    // it triggering forever, which is a bug only visible once actions exist.
    db.prepare("UPDATE watchlist_items SET state = 'FULFILLED' WHERE id = ?").run(item.id);
    db.prepare(
      `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, at)
       VALUES (?, ?, 'FULFILLED', ?, ?, ?)`,
    ).run(
      item.id,
      item.state,
      `You placed a paper ${input.side.toLowerCase()} order. This thesis has stopped firing.`,
      JSON.stringify(conviction),
      now,
    );
    // The user's own action, so it does not raise an unread badge.
    const maxEvent = db.prepare('SELECT MAX(id) AS m FROM thesis_events').get() as {
      m: number | null;
    };
    db.prepare(
      `INSERT INTO read_state (item_id, last_seen_seq) VALUES (?, ?)
       ON CONFLICT (item_id) DO UPDATE SET last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq)`,
    ).run(item.id, maxEvent.m ?? 0);
  })();

  return { ok: true, order: getOrderByKey(db, input.userId, input.idempotencyKey)!, replayed: false };
}

function applyToPosition(
  db: Database.Database,
  userId: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  unitPrice: number,
): void {
  const current = positionOf(db, userId, symbol);

  if (side === 'BUY') {
    const total = current.quantity + quantity;
    const avg =
      total === 0 ? 0 : (current.quantity * current.avgPrice + quantity * unitPrice) / total;
    db.prepare(
      `INSERT INTO positions (user_id, symbol, quantity, avg_price) VALUES (?,?,?,?)
       ON CONFLICT (user_id, symbol) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price`,
    ).run(userId, symbol, total, avg);
    return;
  }

  const remaining = current.quantity - quantity;
  if (remaining <= 1e-9) {
    // Selling to zero closes the position and the card goes back to being a
    // plain watchlist card.
    db.prepare('DELETE FROM positions WHERE user_id = ? AND symbol = ?').run(userId, symbol);
    return;
  }
  db.prepare('UPDATE positions SET quantity = ? WHERE user_id = ? AND symbol = ?').run(
    remaining,
    userId,
    symbol,
  );
}

/** Puts a fulfilled thesis back to work. */
export function rearmThesis(
  db: Database.Database,
  itemId: string,
  now: number = Date.now(),
): boolean {
  const item = getItem(db, itemId);
  if (!item || item.state !== 'FULFILLED' || item.removedAt !== null) return false;
  db.prepare("UPDATE watchlist_items SET state = 'WATCHING' WHERE id = ?").run(itemId);
  db.prepare(
    `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, at)
     VALUES (?, 'FULFILLED', 'WATCHING', 'You re-armed this thesis.', '{}', ?)`,
  ).run(itemId, now);
  return true;
}
