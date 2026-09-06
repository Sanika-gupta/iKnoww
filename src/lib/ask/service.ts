import type Database from 'better-sqlite3';
import { computeConviction } from '../engine/conviction';
import { listItems } from '../watchlist/items';
import { changesSince } from '../watchlist/read';
import { phraseThesis } from '../watchlist/templates';
import { parseThesis, resolveSymbol, type ParsedThesis, type Candidate } from './parser';
import { THESIS_TEMPLATES } from '../domain/types';
import { cardLine } from '../api/board';

/**
 * The Ask panel.
 *
 * Three guardrails, set before any of it was designed:
 *
 *   1. It never gives investment advice. It will not answer "should I buy?".
 *      That is SEBI-regulated territory and exactly what Responsible forbids.
 *   2. It never becomes a second definition of "meaningful". It reads conviction,
 *      theses, events and the read cursor. It never ranks, scores or decides what
 *      matters, because that would compete with the one answer this product
 *      already gives.
 *   3. It never states a number it did not receive. Every figure is interpolated
 *      from the live conviction payload, not composed.
 *
 * On "hard-coded": there is a large difference between canned strings and
 * templates filled from live state, and only the second is worth building. The
 * responses below are generated from a ResponseContext holding exactly what we
 * would send a model. Run the crash scenario and the answer says 92% because the
 * number really is 92%; run a different scenario and it changes.
 *
 * That is not a demo shortcut, it is the same principle as the rest of the
 * product. This app refuses to fabricate conviction, refuses to fake an order,
 * and refuses to let a wrong alert stand. Generating answers deterministically
 * from data we can prove is that argument applied once more, and a hallucination
 * rate of zero is a stronger claim than "we called a model".
 *
 * The seam for a real model is `AskResponder`. Swapping one in is one class.
 */

export type Capability =
  | 'EXPLAIN'
  | 'PARSE_THESIS'
  | 'CATCH_UP'
  | 'HYGIENE'
  | 'REFUSED_ADVICE'
  | 'UNSUPPORTED'
  // The live feed's picked questions (D-133). Each is one template.
  | 'ATTRIBUTION'
  | 'SURPRISE'
  | 'WHERE'
  | 'MARKET';

export interface AskResponse {
  capability: Capability;
  answer: string;
  /** A thesis awaiting the user's confirmation. Never saved by asking. */
  proposal?: ParsedThesis;
  /** Cards this answer is about, so the UI can highlight them. */
  itemIds: string[];
  /** Always shown. The user should never have to wonder what produced this. */
  disclosure: string;
}

export const DISCLOSURE =
  'Answered from your watchlist data using fixed templates. No language model.';

/** Everything a responder is allowed to see. The same shape a model would get. */
export interface ResponseContext {
  question: string;
  cards: Array<{
    id: string;
    symbol: string;
    name: string;
    state: string;
    thesisLine: string;
    thesisType: string;
    threshold?: number;
    band: string;
    z: number | null;
    shareReference: number | null;
    referenceSymbol: string | null;
    /**
     * Carried as numbers, not only inside the formatted explanation. A model
     * adapter given this context must not have to parse a percentage back out
     * of a sentence, and the no-fabricated-numbers test cannot verify a figure
     * the context only holds as text.
     */
    referenceReturn: number | null;
    instrumentReturn: number | null;
    explanation: string;
    /** Exactly the sentence the card is showing right now. */
    line: string;
    price: number;
    unreadChanges: number;
  }>;
  changes: Array<{ symbol: string; toState: string; reason: string }>;
  universe: Candidate[];
}

const ADVICE =
  /\b(?:should i|shall i|do you (?:think|recommend)|is it a good (?:time|buy)|what should i (?:buy|sell|do)|worth buying|worth selling|recommend)\b/i;
const CATCH_UP = /\b(?:what did i miss|what.?s new|catch me up|since i last|what changed|anything new)\b/i;
const HYGIENE = /\b(?:stale|out of date|old thesis|which theses|clean up|tidy)\b/i;
const EXPLAIN = /\b(?:why|explain|what.?s (?:happening|going on)|what happened|how come|tell me about)\b/i;
const ADD = /\b(?:watch|add|track|buy|sell|exit|protect|book|dip|breakout|stop)\b/i;

export function buildContext(
  db: Database.Database,
  watchlistId: string,
  question: string,
): ResponseContext {
  const items = listItems(db, watchlistId);
  const cards = items.map((item) => {
    const conviction = computeConviction(db, item.symbol);
    const instrument = db
      .prepare('SELECT name, instrument_type AS instrumentType FROM instruments WHERE symbol = ?')
      .get(item.symbol) as { name: string; instrumentType: 'STOCK' | 'FUND' };
    const price = db
      .prepare('SELECT price FROM price_events WHERE symbol = ? ORDER BY seq DESC LIMIT 1')
      .get(item.symbol) as { price: number } | undefined;
    return {
      id: item.id,
      symbol: item.symbol,
      name: instrument.name,
      state: item.state,
      thesisLine: phraseThesis(item.thesisType, item.params.threshold),
      thesisType: item.thesisType,
      threshold: item.params.threshold,
      band: conviction.band,
      z: conviction.z,
      shareReference: conviction.shareReference,
      referenceSymbol: conviction.referenceSymbol,
      referenceReturn: conviction.referenceReturn,
      instrumentReturn: conviction.instrumentReturn,
      explanation: conviction.explanation,
      line: cardLine(db, item, instrument.instrumentType, item.state, conviction, price?.price ?? 0),
      price: price?.price ?? 0,
      unreadChanges: 0,
    };
  });

  const universe = db
    .prepare('SELECT symbol, name FROM instruments WHERE is_reference = 0')
    .all() as Candidate[];

  return {
    question,
    cards,
    changes: changesSince(db, watchlistId).map((c) => ({
      symbol: c.symbol,
      toState: c.toState,
      reason: c.reason,
    })),
    universe,
  };
}

/*
 * The three answers both panels share -- the simulated one routes a typed
 * sentence to them, the live one reaches them from a picked question (D-133).
 * Kept as plain functions of a context so that neither panel can drift from
 * the other in what it says about the same card.
 */

/**
 * Refusing is not a gap in the feature, it is the feature. Telling someone
 * what to buy is regulated advice and precisely what this product argues
 * against, so it says so plainly and names what it can do instead.
 */
export function refusalResponse(): AskResponse {
  return {
    capability: 'REFUSED_ADVICE',
    answer:
      'I will not tell you what to buy or sell. That is a decision only you can make, and an app that made it for you would be doing exactly what this one exists to argue against. What I can do is tell you what changed, how much of a move was really about your holding rather than the market, and what would change a card.',
    itemIds: [],
    disclosure: DISCLOSURE,
  };
}

function whatWouldChangeIt(card: ResponseContext['cards'][number]): string {
  const template = THESIS_TEMPLATES[card.thesisType as keyof typeof THESIS_TEMPLATES];
  if (!template || template.direction === null || card.threshold === undefined) {
    return 'It has no price condition, so only an unusually large move of its own would flag it.';
  }
  const price = `₹${card.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const t = `₹${card.threshold.toLocaleString('en-IN')}`;
  return template.direction === 'BELOW'
    ? `It is at ${price} against a trigger of ${t}, and it would become actionable if a fall that size were mostly about ${card.symbol} rather than the market.`
    : `It is at ${price} against a trigger of ${t}, and it would become actionable if a rise that size were mostly about ${card.symbol} rather than the market.`;
}

/** The narration for one card: thesis, split, and what would change it. */
export function explainCard(card: ResponseContext['cards'][number]): AskResponse {
  // Every number below comes from the card. Nothing is composed.
  const parts: string[] = [];
  parts.push(`Your thesis on ${card.symbol}: ${card.thesisLine}.`);

  if (card.band === 'UNKNOWN') {
    parts.push(
      'There is not enough history to say how much of this move is the market, so I will not quote you a percentage.',
    );
  } else {
    parts.push(card.explanation);
  }

  if (card.state === 'NEEDS_REVIEW') {
    parts.push(
      card.band === 'LOW'
        ? 'That is why it says review rather than act: the trigger fired, but the move was mostly the reference.'
        : 'That is why it says review rather than act: this is a shock, and your thesis assumed a drift.',
    );
    parts.push(whatWouldChangeIt(card));
  } else if (card.state === 'UNEXPLAINED') {
    parts.push(
      'No condition you set covers this, which is why it surfaced at all. It stays flagged until you acknowledge it.',
    );
  } else if (card.state === 'ACTIONABLE') {
    parts.push('It is actionable, and the buy or sell on the card is the action your thesis leads to.');
  } else if (card.state === 'FULFILLED') {
    parts.push('You have already acted on this thesis, so it has stopped firing. Re-arm it to start again.');
  } else {
    parts.push(whatWouldChangeIt(card));
  }

  return {
    capability: 'EXPLAIN',
    answer: parts.join(' '),
    itemIds: [card.id],
    disclosure: DISCLOSURE,
  };
}

/** Reads out the existing digest. It does not rank; it reports. */
export function catchUpResponse(context: ResponseContext): AskResponse {
  if (context.changes.length === 0) {
    return {
      capability: 'CATCH_UP',
      answer:
        'Nothing has changed since you last looked. That is a real answer rather than an empty screen.',
      itemIds: [],
      disclosure: DISCLOSURE,
    };
  }
  // Which cards changed comes from the digest, which costs O(changes) rather
  // than the size of the watchlist. WHAT each one says comes from the card as
  // it reads now. Replaying the stored reason would quote the attribution
  // frozen at the moment it fired, and a catch-up answer would then disagree
  // with the explain answer about the very same card (D-082 again).
  const changed = new Set(context.changes.map((c) => c.symbol));
  const lines: string[] = [];
  const ids: string[] = [];
  for (const card of context.cards) {
    if (!changed.has(card.symbol)) continue;
    lines.push(`${card.symbol}: ${card.line}`);
    ids.push(card.id);
  }
  return {
    capability: 'CATCH_UP',
    answer: `${lines.length} ${lines.length === 1 ? 'card' : 'cards'} changed since you last looked. ${lines.join(' ')}`,
    itemIds: ids,
    disclosure: DISCLOSURE,
  };
}

/** The seam. `ScriptedResponder` ships; a model adapter would sit beside it. */
export interface AskResponder {
  respond(context: ResponseContext): AskResponse;
}

export class ScriptedResponder implements AskResponder {
  respond(context: ResponseContext): AskResponse {
    const q = context.question.trim();

    if (ADVICE.test(q)) return this.refuseAdvice();
    if (CATCH_UP.test(q)) return this.catchUp(context);
    if (HYGIENE.test(q)) return this.hygiene(context);

    // "why is TCS flagged" is an explanation; "watch TCS below 3800" is a
    // thesis. Both name a symbol, so the verb decides.
    if (EXPLAIN.test(q)) return this.explain(context);
    if (ADD.test(q)) return this.propose(context);

    return this.unsupported();
  }

  /**
   * Refusing is not a gap in the feature, it is the feature. Telling someone
   * what to buy is regulated advice and precisely what this product argues
   * against, so it says so plainly and names what it can do instead.
   */
  private refuseAdvice(): AskResponse {
    return refusalResponse();
  }

  private explain(context: ResponseContext): AskResponse {
    // Resolved against the WHOLE universe, not just the watchlist. Asking about
    // a real instrument you happen not to be watching deserves "it is not on
    // your watchlist", not a list of unrelated cards.
    const match = resolveSymbol(context.question, context.universe);
    if (match === null || 'candidates' in match) {
      const flagged = context.cards.filter((c) => c.state !== 'WATCHING');
      if (flagged.length === 0) {
        return {
          capability: 'EXPLAIN',
          answer: 'Nothing on your watchlist is flagged right now. Every card is moving normally.',
          itemIds: [],
          disclosure: DISCLOSURE,
        };
      }
      return {
        capability: 'EXPLAIN',
        answer: `${flagged.length === 1 ? 'One card is' : `${flagged.length} cards are`} asking for a look: ${flagged
          .map((c) => c.symbol)
          .join(', ')}. Ask me about one of them by name and I will break the move down.`,
        itemIds: flagged.map((c) => c.id),
        disclosure: DISCLOSURE,
      };
    }

    const card = context.cards.find((c) => c.symbol === match.symbol);
    if (!card) {
      return {
        capability: 'EXPLAIN',
        answer: `${match.symbol} is not on your watchlist, so I have no thesis to explain.`,
        itemIds: [],
        disclosure: DISCLOSURE,
      };
    }

    return explainCard(card);
  }

  /** Reads out the existing digest. It does not rank; it reports. */
  private catchUp(context: ResponseContext): AskResponse {
    return catchUpResponse(context);
  }

  private hygiene(context: ResponseContext): AskResponse {
    const far = context.cards.filter((c) => {
      if (c.threshold === undefined || c.price === 0) return false;
      return Math.abs(c.price - c.threshold) / c.price > 0.25;
    });
    const fulfilled = context.cards.filter((c) => c.state === 'FULFILLED');

    if (far.length === 0 && fulfilled.length === 0) {
      return {
        capability: 'HYGIENE',
        answer: 'Every thesis on your watchlist is still within reach of its trigger.',
        itemIds: [],
        disclosure: DISCLOSURE,
      };
    }

    const parts: string[] = [];
    if (far.length > 0) {
      parts.push(
        `${far.map((c) => c.symbol).join(', ')} ${far.length === 1 ? 'has a trigger' : 'have triggers'} more than 25% away from the current price, so ${far.length === 1 ? 'it' : 'they'} will not fire any time soon.`,
      );
    }
    if (fulfilled.length > 0) {
      parts.push(
        `${fulfilled.map((c) => c.symbol).join(', ')} ${fulfilled.length === 1 ? 'has been' : 'have been'} acted on and stopped firing. Re-arm if you still want to watch.`,
      );
    }
    parts.push('I will not change anything without you saying so.');
    return {
      capability: 'HYGIENE',
      answer: parts.join(' '),
      itemIds: [...far, ...fulfilled].map((c) => c.id),
      disclosure: DISCLOSURE,
    };
  }

  private propose(context: ResponseContext): AskResponse {
    const parsed = parseThesis(context.question, context.universe);
    if (parsed.ok) {
      return {
        capability: 'PARSE_THESIS',
        answer: `I read that as — ${parsed.thesis.restated} Confirm and I will add it.`,
        proposal: parsed.thesis,
        itemIds: [],
        disclosure: DISCLOSURE,
      };
    }

    const f = parsed.failure;
    switch (f.reason) {
      case 'NO_SYMBOL':
        return this.partial(
          `I understood ${f.understood}, but not which instrument you meant. Name the stock or fund and I will read the rest back to you.`,
        );
      case 'AMBIGUOUS_SYMBOL':
        // A wrong symbol on a real order is unacceptable, so we ask.
        return this.partial(
          `That could be ${f.candidates.join(' or ')}. Which one did you mean?`,
        );
      case 'NO_THRESHOLD':
        return this.partial(
          `I have ${f.understood}, but no price to trigger on. What level should it fire at?`,
        );
      case 'NO_INTENT':
        return this.partial(
          `I found ${f.symbol}, but not what you want to do about it. Buy on a dip, buy on a breakout, add more, book profit, exit, or just watch?`,
        );
    }
  }

  private partial(answer: string): AskResponse {
    return { capability: 'PARSE_THESIS', answer, itemIds: [], disclosure: DISCLOSURE };
  }

  /** Honest about the edges, and never a guess. */
  private unsupported(): AskResponse {
    return {
      capability: 'UNSUPPORTED',
      answer:
        'I cannot answer that. I have no news feed, no fundamentals and no view on the wider market, and inventing one is where an assistant does the most damage. I can explain any card on your watchlist, tell you what changed since you last looked, turn a sentence into a thesis, and point out theses that have drifted out of reach.',
      itemIds: [],
      disclosure: DISCLOSURE,
    };
  }
}

export function ask(
  db: Database.Database,
  watchlistId: string,
  userId: string,
  question: string,
  responder: AskResponder = new ScriptedResponder(),
): AskResponse {
  const context = buildContext(db, watchlistId, question);
  const response = responder.respond(context);

  // Every answer is stored with the exact context that produced it, so any
  // response is reproducible and auditable after the fact.
  db.prepare(
    `INSERT INTO ask_log (user_id, asked_at, question_text, capability, resolved_item_id, response_text, context)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    Date.now(),
    question,
    response.capability,
    response.itemIds[0] ?? null,
    response.answer,
    JSON.stringify(context),
  );

  return response;
}
