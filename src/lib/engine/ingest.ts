import type Database from 'better-sqlite3';

/**
 * The boundary between a price feed and the store.
 *
 * Everything here is written to run unchanged against a real feed. A feed
 * redelivers, reorders and corrects itself, and the guards below are the reason
 * none of that can move a card the wrong way.
 *
 * The rule worth defending: `seq` is a per-symbol monotonic event counter that
 * belongs to the FEED, not to our simulator's tick loop. It started life as the
 * tick number, which was convenient until corrections needed a sequence of their
 * own and ended up at `tick + 100000`, which silently made every later tick look
 * out-of-order. Separating the two is what makes the ordering rule mean anything
 * (D-072).
 */

export type IngestOutcome =
  | 'ACCEPTED'
  | 'DUPLICATE'
  | 'OUT_OF_ORDER'
  | 'UNKNOWN_SYMBOL'
  | 'INVALID_PRICE'
  | 'CORRECTION_TARGET_MISSING';

export interface IngestResult {
  outcome: IngestOutcome;
  /** The row written, when one was. */
  eventId?: number;
  /** Present on OUT_OF_ORDER, so a caller can log how far behind the tick was. */
  highWaterSeq?: number;
}

export interface PriceTick {
  symbol: string;
  seq: number;
  price: number;
  /** When the price was measured, not when we received it. */
  asOf: number;
}

/** Highest sequence number seen for a symbol. -1 when the symbol has never ticked. */
export function highWaterSeq(db: Database.Database, symbol: string): number {
  const row = db.prepare('SELECT MAX(seq) AS s FROM price_events WHERE symbol = ?').get(symbol) as {
    s: number | null;
  };
  return row.s ?? -1;
}

/** The sequence number a new event for this symbol should carry. */
export function nextSeq(db: Database.Database, symbol: string): number {
  return highWaterSeq(db, symbol) + 1;
}

function isKnownSymbol(db: Database.Database, symbol: string): boolean {
  return (
    db.prepare('SELECT 1 FROM instruments WHERE symbol = ?').get(symbol) !== undefined
  );
}

function isUsablePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

/**
 * Accepts one price event, or explains precisely why it did not.
 *
 * A redelivery of a sequence number we already hold is a DUPLICATE even when the
 * price differs. That is deliberate: if a feed wants to change a price it has
 * already published, that is a correction and must arrive as one, carrying the
 * event it supersedes. Silently overwriting on a second delivery would destroy
 * the only history we have, and the alert retraction in Section 5.6 depends on
 * that history surviving.
 */
export function ingestPrice(db: Database.Database, tick: PriceTick): IngestResult {
  if (!isKnownSymbol(db, tick.symbol)) return { outcome: 'UNKNOWN_SYMBOL' };
  if (!isUsablePrice(tick.price)) return { outcome: 'INVALID_PRICE' };

  const existing = db
    .prepare('SELECT id FROM price_events WHERE symbol = ? AND seq = ?')
    .get(tick.symbol, tick.seq) as { id: number } | undefined;
  if (existing) return { outcome: 'DUPLICATE', eventId: existing.id };

  const high = highWaterSeq(db, tick.symbol);
  if (tick.seq < high) return { outcome: 'OUT_OF_ORDER', highWaterSeq: high };

  const info = db
    .prepare(
      `INSERT INTO price_events (symbol, seq, price, as_of, ingested_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(tick.symbol, tick.seq, tick.price, tick.asOf, Date.now());

  return { outcome: 'ACCEPTED', eventId: Number(info.lastInsertRowid) };
}

export interface Correction {
  symbol: string;
  /** The price_events row this supersedes. */
  correctsEventId: number;
  price: number;
  asOf: number;
}

/**
 * A correction is appended, never applied in place. The bad print stays in the
 * log with a later event pointing at it, which is what lets an incorrect state
 * be rolled back and an incorrect alert be retracted rather than quietly dropped.
 *
 * Corrections are exempt from the ordering rule, because a correction is by
 * definition about the past. It still takes the next sequence number, so it is
 * unambiguously the newest thing we know.
 */
export function ingestCorrection(db: Database.Database, c: Correction): IngestResult {
  if (!isKnownSymbol(db, c.symbol)) return { outcome: 'UNKNOWN_SYMBOL' };
  if (!isUsablePrice(c.price)) return { outcome: 'INVALID_PRICE' };

  const target = db
    .prepare('SELECT id FROM price_events WHERE id = ? AND symbol = ?')
    .get(c.correctsEventId, c.symbol) as { id: number } | undefined;
  if (!target) return { outcome: 'CORRECTION_TARGET_MISSING' };

  const info = db
    .prepare(
      `INSERT INTO price_events (symbol, seq, price, as_of, ingested_at, corrects_event_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(c.symbol, nextSeq(db, c.symbol), c.price, c.asOf, Date.now(), c.correctsEventId);

  return { outcome: 'ACCEPTED', eventId: Number(info.lastInsertRowid) };
}

/**
 * The event a card is priced from: the newest row by sequence, corrections
 * INCLUDED. It has to agree with currentPrice, because a transition stamped
 * with an event other than the one it was computed from is a causal lie in an
 * append-only log — and the one place that bites is exactly here, where a
 * correction rolls a card back and the rollback would otherwise be attributed
 * to the very print it undoes (D-110).
 */
export function latestEvent(
  db: Database.Database,
  symbol: string,
): { id: number; price: number; seq: number } | null {
  const row = db
    .prepare(
      'SELECT id, price, seq FROM price_events WHERE symbol = ? ORDER BY seq DESC LIMIT 1',
    )
    .get(symbol) as { id: number; price: number; seq: number } | undefined;
  return row ?? null;
}

/**
 * The nth-most-recent ordinary event for a symbol, 0 being the latest.
 * Corrections are skipped, because "the price three updates ago" means three
 * real prints ago, not three log rows ago.
 */
export function nthLatestEvent(
  db: Database.Database,
  symbol: string,
  n: number,
): { id: number; price: number; seq: number } | null {
  const row = db
    .prepare(
      `SELECT id, price, seq FROM price_events
        WHERE symbol = ? AND corrects_event_id IS NULL
        ORDER BY seq DESC LIMIT 1 OFFSET ?`,
    )
    .get(symbol, n) as { id: number; price: number; seq: number } | undefined;
  return row ?? null;
}
