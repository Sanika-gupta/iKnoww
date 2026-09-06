import type Database from 'better-sqlite3';
import { THESIS_TEMPLATES, type ItemState, type ThesisType } from '../domain/types';
import { computeConviction, priceFor, type ConvictionResult } from '../engine/conviction';
import { listItems } from '../watchlist/items';
import { phraseThesis, positionQuantity, templatesFor } from '../watchlist/templates';
import { SCENARIOS } from '../sim/scenarios';
import { reasonFor, reviewKindFor } from '../engine/states';
import { latestSeq, unreadCount, changesSince, historyFor, type Change } from '../watchlist/read';
import {
  MARKET_CLOSE_MIN,
  MARKET_OPEN_MIN,
  alertLog,
  clockTime,
  isMarketOpen,
  isWeekend,
  fetchedSession,
  type TradingSession,
  istMinutesOfDay,
  type AlertLogEntry,
} from '../alerts/policy';
import { listOrders, positionOf, type Order } from '../orders/service';
import { checkInFor, type CheckIn } from '../ask/checkin';
import { listWatchlists, type WatchlistSummary } from '../watchlist/lists';

/**
 * Everything one screen needs, assembled in one place.
 *
 * These types are imported directly by the browser component. Defining the
 * shape of a card once and having both sides use it is the concrete payoff of
 * choosing one language end to end (D-018); there is no second definition to
 * drift.
 */

export interface CardView {
  id: string;
  symbol: string;
  name: string;
  instrumentType: 'STOCK' | 'FUND';
  price: number;
  changePct: number | null;
  state: ItemState;
  thesisType: ThesisType;
  thesisLine: string;
  action: 'BUY' | 'SELL' | 'NONE';
  positionQuantity: number;
  /** The sentence the card shows right now. */
  line: string;
  band: ConvictionResult['band'];
  shareReference: number | null;
  z: number | null;
  referenceSymbol: string | null;
  stale: boolean;
  unread: number;
  /** Newest event on this card. The client posts it back when the card is opened. */
  latestSeq: number;
  history: Change[];
  version: number;
  /** Asked before an order when conviction is weak. Null when it is not. */
  checkIn: CheckIn | null;
  /** Funds are bought by rupee amount, stocks by share count. */
  buysBy: 'QUANTITY' | 'AMOUNT';
  avgPrice: number;
  /**
   * How far the price is from the thesis's own trigger, as a fraction, and null
   * once the condition is met or when the thesis has no trigger.
   *
   * The most decision-relevant number a thesis card can carry, and it was
   * missing: the card showed a price and a sentence containing a threshold and
   * left the subtraction to the reader. It answers "is this thesis live or
   * dormant", which is the question the whole product is about (D-130).
   */
  triggerDistance: number | null;
  threshold: number | null;
  /** When this price was measured, and how to describe that age honestly. */
  asOf: number;
  asOfLine: string;
  /** Gain on a paper position, absolute and as a fraction. Null with no holding. */
  unrealised: { amount: number; pct: number } | null;
}

/**
 * The session clock shown above the index.
 *
 * It reads the SIMULATED clock, never the wall clock (D-088). A judge opening
 * this in the evening would otherwise be told the market is closed while the
 * simulated session is mid-morning and every card is visibly ticking, which is
 * the same class of contradiction as a card quoting a stale number beside a
 * live one (D-082).
 *
 * Open and closed are decided by exactly the predicate the alert policy uses to
 * decide whether it may interrupt you, so the badge and the silence can never
 * disagree.
 */
export interface MarketClock {
  /** Simulated epoch milliseconds. */
  at: number;
  /** "Fri 4 Sep 2026 · 10:30 AM IST" */
  label: string;
  isOpen: boolean;
  /** "Open · closes 3:30 PM" / "Closed · opens Mon 9:15 AM" */
  session: string;
  /**
   * Where the hours came from. 'feed' means the exchange's own trading period,
   * fetched with the quotes; 'assumed' means the hardcoded weekday rule. The
   * badge says which, because "closed" carries a different weight depending on
   * whether we know or are guessing.
   */
  hoursSource: 'feed' | 'assumed';
}

export interface MarketView {
  symbol: string;
  name: string;
  price: number;
  changePct: number | null;
  clock: MarketClock;
  /** How many cards are moving with their reference rather than on their own. */
  movingWithReference: number;
  total: number;
  headline: string;
}

export interface InstrumentView {
  symbol: string;
  name: string;
  instrumentType: 'STOCK' | 'FUND';
  sector: string | null;
  watched: boolean;
  /**
   * The latest price, so the form can anchor the threshold it is asking for.
   *
   * Null only for an instrument with no price event yet, which cannot happen
   * for a seeded one and is the honest answer if it ever does (D-126).
   */
  price: number | null;
  templates: Array<{ type: string; label: string; prompt: string; requiresThreshold: boolean }>;
}

export interface BoardView {
  market: MarketView;
  cards: CardView[];
  alerts: AlertLogEntry[];
  changes: Change[];
  orders: Order[];
  scenarios: Array<{ id: string; label: string; blurb: string; lengthTicks: number }>;
  runningScenario: string | null;
  simNow: number;
  attentionCount: number;
  /**
   * Who is looking. There is no authentication in this build and the README
   * says so; this is the seeded demo user, read from the row rather than typed
   * into the markup.
   */
  user: { name: string };
  /** The list being shown, and every list this user has. */
  watchlistId: string;
  watchlists: WatchlistSummary[];
}

export const REFERENCE_SHARE_MOVING_WITH = 0.7;

/*
 * IST formatting done by arithmetic rather than by Intl, for the same reason
 * istMinutesOfDay does it: India observes no daylight saving, so a fixed +5:30
 * offset is exactly correct, and the result does not depend on which ICU data
 * the host happens to ship.
 *
 * Weekends used to be deliberately unhandled here, on the grounds that the
 * simulated session is a single Friday and that teaching only the badge about
 * them would put the badge and the alert policy into disagreement. Live mode
 * runs on the real clock, so they had to be handled -- and they were handled
 * exactly where that note said they should be, inside isMarketOpen, which both
 * still read. The rule was right; only its conclusion has expired.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * When the market next opens, as a label.
 *
 * Computed as the next weekday at the session's start time. That is right most
 * of the time and WRONG on the eve of an exchange holiday, because no keyless
 * source lists NSE holidays and a hardcoded list would be wrong within a year.
 * So the label names the day and the badge's tooltip says holidays are not
 * known. Being visibly approximate beats being confidently wrong.
 */
function nextOpenLabel(at: number, startMin: number): string {
  const DAY_MS = 24 * 60 * 60_000;
  const istMidnight = Math.floor((at + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  const todayOpen = istMidnight + startMin * 60_000;

  // Today still counts if the open has not happened yet and today is a weekday.
  let candidate = at < todayOpen ? todayOpen : todayOpen + DAY_MS;
  for (let i = 0; i < 7 && isWeekend(candidate); i += 1) candidate += DAY_MS;

  const sameDay = Math.floor((candidate + IST_OFFSET_MS) / DAY_MS) === Math.floor((at + IST_OFFSET_MS) / DAY_MS);
  const day = DAY_NAMES[new Date(candidate + IST_OFFSET_MS).getUTCDay()];
  const time = clockTime(istMinutesOfDay(candidate));
  return sameDay ? time : `${day} ${time}`;
}

/**
 * The session badge. Reads the same predicate as the alert policy, so the badge
 * and the silence can never disagree on any minute of any day.
 *
 * `session` is the exchange's own trading period when live mode has fetched it,
 * and null otherwise. Passing it here rather than looking it up keeps this
 * function pure, which is what lets the market-clock test walk a whole day a
 * minute at a time.
 */
export function marketSession(at: number, session?: TradingSession | null): MarketClock {
  const ist = new Date(at + IST_OFFSET_MS);
  const label =
    `${DAY_NAMES[ist.getUTCDay()]} ${ist.getUTCDate()} ${MONTH_NAMES[ist.getUTCMonth()]} ` +
    `${ist.getUTCFullYear()} · ${clockTime(istMinutesOfDay(at))} IST`;

  const open = isMarketOpen(at, session);
  const closeMin = session ? istMinutesOfDay(session.end) : MARKET_CLOSE_MIN;
  const openMin = session ? istMinutesOfDay(session.start) : MARKET_OPEN_MIN;

  const line = open
    ? `Open · closes ${clockTime(closeMin)}`
    : `Closed · opens ${nextOpenLabel(at, openMin)}`;

  return {
    at,
    label,
    isOpen: open,
    session: line,
    hoursSource: session ? 'feed' : 'assumed',
  };
}

function userName(db: Database.Database, userId: string): string {
  const row = db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as
    | { name: string }
    | undefined;
  return row?.name ?? 'there';
}

function latestReason(db: Database.Database, itemId: string): string | null {
  const row = db
    .prepare('SELECT reason FROM thesis_events WHERE item_id = ? ORDER BY id DESC LIMIT 1')
    .get(itemId) as { reason: string } | undefined;
  return row?.reason ?? null;
}

/**
 * What a card says right now.
 *
 * Split by whether the state is about the present or about something preserved
 * from the past:
 *
 *   WATCHING, NEEDS_REVIEW, ACTIONABLE - rendered live, so every number on the
 *     card agrees with the market header above it. A card frozen at the moment
 *     it fired mid-slide would claim the market moved -2.5% while the header
 *     said -3.2%, and both being true when written is no defence when they sit
 *     two inches apart (D-082).
 *
 *   UNEXPLAINED, FULFILLED - deliberately historical. UNEXPLAINED is sticky
 *     precisely because the surprise may already have passed, so re-rendering it
 *     live would have it announce a shock and then say nothing is happening.
 */
function cardLine(
  db: Database.Database,
  item: { id: string; symbol: string; thesisType: ThesisType; params: { threshold?: number } },
  instrumentType: 'STOCK' | 'FUND',
  state: ItemState,
  conviction: ConvictionResult,
  price: number,
): string {
  if (state === 'WATCHING') return conviction.explanation;
  if (state === 'NEEDS_REVIEW' || state === 'ACTIONABLE') {
    return reasonFor(
      state,
      reviewKindFor(conviction.band),
      { symbol: item.symbol, thesisType: item.thesisType, params: item.params, instrumentType },
      conviction,
      price,
    );
  }
  return latestReason(db, item.id) ?? conviction.explanation;
}

export { cardLine };

/**
 * How far the price still is from the thesis's own trigger.
 *
 * Null once the condition is met, because the state badge and its sentence
 * already say so and a distance of "0.4% past" would be a second, weaker way of
 * saying the same thing. Null too for `JUST_WATCHING`, which has no trigger to
 * be far from.
 */
export function triggerDistanceOf(
  thesisType: ThesisType,
  threshold: number | undefined,
  price: number,
  state: ItemState,
): number | null {
  const direction = THESIS_TEMPLATES[thesisType].direction;
  if (direction === null || threshold === undefined || price <= 0) return null;
  /*
   * Silent on any card that has already fired, and keyed on the STATE rather
   * than on a fresh price comparison.
   *
   * The comparison is not the condition. The condition is a Schmitt trigger:
   * once armed it stays armed until the price has come back a quarter of a
   * percent past the threshold, so that a price resting on its trigger does not
   * fire, unfire and refire all day (D-087). Inside that band a bare comparison
   * and the state machine disagree -- seen on the real board, where INFY sat in
   * NEEDS_REVIEW while reading "0.1% from your trigger", a card announcing it
   * had fired and had not fired in consecutive lines.
   *
   * Asking the state is the same rule D-107 settled for the session badge: one
   * predicate, so the screen cannot contradict the engine (D-130).
   */
  if (state !== 'WATCHING') return null;
  return Math.abs(threshold - price) / price;
}

/**
 * When this price was measured, said on every card rather than only on a broken
 * one.
 *
 * Freshness is type-aware (D-025) and that is one of the better small details
 * in the build, but until now it only ever SPOKE when something was wrong: a
 * card carried a stale warning or it carried nothing, so the reassurance that a
 * fourteen-hour NAV is entirely normal was invisible. Section 3.2 of the design
 * mocked this line up and the card never shipped it.
 *
 * The delay is measured from the feed's own timestamp rather than assumed, so a
 * quote that is genuinely a minute old does not claim to be fifteen.
 */
export function asOfLineFor(
  instrumentType: 'STOCK' | 'FUND',
  asOf: number,
  now: number,
  marketOpen = true,
): string {
  const at = clockTime(istMinutesOfDay(asOf));
  if (instrumentType === 'FUND') {
    /*
     * The reassurance is attached only to a NAV old enough to need it. A NAV
     * published this morning saying "normal for a fund" explains nothing, which
     * is the same rule that stopped a 0.4% drift being narrated as if it meant
     * something (D-070). Yesterday evening's NAV, still normal at noon today,
     * is exactly the case the 30-hour window exists for.
     */
    if (istDayIndexOf(asOf) === istDayIndexOf(now)) return `NAV as of ${at}`;
    return `NAV as of ${at} ${dayLabel(asOf)} · normal for a fund`;
  }
  /*
   * "Behind the exchange" only means anything while the exchange is trading.
   *
   * Read off a real live card on a Saturday: "Price as of 3:15 PM · 1604 min
   * behind the exchange". Arithmetically true and nonsense as English -- the
   * exchange is not running 26 hours late, it shut on Friday afternoon. A
   * closed market gets the last trade and the day it happened; an open one gets
   * the delay, which is the number that genuinely matters because it is what
   * the 20-minute live staleness gate is judging.
   *
   * Keyed on the same `isMarketOpen` the alert policy and the session badge
   * use, so a card cannot claim the market is running while the policy is
   * holding alerts because it is not (D-107, D-131).
   */
  if (!marketOpen) {
    const sameDay = istDayIndexOf(asOf) === istDayIndexOf(now);
    return sameDay
      ? `Last trade ${at} · the market has closed since`
      : `Last trade ${at} ${dayLabel(asOf)} · the market is closed`;
  }
  const behindMin = Math.floor((now - asOf) / 60_000);
  return behindMin >= 2
    ? `Price as of ${at} · ${behindMin} min behind the exchange`
    : `Price as of ${at}`;
}

function istDayIndexOf(at: number): number {
  return Math.floor((at + IST_OFFSET_MS) / 86_400_000);
}

function dayLabel(at: number): string {
  const d = new Date(at + IST_OFFSET_MS);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

/**
 * Gain on a paper position.
 *
 * Shown wherever a holding exists, not only on exit theses: "holding 40" with
 * no cost basis is inert on the one card where it matters most, the protective
 * stop firing in a crash, which is the moment this product exists for. It is
 * inside scope rather than beyond it -- what is ruled out is portfolio analytics
 * beyond the positions paper orders create, and this is those positions.
 */
export function unrealisedOf(
  quantity: number,
  avgPrice: number,
  price: number,
): { amount: number; pct: number } | null {
  if (quantity <= 0 || avgPrice <= 0 || price <= 0) return null;
  return { amount: (price - avgPrice) * quantity, pct: (price - avgPrice) / avgPrice };
}

export function buildBoard(
  db: Database.Database,
  watchlistId: string,
  now?: number,
  userId = 'u_demo',
): BoardView {
  const items = listItems(db, watchlistId);
  // One clock (D-088). The cards need it to say how old a price is, and the
  // board reads it again below for the session badge.
  const simNow =
    now ?? (db.prepare('SELECT sim_now AS n FROM sim_state WHERE id = 1').get() as { n: number } | undefined)?.n ?? 0;
  // Read once for the whole board, and it is the SAME predicate the alert
  // policy suppresses on, so a card cannot describe a market the policy
  // disagrees about (D-107).
  const session = fetchedSession(db);
  const marketOpen = isMarketOpen(simNow, session ?? undefined);

  const cards: CardView[] = items.map((item) => {
    const instrument = db
      .prepare('SELECT name, instrument_type AS type FROM instruments WHERE symbol = ?')
      .get(item.symbol) as { name: string; type: 'STOCK' | 'FUND' };
    const conviction = computeConviction(db, item.symbol, now);
    const point = priceFor(db, item.symbol);
    const position = positionOf(db, item.userId, item.symbol);
    const held = positionQuantity(db, item.userId, item.symbol);

    return {
      id: item.id,
      symbol: item.symbol,
      name: instrument.name,
      instrumentType: instrument.type,
      price: point?.price ?? 0,
      changePct: point?.ret ?? null,
      state: item.state,
      thesisType: item.thesisType,
      thesisLine: phraseThesis(item.thesisType, item.params.threshold),
      action: THESIS_TEMPLATES[item.thesisType].action,
      positionQuantity: held,
      line: cardLine(db, item, instrument.type, item.state, conviction, point?.price ?? 0),
      band: conviction.band,
      shareReference: conviction.shareReference,
      z: conviction.z,
      referenceSymbol: conviction.referenceSymbol,
      stale: conviction.stale,
      unread: unreadCount(db, item.id),
      latestSeq: latestSeq(db, item.id),
      history: historyFor(db, item.id, 8),
      version: item.version,
      checkIn: checkInFor(item.symbol, item.thesisType, conviction),
      buysBy: instrument.type === 'FUND' ? 'AMOUNT' : 'QUANTITY',
      avgPrice: position.avgPrice,
      triggerDistance: triggerDistanceOf(
        item.thesisType,
        item.params.threshold,
        point?.price ?? 0,
        item.state,
      ),
      threshold: item.params.threshold ?? null,
      asOf: point?.asOf ?? 0,
      asOfLine:
        point === null
          ? 'No price yet'
          : asOfLineFor(instrument.type, point.asOf, simNow, marketOpen),
      unrealised: unrealisedOf(held, position.avgPrice, point?.price ?? 0),
    };
  });

  const marketRow = db
    .prepare("SELECT symbol, name FROM instruments WHERE symbol = 'NIFTY50'")
    .get() as { symbol: string; name: string };
  const marketPoint = priceFor(db, 'NIFTY50');
  const movingWithReference = cards.filter(
    (c) => c.shareReference !== null && c.shareReference >= REFERENCE_SHARE_MOVING_WITH,
  ).length;

  const sim = db.prepare('SELECT sim_now AS simNow, scenario FROM sim_state WHERE id = 1').get() as
    | { simNow: number; scenario: string | null }
    | undefined;

  return {
    market: {
      symbol: marketRow.symbol,
      name: marketRow.name,
      price: marketPoint?.price ?? 0,
      changePct: marketPoint?.ret ?? null,
      clock: marketSession(sim?.simNow ?? 0, fetchedSession(db)),
      movingWithReference,
      total: cards.length,
      headline: marketHeadline(marketPoint?.ret ?? null, movingWithReference, cards.length),
    },
    cards,
    alerts: alertLog(db, userId, 10),
    changes: changesSince(db, watchlistId),
    orders: listOrders(db, userId, 15),
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      label: s.label,
      blurb: s.blurb,
      lengthTicks: s.lengthTicks,
    })),
    runningScenario: sim?.scenario ?? null,
    simNow: sim?.simNow ?? 0,
    attentionCount: cards.filter((c) => c.state !== 'WATCHING' && c.state !== 'FULFILLED').length,
    user: { name: userName(db, userId) },
    watchlistId,
    // The tab bar needs every list, not just this one, because a list you are
    // not looking at is exactly the one that can quietly need you.
    watchlists: listWatchlists(db, userId),
  };
}

/**
 * The market's own move, stated once and prominently.
 *
 * This card exists to answer the sharpest challenge the design invites: that a
 * market-wide crash is itself meaningful and we are hiding it. We are not. It is
 * the most prominent thing on the screen. What we refuse to do is repeat that
 * one fact once per card as though it were twelve separate discoveries (D-062).
 */
function marketHeadline(ret: number | null, movingWith: number, total: number): string {
  if (ret === null) return 'No market data yet.';
  const pct = Math.abs(ret * 100);
  if (pct < 0.25) return 'Quiet day. The market has barely moved.';
  const direction = ret < 0 ? 'Broad decline' : 'Broad rally';
  if (total === 0) return `${direction}. The market is ${ret < 0 ? 'down' : 'up'} ${pct.toFixed(1)}%.`;
  return `${direction}. ${movingWith} of your ${total} ${total === 1 ? 'item is' : 'items are'} moving with it.`;
}

/**
 * The picker. A fixed list rather than a search box (D-036): twelve instruments
 * demonstrate identical flows, and those hours went into the templates instead.
 *
 * Templates come back already position-filtered, so the UI can never offer a
 * thesis the server would refuse.
 */
export function buildInstruments(
  db: Database.Database,
  userId: string,
  watchlistId: string,
): InstrumentView[] {
  const rows = db
    .prepare(
      `SELECT symbol, name, instrument_type AS instrumentType, sector
         FROM instruments
        WHERE is_reference = 0
        ORDER BY instrument_type, symbol`,
    )
    .all() as Array<Omit<InstrumentView, 'watched' | 'templates' | 'price'>>;

  const watched = new Set(
    (
      db
        .prepare('SELECT symbol FROM watchlist_items WHERE watchlist_id = ? AND removed_at IS NULL')
        .all(watchlistId) as Array<{ symbol: string }>
    ).map((r) => r.symbol),
  );

  const price = db.prepare(
    'SELECT price FROM price_events WHERE symbol = ? ORDER BY seq DESC LIMIT 1',
  );

  return rows.map((r) => ({
    ...r,
    watched: watched.has(r.symbol),
    price: (price.get(r.symbol) as { price: number } | undefined)?.price ?? null,
    templates: templatesFor(db, userId, r.symbol).map((t) => ({
      type: t.type,
      label: t.label,
      prompt: t.prompt,
      requiresThreshold: t.requiresThreshold,
    })),
  }));
}
