import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLiveTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID } from '../../src/lib/db/seed';
import { saveStatsForSymbol } from '../../src/lib/engine/stats';
import { setSessionOpen } from '../../src/lib/feed/backfill';
import { ingestPrice, nextSeq } from '../../src/lib/engine/ingest';
import { addItem } from '../../src/lib/watchlist/items';
import { evaluateAll } from '../../src/lib/engine/states';
import { DISCLOSURE, buildContext } from '../../src/lib/ask/service';
import {
  CannedResponder,
  askCanned,
  questionsFor,
  QUESTIONS,
  type CannedContext,
  type FeedDeps,
  type SubjectContext,
} from '../../src/lib/ask/canned';
import { FeedError, parseYahooIndexSearch } from '../../src/lib/feed/client';
import {
  LIVE_STOCK_REFERENCE,
  ensureInstrument,
  isKnown,
} from '../../src/lib/feed/instruments';
import { knownReferenceFor } from '../../src/lib/feed/symbols';

/**
 * Ask in the live feed: pick, don't type (D-133), and the one index it may
 * read about but never watch (D-134).
 *
 * Nothing here touches the network. The three feed calls are injected and
 * every stub either answers from memory or throws the error a real refusal
 * would, which is the rule D-124 was recorded for.
 */

const REFERENCE = LIVE_STOCK_REFERENCE;
const IST = (5 * 60 + 30) * 60_000;
const ist = (v: string) => Date.parse(v + '+05:30');
const dayIndex = (at: number) => Math.floor((at + IST) / 86_400_000);

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/feed', name), 'utf8'));

/** Writes the returns a real backfill would write, without fetching them. */
function seedReturns(db: Database.Database, symbol: string, from: number, count: number): void {
  const insert = db.prepare('INSERT OR REPLACE INTO daily_returns (symbol, day, ret) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const market = Math.sin(i / 7) * 0.01;
      const own = Math.cos(i / 11) * 0.004;
      insert.run(symbol, from + i, symbol === REFERENCE ? market : 1.2 * market + own);
    }
  })();
}

function addLiveInstrument(db: Database.Database, symbol: string): void {
  db.prepare(
    `INSERT INTO instruments (symbol, name, instrument_type, reference_symbol, sector, is_reference)
     VALUES (?, ?, 'STOCK', ?, NULL, 0)`,
  ).run(symbol, `${symbol} Limited`, REFERENCE);
}

function price(db: Database.Database, symbol: string, open: number, last: number, at: number): void {
  setSessionOpen(db, symbol, open);
  ingestPrice(db, { symbol, seq: nextSeq(db, symbol), price: last, asOf: at });
}

/** A live board with a reference, one priced stock with a real beta, and the clock in session. */
function board(): { db: Database.Database; now: number; listId: string } {
  const db = createLiveTestDb();
  const now = ist('2026-09-04T11:00:00');
  db.prepare('UPDATE sim_state SET sim_now = ?, session_start = ?, session_end = ? WHERE id = 1').run(
    now,
    ist('2026-09-04T09:15:00'),
    ist('2026-09-04T15:30:00'),
  );
  const from = dayIndex(now) - 300;
  seedReturns(db, REFERENCE, from, 300);
  addLiveInstrument(db, 'RELIANCE');
  seedReturns(db, 'RELIANCE', from, 300);
  saveStatsForSymbol(db, 'RELIANCE');
  price(db, REFERENCE, 24000, 23990, now);
  // A modest move: a large one against the seeded idiosyncratic vol would
  // trip the surprise detector, which is the engine being right, not the test.
  price(db, 'RELIANCE', 1320, 1322, now);
  const listId = (db.prepare('SELECT id FROM watchlists LIMIT 1').get() as { id: string }).id;
  return { db, now, listId };
}

/** The feed, stubbed. `ensure` behaves like the real one for a known symbol and refuses the rest. */
function stubFeed(overrides: Partial<FeedDeps> = {}): FeedDeps {
  return {
    ensure: async (db, hit) => {
      if (hit.type === 'INDEX') throw new Error('index');
      if (!isKnown(db, hit.symbol)) throw new FeedError('offline in tests', 'NETWORK');
      // The real function's known-symbol branch reads only the database.
      return ensureInstrument(db, hit);
    },
    quote: async () => ({ price: 1322, asOf: 0, high52: 1551, low52: 1115.55 }),
    index: async () => {
      throw new FeedError('offline in tests', 'NETWORK');
    },
    backfill: async () => {
      throw new FeedError('offline in tests', 'NETWORK');
    },
    ...overrides,
  };
}

/** The no-fabricated-numbers walker from ask.test.ts, applied to a canned context. */
function everyNumberTraceable(context: CannedContext, answer: string): void {
  const allowed = new Set<number>();
  const admit = (v: number) => {
    if (!Number.isFinite(v)) return;
    allowed.add(v);
    allowed.add(Number(v.toFixed(0)));
    allowed.add(Number(v.toFixed(1)));
    allowed.add(Number(v.toFixed(2)));
  };
  const walk = (node: unknown): void => {
    if (typeof node === 'number') {
      admit(node);
      admit(node * 100);
      admit((1 - node) * 100);
      admit(Math.abs(node * 100));
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(context);
  for (let n = 0; n <= context.cards.length; n++) allowed.add(n);
  const plain = answer.replace(/(\d),(?=\d{3})/g, '$1');
  // A digit that continues a word -- the 50 in NIFTY50 -- is part of a name,
  // not a figure the answer is asserting.
  for (const raw of plain.match(/(?<![A-Za-z_])\d+(?:\.\d+)?/g) ?? []) {
    expect(allowed.has(Number(raw)), `${raw} should come from the context`).toBe(true);
  }
}

const SUBJECT: SubjectContext = {
  symbol: 'RELIANCE',
  name: 'Reliance Industries Limited',
  kind: 'STOCK',
  watched: false,
  cardId: null,
  price: 1322,
  asOf: ist('2026-09-04T15:15:00'),
  delayMinutes: 15,
  marketOpen: true,
  high52: 1551,
  low52: 1115.55,
  band: 'HIGH',
  z: 1.36,
  shareReference: 0.034,
  referenceSymbol: 'NIFTY50',
  referenceReturn: -0.001,
  instrumentReturn: 0.0169,
  beta: 0.896,
  observations: 250,
  explanation: '97% of this move is the stock itself. The market moved -0.1%.',
  threshold: null,
  triggerDistance: null,
  now: ist('2026-09-04T15:30:00'),
  changeSinceOpen: null,
  movingWithReference: null,
  measuredAgainst: null,
  total: 1,
};

function ctx(db: Database.Database, listId: string, questionId: CannedContext['questionId'], subject: SubjectContext | null): CannedContext {
  return { ...buildContext(db, listId, ''), questionId, subject };
}

describe('there are seven questions, and which ones are offered depends on what was picked', () => {
  it('offers only the board-wide question until something is picked', () => {
    expect(questionsFor(null, false).map((q) => q.id)).toEqual(['MISSED']);
  });

  it('offers a stock the judgement questions, and the flagged one only if it is on the board', () => {
    const unwatched = questionsFor('STOCK', false).map((q) => q.id);
    expect(unwatched).toEqual(['MARKET_SHARE', 'UNUSUAL', 'WHERE', 'MISSED', 'ADVICE']);
    expect(questionsFor('STOCK', true).map((q) => q.id)).toContain('FLAGGED');
  });

  it('offers an index only what an index can answer', () => {
    // Conviction is meaningless for an index (D-074), so the attribution and
    // surprise questions are not offered rather than answered with a refusal.
    expect(questionsFor('INDEX', false).map((q) => q.id)).toEqual(['WHERE', 'MARKET', 'MISSED']);
  });

  it('has no eighth question', () => {
    expect(QUESTIONS.length).toBe(7);
  });
});

describe('every template states only numbers the context holds', () => {
  const { db, listId } = board();

  it.each(QUESTIONS.map((q) => q.id))('%s', (id) => {
    const c = ctx(db, listId, id, SUBJECT);
    const r = new CannedResponder().respond(c);
    expect(r.disclosure).toBe(DISCLOSURE);
    everyNumberTraceable(c, r.answer);
  });

  it('quotes the beta and the observation count so the estimate can be seen to be real', () => {
    const r = new CannedResponder().respond(ctx(db, listId, 'MARKET_SHARE', SUBJECT));
    expect(r.capability).toBe('ATTRIBUTION');
    expect(r.answer).toContain('97% of this move is the stock itself');
    expect(r.answer).toContain('250 daily returns');
    expect(r.answer).toContain('beta 0.90');
  });
});

describe('the refusals hold', () => {
  const { db, listId } = board();

  it('never quotes a percentage when the history is too short', () => {
    const unknown: SubjectContext = { ...SUBJECT, band: 'UNKNOWN', z: null, shareReference: null, beta: null, observations: 40 };
    for (const id of ['MARKET_SHARE', 'UNUSUAL'] as const) {
      const r = new CannedResponder().respond(ctx(db, listId, id, unknown));
      expect(r.answer).toContain('I will not quote you a percentage');
      expect(r.answer).not.toMatch(/\d+%/);
    }
  });

  it('refuses advice with the same sentence the simulated panel uses', () => {
    const r = new CannedResponder().respond(ctx(db, listId, 'ADVICE', SUBJECT));
    expect(r.capability).toBe('REFUSED_ADVICE');
    expect(r.answer).toMatch(/will not tell you what to buy or sell/);
  });

  it('asks for a subject rather than guessing one', () => {
    const r = new CannedResponder().respond(ctx(db, listId, 'MARKET_SHARE', null));
    expect(r.capability).toBe('UNSUPPORTED');
    expect(r.answer).toMatch(/Pick a stock/);
  });
});

describe('the surprise question reads the z-score honestly', () => {
  const { db, listId } = board();
  const at = (z: number) => new CannedResponder().respond(ctx(db, listId, 'UNUSUAL', { ...SUBJECT, z }));

  it('says nothing unusual inside one sigma', () => {
    expect(at(0.4).answer).toMatch(/Nothing unusual/);
  });
  it('says larger than usual between one and two and a half', () => {
    expect(at(1.8).answer).toMatch(/Larger than usual/);
  });
  it('calls a shock a shock past two and a half', () => {
    expect(at(3.1).answer).toMatch(/does not explain/);
  });
});

describe('the freshness answer never says the exchange is running a day late', () => {
  const { db, listId } = board();

  it('gives the delay while the market is open, and it is the delay the gate judges', () => {
    const r = new CannedResponder().respond(ctx(db, listId, 'WHERE', SUBJECT));
    expect(r.answer).toContain('about 15 minutes behind the exchange');
    expect(r.answer).toContain('₹1,115.55 to ₹1,551.00');
  });

  it('names the last trading day when the market is shut, with no clock digits', () => {
    // Read off a real card on a Saturday: "1604 min behind the exchange".
    const r = new CannedResponder().respond(
      ctx(db, listId, 'WHERE', { ...SUBJECT, marketOpen: false, delayMinutes: 1604 }),
    );
    expect(r.answer).toContain('the last trade before Friday’s close');
    expect(r.answer).not.toMatch(/\d:\d\d/);
    expect(r.answer).not.toMatch(/1604/);
  });

  it('describes a fund NAV as normal only when it is old enough to need saying', () => {
    const today = new CannedResponder().respond(
      ctx(db, listId, 'WHERE', { ...SUBJECT, kind: 'FUND', delayMinutes: 30 }),
    );
    expect(today.answer).toContain('NAV published today');
    const yesterday = new CannedResponder().respond(
      ctx(db, listId, 'WHERE', { ...SUBJECT, kind: 'FUND', delayMinutes: 23 * 60, asOf: ist('2026-09-03T18:00:00') }),
    );
    expect(yesterday.answer).toContain('NAV published Thursday evening · normal for a fund');
  });
});

describe('the flagged question keys on the card, and on its state', () => {
  it('says it is not on this list rather than inventing a thesis', () => {
    const { db, listId } = board();
    const r = new CannedResponder().respond(ctx(db, listId, 'FLAGGED', SUBJECT));
    expect(r.answer).toMatch(/not on the list you are looking at/);
  });

  it('adds the distance on a card that has not fired, and nothing on one that has', () => {
    const { db, listId, now } = board();
    const added = addItem(db, { userId: DEFAULT_USER_ID, watchlistId: listId, symbol: 'RELIANCE', thesisType: 'DIP_BUY', params: { threshold: 1250 } });
    if (!added.ok) throw new Error(added.error);
    evaluateAll(db, now);
    const cards = buildContext(db, listId, '').cards;
    const card = cards.find((c) => c.symbol === 'RELIANCE')!;
    const watching: SubjectContext = { ...SUBJECT, watched: true, cardId: added.item.id, threshold: 1250, triggerDistance: (1322 - 1250) / 1322 };
    const r = new CannedResponder().respond({ ...buildContext(db, listId, ''), questionId: 'FLAGGED', subject: watching });
    expect(r.capability).toBe('EXPLAIN');
    expect(r.answer).toContain('Your thesis on RELIANCE');
    expect(r.answer).toContain('5.4% from your ₹1,250.00 trigger');
    expect(card.state).toBe('WATCHING');

    // Once fired, the distance is null and the sentence is absent (D-130).
    const fired = new CannedResponder().respond({ ...buildContext(db, listId, ''), questionId: 'FLAGGED', subject: { ...watching, triggerDistance: null } });
    expect(fired.answer).not.toMatch(/from your/);
  });
});

describe('an index is read about and never watched (D-134)', () => {
  it('filters the search to NSE indices and nothing foreign', () => {
    const hits = parseYahooIndexSearch(fixture('yahoo-search-nifty.json'));
    expect(hits.map((h) => h.vendorId)).toEqual(['^NSEI', '^NSEBANK', 'NIFTY_MIDCAP_100.NS']);
    expect(hits.every((h) => h.type === 'INDEX')).toBe(true);
  });

  it('recognises the three references the engine already tracks', () => {
    expect(knownReferenceFor('^NSEI')).toBe('NIFTY50');
    expect(knownReferenceFor('^CRSLDX')).toBe('NIFTY500');
    expect(knownReferenceFor('^NSEBANK')).toBeNull();
  });

  it('refuses to make an index a card, on the server, whatever the picker allowed', async () => {
    const db = createLiveTestDb();
    await expect(
      ensureInstrument(db, { vendorId: '^NSEBANK', symbol: '^NSEBANK', name: 'NIFTY BANK', type: 'INDEX' }),
    ).rejects.toThrow(/cannot be watched/);
    expect(isKnown(db, '^NSEBANK')).toBe(false);
  });

  it('answers a tracked reference from the board, with how many cards move with it', () => {
    const { db, listId } = board();
    const subject: SubjectContext = { ...SUBJECT, symbol: 'NIFTY50', name: 'Nifty 50', kind: 'INDEX', changeSinceOpen: -0.005, movingWithReference: 1, measuredAgainst: 1, total: 1, band: null, z: null };
    const r = new CannedResponder().respond(ctx(db, listId, 'MARKET', subject));
    expect(r.answer).toContain('Nifty 50 is at 1,322');
    expect(r.answer).toContain('−0.50% since the open');
    expect(r.answer).toContain('1 of the 1 card measured against it is moving with it today');
  });

  it('does not report a count about cards measured against something else', () => {
    // "0 of your 6 cards are moving with it" asserts a measurement that was
    // never performed: those six are measured against a different reference.
    const { db, listId } = board();
    const subject: SubjectContext = { ...SUBJECT, symbol: 'NIFTY500', name: 'Nifty 500', kind: 'INDEX', changeSinceOpen: -0.002, movingWithReference: 0, measuredAgainst: 0, total: 6, band: null, z: null };
    const r = new CannedResponder().respond(ctx(db, listId, 'MARKET', subject));
    expect(r.answer).toContain('Nothing you watch is measured against it');
    expect(r.answer).not.toMatch(/0 of/);
  });

  it('says plainly that an untracked index has nothing to be measured against', () => {
    const { db, listId } = board();
    const subject: SubjectContext = { ...SUBJECT, symbol: '^NSEBANK', name: 'NIFTY BANK', kind: 'INDEX', changeSinceOpen: 0.004, movingWithReference: null, total: 0, band: null, z: null };
    const r = new CannedResponder().respond(ctx(db, listId, 'MARKET', subject));
    expect(r.answer).toContain('nothing here to measure it against');
    // And the questions that need a reference are not answered for it at all.
    expect(new CannedResponder().respond(ctx(db, listId, 'MARKET_SHARE', subject)).answer).toMatch(/is an index/);
  });

  it('writes no row for an index it answered about', async () => {
    const { db, listId, now } = board();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM instruments').get() as { n: number }).n;
    const feed = stubFeed({
      index: async () => ({ price: 57369.65, asOf: now, changeSinceOpen: -0.0002, high52: 61764.85, low52: 49954.85, name: 'NIFTY BANK' }),
    });
    const r = await askCanned(db, listId, DEFAULT_USER_ID, { questionId: 'MARKET', subject: { vendorId: '^NSEBANK', symbol: '^NSEBANK', name: 'NIFTY BANK', type: 'INDEX' } }, now, feed);
    expect(r.answer).toContain('NIFTY BANK is at 57,369.65');
    expect((db.prepare('SELECT COUNT(*) AS n FROM instruments').get() as { n: number }).n).toBe(before);
  });
});

describe('a stock can be judged even when its reference has no history yet', () => {
  it('fetches the reference first, then estimates the beta', async () => {
    /*
     * Found by running it: the reference indices get their history on the
     * first refresh pass, which the browser fires on arrival. Ask in the first
     * few seconds, before that pass lands, and the stock has 500 returns, the
     * reference has none, and the answer is "not enough history" -- wrong,
     * and confidently so.
     */
    const db = createLiveTestDb();
    const now = ist('2026-09-04T11:00:00');
    db.prepare('UPDATE sim_state SET sim_now = ? WHERE id = 1').run(now);
    const from = dayIndex(now) - 300;
    addLiveInstrument(db, 'RELIANCE');
    seedReturns(db, 'RELIANCE', from, 300);
    price(db, REFERENCE, 24000, 23990, now);
    price(db, 'RELIANCE', 1320, 1322, now);
    const listId = (db.prepare('SELECT id FROM watchlists LIMIT 1').get() as { id: string }).id;
    expect((db.prepare('SELECT COUNT(*) AS n FROM daily_returns WHERE symbol = ?').get(REFERENCE) as { n: number }).n).toBe(0);

    const asked: string[] = [];
    const feed = stubFeed({
      backfill: async (d, symbol) => {
        asked.push(symbol);
        seedReturns(d, symbol, from, 300);
        return { symbol, price: 23990, asOf: now, observations: 300, beta: null, session: null, name: null, range52: null };
      },
    });
    const r = await askCanned(
      db,
      listId,
      DEFAULT_USER_ID,
      { questionId: 'MARKET_SHARE', subject: { vendorId: 'RELIANCE.NS', symbol: 'RELIANCE', name: 'Reliance', type: 'STOCK' } },
      now,
      feed,
    );
    expect(asked).toEqual([REFERENCE]);
    expect(r.answer).toMatch(/beta \d\.\d\d/);
    expect(r.answer).not.toMatch(/not enough history/);
  });

  it('answers about a tracked index from the feed before the first refresh has priced it', async () => {
    const db = createLiveTestDb();
    const now = ist('2026-09-04T11:00:00');
    db.prepare('UPDATE sim_state SET sim_now = ? WHERE id = 1').run(now);
    const listId = (db.prepare('SELECT id FROM watchlists LIMIT 1').get() as { id: string }).id;
    const feed = stubFeed({
      index: async () => ({ price: 23897.7, asOf: now, changeSinceOpen: -0.0011, high52: null, low52: null, name: 'NIFTY 50' }),
    });
    const r = await askCanned(db, listId, DEFAULT_USER_ID, { questionId: 'MARKET', subject: { vendorId: '^NSEI', symbol: '^NSEI', name: 'NIFTY 50', type: 'INDEX' } }, now, feed);
    expect(r.capability).toBe('MARKET');
    expect(r.answer).toContain('is at 23,897.7');
    expect(r.answer).toContain('Nothing is on this list yet');
  });
});

describe('the defects a review found', () => {
  /** A feed that refuses everything, which is what a rate limit looks like. */
  function deadFeed(): FeedDeps {
    const refuse = async () => {
      throw new FeedError('429', 'RATE_LIMIT', 429);
    };
    return { ensure: refuse, quote: refuse, index: refuse, backfill: refuse };
  }

  it('refuses advice with the feed completely down', async () => {
    /*
     * "Should I buy it?" is OFFERED for a stock, so resolving the subject used
     * to fetch two years of history -- which the answer, a constant refusal,
     * then discarded. A rate-limited Yahoo therefore replaced the product's
     * headline safety guarantee with "the price feed did not answer".
     *
     * The one answer that must never depend on a third party was the one that
     * did. Being offered for an instrument and reading one are now different
     * things (D-135).
     */
    const { db, listId, now } = board();
    const r = await askCanned(
      db,
      listId,
      DEFAULT_USER_ID,
      { questionId: 'ADVICE', subject: { vendorId: 'ANYTHING.NS', symbol: 'ANYTHING', name: 'Anything', type: 'STOCK' } },
      now,
      deadFeed(),
    );
    expect(r.capability).toBe('REFUSED_ADVICE');
    expect(r.answer).toMatch(/will not tell you what to buy or sell/);
    // And it wrote nothing while doing so.
    expect(isKnown(db, 'ANYTHING')).toBe(false);
  });

  it('takes the 52-week range from the history it just fetched, not a second call', async () => {
    /*
     * The comment claimed a first ask costs one call while the code called
     * unconditionally. For a fund that meant downloading the whole NAV history
     * twice inside one question.
     */
    const { db, listId, now } = board();
    let quotes = 0;
    const feed = stubFeed({
      ensure: async (d, hit) => ({
        symbol: hit.symbol,
        name: hit.name,
        type: 'STOCK',
        assumedBenchmark: false,
        observations: 500,
        beta: 1.1,
        price: 712.1,
        range52: { high: 1020.5, low: 698.5 },
      }),
      quote: async () => {
        quotes += 1;
        return { price: 0, asOf: 0, high52: null, low52: null };
      },
    });
    const r = await askCanned(
      db,
      listId,
      DEFAULT_USER_ID,
      { questionId: 'WHERE', subject: { vendorId: 'HDFCBANK.NS', symbol: 'HDFCBANK', name: 'HDFC Bank', type: 'STOCK' } },
      now,
      feed,
    );
    expect(quotes).toBe(0);
    expect(r.answer).toContain('₹698.50 to ₹1,020.50');
  });

  it('still asks for the range when the instrument was already known', async () => {
    const { db, listId, now } = board();
    let quotes = 0;
    const feed = stubFeed({
      quote: async () => {
        quotes += 1;
        return { price: 1322, asOf: 0, high52: 1551, low52: 1115.55 };
      },
    });
    await askCanned(
      db,
      listId,
      DEFAULT_USER_ID,
      { questionId: 'WHERE', subject: { vendorId: 'RELIANCE.NS', symbol: 'RELIANCE', name: 'Reliance', type: 'STOCK' } },
      now,
      feed,
    );
    // RELIANCE is already in the database, so ensureInstrument fetched nothing
    // and carries no range: one light call is correct here.
    expect(quotes).toBe(1);
  });

  it('judges a NAV by the calendar day, not by hours elapsed', () => {
    /*
     * A NAV stamped 22:00 on Monday, read at 09:00 on Tuesday, is eleven hours
     * old and is YESTERDAY's. An hours threshold called it "published today",
     * which is false about the one figure a fund card turns on -- and it
     * disagreed with the card's own line, which compares IST days.
     */
    const { db, listId } = board();
    const monday = ist('2026-09-07T22:00:00');
    const tuesday = ist('2026-09-08T09:00:00');
    const r = new CannedResponder().respond(
      ctx(db, listId, 'WHERE', {
        ...SUBJECT,
        kind: 'FUND',
        asOf: monday,
        now: tuesday,
        delayMinutes: 660,
      }),
    );
    expect(r.answer).toContain('NAV published Monday evening · normal for a fund');
    expect(r.answer).not.toContain('published today');
  });

  it('describes an index as a level, not as a price in rupees', () => {
    // `market()` says "NIFTY BANK is at 57,369.65"; `where()` used to say
    // "^NSEBANK trades at ₹57,369.65" about the same thing.
    const { db, listId } = board();
    const r = new CannedResponder().respond(
      ctx(db, listId, 'WHERE', {
        ...SUBJECT,
        symbol: '^NSEBANK',
        name: 'NIFTY BANK',
        kind: 'INDEX',
        price: 57369.65,
        high52: 61764.85,
        low52: 49954.85,
        marketOpen: false,
      }),
    );
    expect(r.answer).toContain('NIFTY BANK is at 57,369.65');
    expect(r.answer).not.toContain('₹');
    expect(r.answer).not.toContain('^NSEBANK');
  });
});

describe('askCanned end to end, with the feed stubbed', () => {
  it('answers the board-wide question with no subject and logs it', async () => {
    const { db, listId, now } = board();
    const r = await askCanned(db, listId, DEFAULT_USER_ID, { questionId: 'MISSED' }, now, stubFeed());
    expect(r.capability).toBe('CATCH_UP');
    expect(r.answer).toMatch(/Nothing has changed/);
    const row = db.prepare('SELECT question_text AS q, capability AS c FROM ask_log ORDER BY id DESC LIMIT 1').get() as { q: string; c: string };
    expect(row.q).toBe('What did I miss?');
    expect(row.c).toBe('CATCH_UP');
  });

  it('answers about a known stock from the database, with a real beta and no fetch', async () => {
    const { db, listId, now } = board();
    const r = await askCanned(
      db,
      listId,
      DEFAULT_USER_ID,
      { questionId: 'MARKET_SHARE', subject: { vendorId: 'RELIANCE.NS', symbol: 'RELIANCE', name: 'Reliance', type: 'STOCK' } },
      now,
      stubFeed(),
    );
    expect(r.capability).toBe('ATTRIBUTION');
    expect(r.answer).toMatch(/beta \d\.\d\d/);
    // A move inside ordinary noise is narrated as normal rather than split
    // into a percentage (D-070); either is the engine speaking, not the test.
    expect(r.answer).toMatch(/(\d+% of this move|Moving normally)/);
    // The logged context carries every number the answer used.
    const row = db.prepare('SELECT context FROM ask_log ORDER BY id DESC LIMIT 1').get() as { context: string };
    const logged = JSON.parse(row.context) as CannedContext;
    expect(logged.subject?.symbol).toBe('RELIANCE');
    everyNumberTraceable(logged, r.answer);
  });

  it('says so when the feed refuses, and leaves nothing behind', async () => {
    const { db, listId, now } = board();
    const feed = stubFeed({
      ensure: async () => {
        throw new FeedError('429', 'RATE_LIMIT', 429);
      },
    });
    const r = await askCanned(
      db,
      listId,
      DEFAULT_USER_ID,
      { questionId: 'MARKET_SHARE', subject: { vendorId: 'HDFCBANK.NS', symbol: 'HDFCBANK', name: 'HDFC Bank', type: 'STOCK' } },
      now,
      feed,
    );
    expect(r.capability).toBe('UNSUPPORTED');
    expect(r.answer).toMatch(/rate-limiting/);
    expect(r.disclosure).toBe(DISCLOSURE);
    expect(isKnown(db, 'HDFCBANK')).toBe(false);
  });

  it('still answers when only the 52-week range cannot be fetched', async () => {
    const { db, listId, now } = board();
    const feed = stubFeed({
      quote: async () => {
        throw new FeedError('429', 'RATE_LIMIT', 429);
      },
    });
    const r = await askCanned(
      db,
      listId,
      DEFAULT_USER_ID,
      { questionId: 'WHERE', subject: { vendorId: 'RELIANCE.NS', symbol: 'RELIANCE', name: 'Reliance', type: 'STOCK' } },
      now,
      feed,
    );
    expect(r.capability).toBe('WHERE');
    expect(r.answer).toContain('RELIANCE trades at ₹1,322.00');
    expect(r.answer).not.toMatch(/In the last year/);
  });
});
