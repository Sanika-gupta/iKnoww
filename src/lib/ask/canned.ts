import type Database from 'better-sqlite3';
import { computeConviction, priceFor } from '../engine/conviction';
import { fetchedSession, isMarketOpen, istDayOfWeek } from '../alerts/policy';
import { REFERENCE_SHARE_MOVING_WITH, triggerDistanceOf } from '../api/board';
import { ensureInstrument, indexQuote, quoteFor } from '../feed/instruments';
import { MIN_USABLE_BARS, backfillSymbol } from '../feed/backfill';
import { saveStatsForSymbol } from '../engine/stats';
import { FeedError, type SearchHit } from '../feed/client';
import { knownReferenceFor } from '../feed/symbols';
import { simNow } from '../sim/ticker';
import type { ItemState, ThesisType } from '../domain/types';
import {
  DISCLOSURE,
  buildContext,
  catchUpResponse,
  explainCard,
  refusalResponse,
  type AskResponse,
  type ResponseContext,
} from './service';

/**
 * Ask, in the live feed: pick an instrument, pick a question (D-133).
 *
 * There is no text box here and no parser. Both existed for simulated mode,
 * where the universe is twelve seeded names and a sentence like "watch SBIN,
 * buy below 700" can be resolved. In the live feed the universe is whatever
 * you have added, so the parser could never name anything new, and free text
 * was the one surface where a question could arrive that nothing below had an
 * answer for. A picker and seven fixed questions remove both: every question
 * has exactly one template, every template is filled from numbers the app
 * fetched or computed, and there is no eighth question by construction.
 *
 * That makes this MORE deterministic than the simulated panel, not less, and
 * it is the same principle: a hallucination rate of zero, stated on every
 * answer (D-048).
 *
 * The questions are judgement questions -- what the app thinks, not what the
 * feed reports. Volume, market cap, day range and P/E are deliberately absent,
 * for the reason the card refuses them (D-130): each is true and none is
 * actionable, and a panel that served them would be a quote lookup with a
 * chat skin, contradicting the product in writing.
 */

export {
  QUESTIONS,
  questionsFor,
  type AskSubject,
  type CannedQuestion,
  type QuestionId,
  type SubjectKind,
} from './questions';
import { QUESTIONS, type AskSubject, type QuestionId, type SubjectKind } from './questions';

/**
 * Everything a template may read about the picked instrument.
 *
 * Every field that is a number is a number, never a formatted string: the
 * no-fabricated-numbers test walks this object and admits only figures it
 * finds here, so a template can state a value exactly when the context holds
 * it and not otherwise (D-045, third guardrail).
 */
export interface SubjectContext {
  symbol: string;
  name: string;
  kind: SubjectKind;
  watched: boolean;
  cardId: string | null;
  price: number;
  asOf: number;
  /** Minutes between the feed's stamp and the clock. Meaningful only while trading. */
  delayMinutes: number;
  marketOpen: boolean;
  high52: number | null;
  low52: number | null;
  band: string | null;
  z: number | null;
  shareReference: number | null;
  referenceSymbol: string | null;
  referenceReturn: number | null;
  instrumentReturn: number | null;
  beta: number | null;
  observations: number;
  explanation: string | null;
  threshold: number | null;
  triggerDistance: number | null;
  /** The clock this answer was built against, so a template can compare days. */
  now: number;
  /** Index only: the move since the open, and how many cards move with it. */
  changeSinceOpen: number | null;
  movingWithReference: number | null;
  /** Index only: how many cards use it as their reference at all. */
  measuredAgainst: number | null;
  total: number;
}

export interface CannedContext extends ResponseContext {
  questionId: QuestionId;
  subject: SubjectContext | null;
}

export interface CannedRequest {
  questionId: QuestionId;
  subject?: AskSubject;
}

/**
 * The three calls that reach the feed, injectable.
 *
 * Tests substitute them so that nothing here touches the network -- the rule
 * D-124 was recorded for, after two tests were found making real requests and
 * passing only because the request happened to fail.
 */
export interface FeedDeps {
  ensure: typeof ensureInstrument;
  quote: typeof quoteFor;
  index: typeof indexQuote;
  /** History for a reference that has none yet -- see `readyToJudge`. */
  backfill: typeof backfillSymbol;
}

const LIVE_FEED: FeedDeps = {
  ensure: ensureInstrument,
  quote: quoteFor,
  index: indexQuote,
  backfill: backfillSymbol,
};

function returnsCount(db: Database.Database, symbol: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM daily_returns WHERE symbol = ?').get(symbol) as { n: number }
  ).n;
}

/**
 * A beta needs BOTH series, and the reference's arrives lazily.
 *
 * Found by running it: the reference indices get their history on the first
 * refresh pass, which the browser fires on arrival -- so a judge who opens the
 * live feed and asks about a stock in the first few seconds, before that pass
 * lands, gets "not enough history" about a stock that has 500 days of it. The
 * answer would be wrong, and confidently so. Fetch the reference's history here
 * if it is missing, then compute the beta the refresh would have computed.
 */
async function readyToJudge(db: Database.Database, symbol: string, feed: FeedDeps): Promise<void> {
  const ref = (
    db.prepare('SELECT reference_symbol AS ref FROM instruments WHERE symbol = ?').get(symbol) as
      | { ref: string | null }
      | undefined
  )?.ref;
  if (ref && returnsCount(db, ref) < MIN_USABLE_BARS) {
    try {
      await feed.backfill(db, ref, 'STOCK');
    } catch {
      // The reference not answering degrades to UNKNOWN, which is honest;
      // it must not turn a question about the stock into an error.
    }
  }
  const stats = db.prepare('SELECT beta FROM symbol_stats WHERE symbol = ?').get(symbol) as
    | { beta: number | null }
    | undefined;
  if ((stats === undefined || stats.beta === null) && returnsCount(db, symbol) >= MIN_USABLE_BARS) {
    saveStatsForSymbol(db, symbol);
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** IST calendar day, by arithmetic: India observes no daylight saving. */
function istDayIndexOf(at: number): number {
  return Math.floor((at + IST_OFFSET_MS) / 86_400_000);
}

function money(x: number): string {
  return `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(fraction: number, dp = 1): string {
  const v = fraction * 100;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(dp)}%`;
}

function withDisclosure(
  capability: AskResponse['capability'],
  answer: string,
  itemIds: string[] = [],
): AskResponse {
  return { capability, answer, itemIds, disclosure: DISCLOSURE };
}

const NO_HISTORY =
  'There is not enough history to say how much of this move is the market, so I will not quote you a percentage.';

// ------------------------------------------------------------- the subject

/**
 * Resolve what was picked into numbers, fetching once if it has never been
 * seen. A stock or fund is registered as an instrument (not a card) on first
 * ask -- the same call adding it would make, so a later add is instant. An
 * index is read and never written.
 */
async function subjectFor(
  db: Database.Database,
  watchlistId: string,
  subject: AskSubject,
  now: number,
  feed: FeedDeps,
): Promise<SubjectContext> {
  const session = fetchedSession(db);
  const marketOpen = isMarketOpen(now, session ?? undefined);

  if (subject.type === 'INDEX') {
    const tracked = knownReferenceFor(subject.vendorId);
    if (tracked !== null) {
      // Priced by the refresh pass normally; before the first pass has landed
      // the same read-only call any other index gets fills the gap.
      const stored = priceFor(db, tracked);
      const point =
        stored !== null
          ? { price: stored.price, asOf: stored.asOf, ret: stored.ret as number | null }
          : await feed.index(subject.vendorId).then((q) => ({
              price: q.price,
              asOf: q.asOf,
              ret: q.changeSinceOpen,
            }));
      const cards = buildContext(db, watchlistId, '').cards;
      const against = cards.filter((c) => c.referenceSymbol === tracked);
      const moving = against.filter(
        (c) => c.shareReference !== null && c.shareReference >= REFERENCE_SHARE_MOVING_WITH,
      ).length;
      const name = (
        db.prepare('SELECT name FROM instruments WHERE symbol = ?').get(tracked) as
          | { name: string }
          | undefined
      )?.name;
      return {
        symbol: tracked,
        name: name ?? subject.name,
        kind: 'INDEX',
        watched: false,
        cardId: null,
        price: point.price,
        asOf: point.asOf,
        delayMinutes: Math.max(0, Math.floor((now - point.asOf) / 60_000)),
        marketOpen,
        high52: null,
        low52: null,
        band: null,
        z: null,
        shareReference: null,
        referenceSymbol: null,
        referenceReturn: null,
        instrumentReturn: null,
        beta: null,
        observations: 0,
        explanation: null,
        threshold: null,
        triggerDistance: null,
        now,
        changeSinceOpen: point.ret,
        movingWithReference: moving,
        measuredAgainst: against.length,
        total: cards.length,
      };
    }

    const q = await feed.index(subject.vendorId);
    return {
      symbol: subject.symbol,
      name: q.name ?? subject.name,
      kind: 'INDEX',
      watched: false,
      cardId: null,
      price: q.price,
      asOf: q.asOf,
      delayMinutes: Math.max(0, Math.floor((now - q.asOf) / 60_000)),
      marketOpen,
      high52: q.high52,
      low52: q.low52,
      band: null,
      z: null,
      shareReference: null,
      referenceSymbol: null,
      referenceReturn: null,
      instrumentReturn: null,
      beta: null,
      observations: 0,
      explanation: null,
      threshold: null,
      triggerDistance: null,
      now,
      changeSinceOpen: q.changeSinceOpen,
      movingWithReference: null,
      measuredAgainst: null,
      total: 0,
    };
  }

  // A stock or a fund. Registered on first ask; instant thereafter.
  const hit: SearchHit = {
    vendorId: subject.vendorId,
    symbol: subject.symbol,
    name: subject.name,
    type: subject.type,
  };
  const ensured = await feed.ensure(db, hit);
  await readyToJudge(db, ensured.symbol, feed);
  const conviction = computeConviction(db, ensured.symbol, now);
  const point = priceFor(db, ensured.symbol);
  const price = point?.price ?? ensured.price;
  const asOf = point?.asOf ?? now;

  /*
   * The range comes free with the history on a FIRST ask -- the payload that
   * was just fetched carries it -- and costs one light call only for an
   * instrument already known. The comment used to claim that while calling
   * unconditionally, which for a fund meant downloading the entire NAV history
   * twice in one question (D-135).
   */
  let high52 = ensured.range52?.high ?? null;
  let low52 = ensured.range52?.low ?? null;
  if (high52 === null || low52 === null) {
    try {
      const q = await feed.quote(subject.type, subject.vendorId);
      high52 = q.high52;
      low52 = q.low52;
    } catch {
      // The range is help; help must not be able to block an answer.
    }
  }

  const cards = buildContext(db, watchlistId, '').cards;
  const card = cards.find((c) => c.symbol === ensured.symbol) ?? null;
  const threshold = card?.threshold ?? null;
  const distance =
    card === null || card.threshold === undefined
      ? null
      : triggerDistanceOf(
          card.thesisType as ThesisType,
          card.threshold,
          price,
          card.state as ItemState,
        );

  return {
    symbol: ensured.symbol,
    name: ensured.name,
    kind: subject.type,
    watched: card !== null,
    cardId: card?.id ?? null,
    price,
    asOf,
    delayMinutes: Math.max(0, Math.floor((now - asOf) / 60_000)),
    marketOpen,
    high52,
    low52,
    band: conviction.band,
    z: conviction.z,
    shareReference: conviction.shareReference,
    referenceSymbol: conviction.referenceSymbol,
    referenceReturn: conviction.referenceReturn,
    instrumentReturn: conviction.instrumentReturn,
    beta: conviction.beta,
    observations: returnsCount(db, ensured.symbol),
    explanation: conviction.explanation,
    threshold,
    triggerDistance: distance,
    now,
    changeSinceOpen: null,
    movingWithReference: null,
    measuredAgainst: null,
    total: cards.length,
  };
}

// ----------------------------------------------------------- the templates

/**
 * Seven templates over the context. Nothing here composes a number: every
 * figure is read from `SubjectContext` or from a card, and the two refusals
 * are the same sentences the simulated panel uses.
 */
export class CannedResponder {
  respond(context: CannedContext): AskResponse {
    const s = context.subject;
    switch (context.questionId) {
      case 'MISSED':
        return catchUpResponse(context);
      case 'ADVICE':
        return refusalResponse();
      case 'MARKET_SHARE':
        return s === null ? this.needsSubject() : this.marketShare(s);
      case 'UNUSUAL':
        return s === null ? this.needsSubject() : this.unusual(s);
      case 'FLAGGED':
        return s === null ? this.needsSubject() : this.flagged(context, s);
      case 'WHERE':
        return s === null ? this.needsSubject() : this.where(s);
      case 'MARKET':
        return s === null ? this.needsSubject() : this.market(s);
    }
  }

  private needsSubject(): AskResponse {
    return withDisclosure('UNSUPPORTED', 'Pick a stock, a fund or an index first, and then ask.');
  }

  private marketShare(s: SubjectContext): AskResponse {
    if (s.kind === 'INDEX') {
      return withDisclosure(
        'ATTRIBUTION',
        `${s.name} is an index, so there is no market to split its move against — it is what other things are measured against.`,
      );
    }
    if (s.band === null || s.band === 'UNKNOWN' || s.explanation === null) {
      return withDisclosure('ATTRIBUTION', `${s.symbol}: ${NO_HISTORY}`, s.cardId ? [s.cardId] : []);
    }
    const basis =
      s.beta === null
        ? ''
        : ` Estimated from ${s.observations} daily returns against ${s.referenceSymbol ?? 'its reference'}, beta ${s.beta.toFixed(2)}.`;
    return withDisclosure('ATTRIBUTION', `${s.symbol}: ${s.explanation}${basis}`, s.cardId ? [s.cardId] : []);
  }

  private unusual(s: SubjectContext): AskResponse {
    if (s.kind === 'INDEX') {
      return withDisclosure(
        'SURPRISE',
        `${s.name} is an index. The surprise score measures a move against what its own market explains, and an index has no market above it.`,
      );
    }
    if (s.z === null || s.band === 'UNKNOWN') {
      return withDisclosure('SURPRISE', `${s.symbol}: ${NO_HISTORY}`, s.cardId ? [s.cardId] : []);
    }
    const size = Math.abs(s.z).toFixed(1);
    const share = s.shareReference === null ? null : Math.round(s.shareReference * 100);
    let answer: string;
    if (Math.abs(s.z) < 1) {
      answer = `Nothing unusual. Today’s move is ${size}σ against ${s.symbol}’s own normal, well inside its ordinary range.`;
    } else if (Math.abs(s.z) < 2.5) {
      answer =
        share === null
          ? `Larger than usual: ${size}σ against ${s.symbol}’s own normal.`
          : `Larger than usual: ${size}σ against ${s.symbol}’s own normal, and ${share}% of it is the market rather than the stock.`;
    } else {
      answer =
        share === null
          ? `Yes. A ${size}σ move that ${s.symbol}’s own history does not explain.`
          : `Yes. A ${size}σ move that ${s.symbol}’s own history does not explain, and the market accounts for only ${share}% of it. Something is happening to it specifically.`;
    }
    return withDisclosure('SURPRISE', answer, s.cardId ? [s.cardId] : []);
  }

  private flagged(context: CannedContext, s: SubjectContext): AskResponse {
    const card = context.cards.find((c) => c.id === s.cardId);
    if (!card) {
      return withDisclosure(
        'EXPLAIN',
        `${s.symbol} is not on the list you are looking at, so I have no thesis to explain.`,
      );
    }
    const base = explainCard(card);
    if (s.triggerDistance === null || s.threshold === null) return base;
    // Silent once the card has fired: the state and its sentence already say so,
    // and the distance keys on the state exactly as the card does (D-130).
    const gap = `It is ${(s.triggerDistance * 100).toFixed(1)}% from your ${money(s.threshold)} trigger.`;
    return { ...base, answer: `${base.answer} ${gap}` };
  }

  private where(s: SubjectContext): AskResponse {
    const day = DAY_NAMES[istDayOfWeek(s.asOf)];
    let fresh: string;
    if (s.kind === 'FUND') {
      /*
       * Calendar days, not an elapsed-hours threshold. A NAV stamped 22:00 on
       * Monday and read at 09:00 on Tuesday is eleven hours old and is
       * yesterday's -- "published today" would be false about the one figure a
       * fund card turns on. The card's own line already compares IST days
       * (D-130) and these two must not disagree.
       */
      fresh =
        istDayIndexOf(s.asOf) === istDayIndexOf(s.now)
          ? 'NAV published today'
          : `NAV published ${day} evening · normal for a fund`;
    } else if (s.marketOpen) {
      fresh =
        s.delayMinutes >= 2
          ? `about ${s.delayMinutes} minutes behind the exchange`
          : 'live with the exchange';
    } else {
      fresh = `the last trade before ${day}’s close`;
    }
    // An index is a level, not a price: no rupees, and its name rather than a
    // vendor ticker, so that this answer and the market one describe the same
    // thing the same way.
    const level = s.kind === 'INDEX' ? s.price.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : money(s.price);
    const range =
      s.high52 !== null && s.low52 !== null
        ? s.kind === 'INDEX'
          ? ` In the last year it has ranged ${s.low52.toLocaleString('en-IN', { maximumFractionDigits: 2 })} to ${s.high52.toLocaleString('en-IN', { maximumFractionDigits: 2 })}.`
          : ` In the last year it has ranged ${money(s.low52)} to ${money(s.high52)}.`
        : '';
    const subject = s.kind === 'INDEX' ? s.name : s.symbol;
    const what = s.kind === 'FUND' ? 'NAV' : s.kind === 'INDEX' ? 'is at' : 'trades at';
    return withDisclosure('WHERE', `${subject} ${what} ${level} · ${fresh}.${range}`, s.cardId ? [s.cardId] : []);
  }

  private market(s: SubjectContext): AskResponse {
    if (s.kind !== 'INDEX') {
      return withDisclosure('MARKET', `${s.symbol} is not an index. Pick one to ask how the market is doing.`);
    }
    const move =
      s.changeSinceOpen === null ? '' : `, ${pct(s.changeSinceOpen, 2)} since the open`;
    const head = `${s.name} is at ${s.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${move}.`;
    /*
     * `measuredAgainst` alone decides which sentence this is, because the two
     * counts must move together: a fixture with a count of movers and a null
     * denominator rendered "1 of the null cards", which is the shape of bug the
     * whole no-fabricated-numbers rule exists to prevent. Null means the index
     * is not a reference here at all.
     */
    if (s.measuredAgainst === null) {
      return withDisclosure(
        'MARKET',
        `${head} It is not the reference for anything you watch, so there is nothing here to measure it against — an index is what other things are measured against.`,
      );
    }
    const n = s.movingWithReference ?? 0;
    /*
     * `measuredAgainst` is how many cards use this index as their reference,
     * which is not the same as how many are moving with it. Without the
     * distinction a tracked index that nothing references reported "0 of your 6
     * cards are moving with it" -- a measurement asserted about six cards that
     * were measured against something else entirely. Zero out of six and
     * "nothing here to measure it against" mean different things, and only the
     * second one is true.
     */
    const tail =
      s.total === 0
        ? ' Nothing is on this list yet to measure against it.'
        : s.measuredAgainst === 0
          ? ' Nothing you watch is measured against it, so there is nothing here to compare.'
          : ` ${n} of the ${s.measuredAgainst} ${s.measuredAgainst === 1 ? 'card' : 'cards'} measured against it ${n === 1 ? 'is' : 'are'} moving with it today.`;
    return withDisclosure('MARKET', `${head}${tail}`);
  }
}

// -------------------------------------------------------------- the entry

export async function askCanned(
  db: Database.Database,
  watchlistId: string,
  userId: string,
  request: CannedRequest,
  now: number = simNow(db),
  feed: FeedDeps = LIVE_FEED,
): Promise<AskResponse> {
  const question = QUESTIONS.find((q) => q.id === request.questionId);
  if (!question) throw new Error(`unknown question ${request.questionId}`);

  let subject: SubjectContext | null = null;
  if (request.subject && question.readsSubject === true) {
    try {
      subject = await subjectFor(db, watchlistId, request.subject, now, feed);
    } catch (err) {
      /*
       * The feed not answering is a normal condition for an unofficial
       * endpoint. The answer says so, carries the disclosure, and nothing has
       * been written: ensureInstrument rolls its own rows back on failure.
       */
      const kind = err instanceof FeedError ? err.kind : 'UNKNOWN';
      const why =
        kind === 'RATE_LIMIT'
          ? 'The price feed is rate-limiting us just now'
          : 'The price feed did not answer just now';
      return withDisclosure(
        'UNSUPPORTED',
        `${why}, so I have nothing to say about ${request.subject.name} yet. Nothing has been changed. Try again in a minute, or switch to Simulated data.`,
      );
    }
  }

  const base = buildContext(db, watchlistId, question.text);
  const context: CannedContext = { ...base, questionId: question.id, subject };
  const response = new CannedResponder().respond(context);

  db.prepare(
    `INSERT INTO ask_log (user_id, asked_at, question_text, capability, resolved_item_id, response_text, context)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    Date.now(),
    subject ? `${question.text} [${subject.symbol}]` : question.text,
    response.capability,
    response.itemIds[0] ?? null,
    response.answer,
    JSON.stringify(context),
  );
  return response;
}
