import type Database from 'better-sqlite3';
import {
  THESIS_TEMPLATES,
  Z_UNEXPLAINED_MIN,
  type InstrumentType,
  type ItemState,
  type ThesisParams,
  type ThesisType,
} from '../domain/types';
import { computeConviction, priceFor, type ConvictionResult } from './conviction';
import { latestEvent, nthLatestEvent } from './ingest';

/**
 * The state machine.
 *
 * Five states, and the only interesting thing about it is what it refuses to do.
 * A met condition does NOT mean act: it means look, and conviction decides which
 * of those two the card says. Both tails of conviction route to review, because
 * too little instrument-specific movement means the trigger was reference noise
 * and too much means a shock the thesis never contemplated (D-019).
 *
 * Every transition carries a reason string generated alongside it, so the engine
 * cannot put a state on screen that it is unable to explain.
 */

/** Why a NEEDS_REVIEW card is in review. The alert policy needs this distinction. */
export type ReviewKind = 'DILUTED' | 'CONFOUNDED' | 'UNVERIFIABLE';

export interface Transition {
  itemId: string;
  symbol: string;
  instrumentType: InstrumentType;
  from: ItemState;
  to: ItemState;
  reason: string;
  review: ReviewKind | null;
  conviction: ConvictionResult;
  eventId: number;
}

/** The parts of a card needed to write a sentence about it. */
export interface Describable {
  symbol: string;
  thesisType: ThesisType;
  params: ThesisParams;
  instrumentType: InstrumentType;
}

interface EvaluableItem extends Describable {
  id: string;
  state: ItemState;
}

// -------------------------------------------------------------- the condition

/**
 * How far past the threshold a price must come BACK before the condition is
 * treated as no longer met. A quarter of a percent.
 */
export const HYSTERESIS = 0.0025;

/**
 * Mechanically there are only two conditions in this product, price-below and
 * price-above. Five templates are five rows of configuration over them (D-033).
 *
 * The condition is a Schmitt trigger rather than a plain comparison (D-087).
 * A price resting exactly on a threshold jitters across it on every tick, and a
 * bare comparison would fire, unfire and refire all day: eight state changes,
 * eight entries in your history, and eight chances to be interrupted about a
 * stock that has not really done anything. Arming is at the threshold; it
 * disarms only once the price has come back a quarter of a percent past it.
 *
 * Doing this in the CONDITION rather than in the alert policy matters. Debouncing
 * only the notification would leave the card itself flickering between states,
 * and the event log would still fill with transitions that describe noise.
 */
export function conditionMet(
  thesisType: ThesisType,
  params: ThesisParams,
  price: number,
  currentlyMet = false,
): boolean {
  const direction = THESIS_TEMPLATES[thesisType].direction;
  if (!direction || params.threshold === undefined) return false;
  const t = params.threshold;

  if (direction === 'BELOW') {
    return currentlyMet ? price <= t * (1 + HYSTERESIS) : price <= t;
  }
  return currentlyMet ? price >= t * (1 - HYSTERESIS) : price >= t;
}

/** A card is currently claiming its condition is met in exactly these states. */
export function stateImpliesMet(state: ItemState): boolean {
  return state === 'ACTIONABLE' || state === 'NEEDS_REVIEW';
}

// ------------------------------------------------------------------- wording

function money(x: number): string {
  return `₹${x.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** The review kind implied by a conviction band, used for live rendering. */
export function reviewKindFor(band: ConvictionResult['band']): ReviewKind | null {
  if (band === 'LOW') return 'DILUTED';
  if (band === 'EXTREME') return 'CONFOUNDED';
  if (band === 'UNKNOWN') return 'UNVERIFIABLE';
  return null;
}

/**
 * The reason string a card shows.
 *
 * These are the sentences the whole product exists to say, so they are built
 * from the template's own framing plus the live conviction explanation rather
 * than from a generic warning.
 *
 * Exported because a card renders this against the CURRENT numbers rather than
 * replaying what it said when it fired (D-082). A card frozen mid-slide would
 * sit under a market header reading -3.2% while insisting the market moved
 * -2.5%, which reads as a bug even though both numbers were true when written.
 * The event log still keeps the historical wording.
 */
export function reasonFor(
  to: ItemState,
  review: ReviewKind | null,
  item: Describable,
  conviction: ConvictionResult,
  price: number,
): string {
  const template = THESIS_TEMPLATES[item.thesisType];

  if (to === 'ACTIONABLE') {
    // A card the user pushed past must not start claiming high conviction just
    // because it is now actionable. The override is why it is here, and saying
    // otherwise would quietly launder a weak signal into a strong one.
    if (conviction.band !== 'HIGH') {
      return `You chose to act on this anyway. ${conviction.explanation}`;
    }
    return `Your trigger at ${money(item.params.threshold!)} was hit, and this really is about ${item.symbol}. ${conviction.explanation}`;
  }

  if (to === 'NEEDS_REVIEW') {
    if (review === 'DILUTED') {
      // The most valuable sentence in the product sits here, on the sell side:
      // "You would be selling the market, not exiting your thesis."
      const line =
        item.instrumentType === 'FUND' ? template.dilutedLineFund : template.dilutedLine;
      return `${line} ${conviction.explanation}`;
    }
    if (review === 'CONFOUNDED') {
      return `Your trigger was hit, but this is a shock rather than the drift your thesis assumed. ${conviction.explanation}`;
    }
    // UNVERIFIABLE. We are allowed to say we do not know, and when we do not
    // know we stay quiet rather than inventing a percentage.
    return `Your trigger at ${money(item.params.threshold!)} was hit. ${conviction.explanation}`;
  }

  if (to === 'UNEXPLAINED') {
    return `Nothing in your thesis covers this. ${conviction.explanation}`;
  }

  // Back to WATCHING.
  if (item.params.threshold !== undefined) {
    const direction = THESIS_TEMPLATES[item.thesisType].direction;
    const side = direction === 'BELOW' ? 'back above' : 'back below';
    return `${money(price)} is ${side} your trigger at ${money(item.params.threshold)}. Nothing to do.`;
  }
  return 'Moving normally again.';
}

// ------------------------------------------------------------- the transition

interface Target {
  state: ItemState;
  review: ReviewKind | null;
}

/**
 * Where an item should be, given its condition and its conviction. Pure, so the
 * whole table can be tested without a database.
 */
export function targetState(
  current: ItemState,
  met: boolean,
  band: ConvictionResult['band'],
  z: number | null,
): Target {
  // A thesis the user has acted on stops firing. Without this, acting on a
  // thesis leaves it triggering forever, which is a bug only visible once
  // actions exist.
  if (current === 'FULFILLED') return { state: 'FULFILLED', review: null };

  if (met) {
    if (band === 'HIGH') return { state: 'ACTIONABLE', review: null };
    if (band === 'LOW') return { state: 'NEEDS_REVIEW', review: 'DILUTED' };
    if (band === 'EXTREME') return { state: 'NEEDS_REVIEW', review: 'CONFOUNDED' };
    // UNKNOWN. The condition is genuinely met, but we cannot say whether the
    // move is about this instrument, so we must not say "act". Review is the
    // honest destination, and it does not alert.
    return { state: 'NEEDS_REVIEW', review: 'UNVERIFIABLE' };
  }

  if (z !== null && Math.abs(z) >= Z_UNEXPLAINED_MIN) {
    // Fires for every card including JUST_WATCHING, which is why the surprise
    // detector works for users who never declared anything.
    return { state: 'UNEXPLAINED', review: null };
  }

  // UNEXPLAINED is sticky until the user acknowledges it (D-077). A surprise
  // that quietly disappears before anyone looked at it has been swallowed, and
  // nothing in this product is allowed to be silently swallowed.
  if (current === 'UNEXPLAINED') return { state: 'UNEXPLAINED', review: null };

  return { state: 'WATCHING', review: null };
}

// ------------------------------------------------------------- the evaluation

function liveItemsOn(db: Database.Database, symbol: string, extraWhere = ''): EvaluableItem[] {
  const rows = db
    .prepare(
      `SELECT wi.id, wi.symbol, wi.state, wi.thesis_type AS thesisType,
              wi.thesis_params AS params, i.instrument_type AS instrumentType
         FROM watchlist_items wi
         JOIN instruments i ON i.symbol = wi.symbol
        WHERE wi.symbol = ? AND wi.removed_at IS NULL AND wi.state != 'FULFILLED' ${extraWhere}`,
    )
    .all(symbol) as Array<Omit<EvaluableItem, 'params'> & { params: string }>;
  return rows.map((r) => ({ ...r, params: JSON.parse(r.params) as ThesisParams }));
}

/**
 * Which items on this symbol could possibly have changed.
 *
 * This is where the scale answer lives (D-041). A threshold thesis can only
 * change state if its threshold lies between the previous price and the new one,
 * so the sorted index is range-queried for exactly the band the price crossed
 * rather than scanning every thesis on the symbol. Cards already out of
 * WATCHING are added because they can recover or lapse, and that set is small by
 * construction.
 *
 * The one case that genuinely needs everything is an extreme idiosyncratic move,
 * because UNEXPLAINED applies to cards with no threshold at all. That is rare,
 * and when it happens the work is real.
 */
function candidates(
  db: Database.Database,
  symbol: string,
  prevPrice: number,
  price: number,
  z: number | null,
): EvaluableItem[] {
  if (z !== null && Math.abs(z) >= Z_UNEXPLAINED_MIN) return liveItemsOn(db, symbol);

  const low = Math.min(prevPrice, price);
  const high = Math.max(prevPrice, price);
  const crossed = db
    .prepare(
      `SELECT item_id AS id FROM threshold_index
        WHERE symbol = ? AND threshold BETWEEN ? AND ?`,
    )
    .all(symbol, low, high) as Array<{ id: string }>;

  const ids = new Set(crossed.map((c) => c.id));
  for (const item of liveItemsOn(db, symbol, "AND wi.state != 'WATCHING'")) ids.add(item.id);
  if (ids.size === 0) return [];

  return liveItemsOn(db, symbol).filter((i) => ids.has(i.id));
}

function applyTransition(
  db: Database.Database,
  item: EvaluableItem,
  target: Target,
  conviction: ConvictionResult,
  price: number,
  now: number,
): Transition {
  const reason = reasonFor(target.state, target.review, item, conviction, price);
  const payload = JSON.stringify({ ...conviction, review: target.review });

  const priceEvent = latestEvent(db, item.symbol);
  const info = db
    .prepare(
      `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, price_event_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(item.id, item.state, target.state, reason, payload, priceEvent?.id ?? null, now);
  db.prepare('UPDATE watchlist_items SET state = ? WHERE id = ?').run(target.state, item.id);

  return {
    itemId: item.id,
    symbol: item.symbol,
    instrumentType: item.instrumentType,
    from: item.state,
    to: target.state,
    reason,
    review: target.review,
    conviction,
    eventId: Number(info.lastInsertRowid),
  };
}

/**
 * Evaluates every card on one symbol against the latest price.
 *
 * Conviction is computed ONCE here and shared by every card on the symbol,
 * which is the second-order saving that makes a hot symbol affordable: a
 * thousand crossings share one regression lookup, not a thousand.
 */
export function evaluateSymbol(db: Database.Database, symbol: string, now?: number): Transition[] {
  const instrument = db
    .prepare('SELECT instrument_type AS type FROM instruments WHERE symbol = ?')
    .get(symbol) as { type: string } | undefined;
  if (!instrument) return [];

  const current = priceFor(db, symbol);
  if (!current) return [];

  const conviction = computeConviction(db, symbol, now);

  // The freshness gate. A stale price still renders, because hiding the last
  // known price helps nobody, but it is never allowed to move a state. Being
  // type-aware is what stops this flagging every fund all day (D-025).
  if (conviction.stale) return [];

  const previous = nthLatestEvent(db, symbol, 1);
  const prevPrice = previous?.price ?? current.price;

  const at = now ?? (db.prepare('SELECT sim_now AS n FROM sim_state WHERE id = 1').get() as { n: number }).n;

  const transitions: Transition[] = [];
  for (const item of candidates(db, symbol, prevPrice, current.price, conviction.z)) {
    const met = conditionMet(
      item.thesisType,
      item.params,
      current.price,
      stateImpliesMet(item.state),
    );
    const target = targetState(item.state, met, conviction.band, conviction.z);
    // Only a real change is an event. Re-appending the same state on every tick
    // would turn the log into noise and the unread badge into a lie.
    if (target.state === item.state) continue;
    transitions.push(applyTransition(db, item, target, conviction, current.price, at));
  }
  return transitions;
}

/**
 * Evaluates one card on demand, ignoring the crossing band.
 *
 * Needed because the range query only ever finds thresholds the price has just
 * crossed, and a thesis added or edited BETWEEN price moves may already be met.
 * "Buy below 4000" set while the stock sits at 3700 would otherwise stay in
 * WATCHING until the price happened to cross 4000 from above, which it never
 * will. Doing this at add and edit time rather than widening the tick-time query
 * keeps the O(log n + k) property that the whole scale answer rests on (D-078).
 */
export function evaluateItem(db: Database.Database, itemId: string, now?: number): Transition | null {
  const item = loadItem(db, itemId);
  if (!item) return null;

  const current = priceFor(db, item.symbol);
  if (!current) return null;

  const conviction = computeConviction(db, item.symbol, now);
  if (conviction.stale) return null;

  const met = conditionMet(
    item.thesisType,
    item.params,
    current.price,
    stateImpliesMet(item.state),
  );
  const target = targetState(item.state, met, conviction.band, conviction.z);
  if (target.state === item.state) return null;

  const at = now ?? (db.prepare('SELECT sim_now AS n FROM sim_state WHERE id = 1').get() as { n: number }).n;
  return applyTransition(db, item, target, conviction, current.price, at);
}

/** Evaluates every symbol that somebody is actually watching. */
export function evaluateAll(db: Database.Database, now?: number): Transition[] {
  const symbols = db
    .prepare(
      `SELECT DISTINCT symbol FROM watchlist_items
        WHERE removed_at IS NULL AND state != 'FULFILLED'`,
    )
    .all() as Array<{ symbol: string }>;
  return symbols.flatMap((s) => evaluateSymbol(db, s.symbol, now));
}

// -------------------------------------------------------------- user actions

export type AckError = 'NOT_FOUND' | 'NOT_REVIEWABLE';

/**
 * The user has looked at a card that was asking for attention.
 *
 * From review, acknowledging means "I have seen the conviction and I still want
 * to act", so the card becomes ACTIONABLE. From UNEXPLAINED it means "noted",
 * and the card goes quiet.
 */
function loadItem(db: Database.Database, itemId: string): EvaluableItem | null {
  const row = db
    .prepare(
      `SELECT wi.id, wi.symbol, wi.state, wi.thesis_type AS thesisType,
              wi.thesis_params AS params, i.instrument_type AS instrumentType
         FROM watchlist_items wi
         JOIN instruments i ON i.symbol = wi.symbol
        WHERE wi.id = ? AND wi.removed_at IS NULL`,
    )
    .get(itemId) as (Omit<EvaluableItem, 'params'> & { params: string }) | undefined;
  if (!row) return null;
  return { ...row, params: JSON.parse(row.params) as ThesisParams };
}

export function acknowledge(
  db: Database.Database,
  itemId: string,
  now: number = Date.now(),
): { ok: true; transition: Transition } | { ok: false; error: AckError } {
  const item = loadItem(db, itemId);
  if (!item) return { ok: false, error: 'NOT_FOUND' };
  if (item.state !== 'NEEDS_REVIEW' && item.state !== 'UNEXPLAINED') {
    return { ok: false, error: 'NOT_REVIEWABLE' };
  }

  const to: ItemState = item.state === 'NEEDS_REVIEW' ? 'ACTIONABLE' : 'WATCHING';
  const conviction = computeConviction(db, item.symbol, now);
  const reason =
    to === 'ACTIONABLE'
      ? 'You reviewed the conviction and chose to go ahead.'
      : 'You have seen this. Back to watching.';

  const priceEvent = latestEvent(db, item.symbol);
  const info = db
    .prepare(
      `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, price_event_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(item.id, item.state, to, reason, JSON.stringify(conviction), priceEvent?.id ?? null, now);
  db.prepare('UPDATE watchlist_items SET state = ? WHERE id = ?').run(to, item.id);

  return {
    ok: true,
    transition: {
      itemId: item.id,
      symbol: item.symbol,
      instrumentType: item.instrumentType,
      from: item.state,
      to,
      reason,
      review: null,
      conviction,
      eventId: Number(info.lastInsertRowid),
    },
  };
}
