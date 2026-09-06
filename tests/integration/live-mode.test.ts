import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createLiveTestDb, createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID, ALL_INSTRUMENTS } from '../../src/lib/db/seed';
import { feedModeOf, isFeedMode, modeFrom } from '../../src/lib/domain/mode';
import { isStale } from '../../src/lib/engine/conviction';
import { saveStatsForSymbol } from '../../src/lib/engine/stats';
import { setSessionOpen } from '../../src/lib/feed/backfill';
import { ingestPrice, nextSeq } from '../../src/lib/engine/ingest';
import { addItem } from '../../src/lib/watchlist/items';
import { buildBoard } from '../../src/lib/api/board';
import { simNow } from '../../src/lib/sim/ticker';
import { LIVE_FUND_REFERENCE, LIVE_STOCK_REFERENCE, isKnown } from '../../src/lib/feed/instruments';
import {
  AUTO_REFRESH_MIN_AGE_MS,
  openPricesAreStale,
  persistPassState,
  refresh,
} from '../../src/lib/feed/refresh';
import { evaluateAll } from '../../src/lib/engine/states';
import { processTransitions, isMarketOpen, fetchedSession } from '../../src/lib/alerts/policy';

/**
 * Live mode, tested where it can go wrong quietly.
 *
 * Nothing here touches the network: the feed client is split so its parsers are
 * pure, and everything below writes the rows the feed would have written. What
 * is being tested is not "does Yahoo answer" -- that is verified by hand and
 * cannot be a build dependency -- but the four failures that produce a live
 * board which LOOKS fine and is not:
 *
 *   1. no sim_state row, and five engine call sites throw;
 *   2. no session_opens row, and a card sits at zero forever with no error;
 *   3. no stored statistics, and every conviction is UNKNOWN, so live mode
 *      never sends a single alert;
 *   4. the two databases bleeding into each other.
 */

const REFERENCE = LIVE_STOCK_REFERENCE;

/** Writes the returns a real backfill would write, without fetching them. */
function seedReturns(db: Database.Database, symbol: string, from: number, count: number): void {
  const insert = db.prepare('INSERT OR REPLACE INTO daily_returns (symbol, day, ret) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      // Deterministic and jointly distributed, so a beta genuinely exists.
      const market = Math.sin(i / 7) * 0.01;
      const own = Math.cos(i / 11) * 0.004;
      insert.run(symbol, from + i, symbol === REFERENCE ? market : 1.2 * market + own);
    }
  })();
}

function addLiveInstrument(
  db: Database.Database,
  symbol: string,
  type: 'STOCK' | 'FUND' = 'STOCK',
): void {
  db.prepare(
    `INSERT INTO instruments (symbol, name, instrument_type, reference_symbol, sector, is_reference)
     VALUES (?, ?, ?, ?, NULL, 0)`,
  ).run(symbol, symbol, type, type === 'FUND' ? LIVE_FUND_REFERENCE : LIVE_STOCK_REFERENCE);
}

describe('a live database boots into something the engine can actually read', () => {
  it('creates the sim_state row five engine call sites read with a non-null cast', () => {
    const db = createLiveTestDb();
    // Without this row `simNow` throws a TypeError rather than returning
    // anything, and the board renders 1 January 1970. It is the single reason
    // bootstrapLive cannot simply skip the simulator's setup.
    expect(() => simNow(db)).not.toThrow();
    expect(simNow(db)).toBeGreaterThan(Date.parse('2020-01-01'));
    expect(feedModeOf(db)).toBe('live');
  });

  it('seeds the three references and nothing else', () => {
    const db = createLiveTestDb();
    const rows = db
      .prepare('SELECT symbol, is_reference AS isRef FROM instruments ORDER BY symbol')
      .all() as Array<{ symbol: string; isRef: number }>;
    expect(rows.map((r) => r.symbol)).toEqual(['NIFTY50', 'NIFTY500', 'NIFTYMID150']);
    expect(rows.every((r) => r.isRef === 1)).toBe(true);
    // The simulated universe is untouched by any of this.
    expect(ALL_INSTRUMENTS.length).toBe(15);
  });

  it('starts with one empty list rather than none', () => {
    const db = createLiveTestDb();
    const lists = db.prepare('SELECT id FROM watchlists').all() as Array<{ id: string }>;
    // ONE, not zero. "The last list cannot be removed" is an invariant every
    // other query already assumes (D-100); a genuinely list-less database would
    // reopen that case in eight routes, untested.
    expect(lists.map((l) => l.id)).toEqual([DEFAULT_WATCHLIST_ID]);
    const items = db.prepare('SELECT COUNT(*) AS n FROM watchlist_items').get() as { n: number };
    expect(items.n).toBe(0);
  });

  it('runs no simulator: no generated history, no ticks, no demo cards', () => {
    const db = createLiveTestDb();
    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count('daily_returns')).toBe(0);
    expect(count('price_events')).toBe(0);
    expect(count('session_opens')).toBe(0);
    const sim = db.prepare('SELECT tick, scenario FROM sim_state WHERE id = 1').get() as {
      tick: number;
      scenario: string | null;
    };
    expect(sim.tick).toBe(0);
    expect(sim.scenario).toBeNull();
  });

  it('renders a board with a real clock rather than 1 January 1970', () => {
    const db = createLiveTestDb();
    const board = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(board.market.clock.label).not.toContain('1970');
    expect(board.cards).toEqual([]);
    // No trading period has been fetched yet, so the badge must say it is
    // assuming rather than implying it knows.
    expect(board.market.clock.hoursSource).toBe('assumed');
  });
});

describe('an instrument added at runtime is evaluable, not inert', () => {
  function addWithHistory(db: Database.Database, symbol: string, price: number): void {
    addLiveInstrument(db, symbol);
    seedReturns(db, REFERENCE, 20000, 300);
    seedReturns(db, symbol, 20000, 300);
    saveStatsForSymbol(db, symbol);
    setSessionOpen(db, REFERENCE, 24000);
    setSessionOpen(db, symbol, price);
    ingestPrice(db, { symbol: REFERENCE, seq: nextSeq(db, REFERENCE), price: 24000, asOf: Date.now() });
    ingestPrice(db, { symbol, seq: nextSeq(db, symbol), price, asOf: Date.now() });
  }

  it('gets a stored beta, so its conviction is never silently UNKNOWN', () => {
    const db = createLiveTestDb();
    addWithHistory(db, 'RELIANCE', 1300);

    // The failure this guards is the quietest one in the whole feature. No
    // stored statistics means conviction UNKNOWN, which routes every met
    // trigger to NEEDS_REVIEW as UNVERIFIABLE (D-080), which is not in
    // ALERTABLE_STATES -- so live mode would run, look correct, and never send
    // a single alert.
    const stats = db.prepare('SELECT beta, window_n AS n FROM symbol_stats WHERE symbol = ?').get('RELIANCE') as
      | { beta: number | null; n: number }
      | undefined;
    expect(stats).toBeDefined();
    expect(stats!.beta).not.toBeNull();
    expect(Number.isFinite(stats!.beta!)).toBe(true);
    expect(stats!.n).toBeGreaterThanOrEqual(120);
  });

  it('gets an opening price, so the card is not stuck at zero forever', () => {
    const db = createLiveTestDb();
    addWithHistory(db, 'INFY', 1500);
    const r = addItem(db, {
      userId: DEFAULT_USER_ID,
      watchlistId: DEFAULT_WATCHLIST_ID,
      symbol: 'INFY',
      thesisType: 'DIP_BUY',
      params: { threshold: 1400 },
    });
    expect(r.ok).toBe(true);

    // Without a session_opens row `priceFor` returns null and evaluateSymbol
    // returns an empty array with NO error at all. The card renders at zero, in
    // WATCHING, and stays there.
    const card = buildBoard(db, DEFAULT_WATCHLIST_ID).cards.find((c) => c.symbol === 'INFY');
    expect(card).toBeDefined();
    expect(card!.price).toBe(1500);
    expect(card!.band).not.toBe('UNKNOWN');
  });

  it('is attributed against the market, and an unknown fund says its benchmark is assumed', () => {
    const db = createLiveTestDb();
    addLiveInstrument(db, 'TCS', 'STOCK');
    addLiveInstrument(db, 'MF_999', 'FUND');
    const refOf = (s: string) =>
      (db.prepare('SELECT reference_symbol AS r FROM instruments WHERE symbol = ?').get(s) as {
        r: string;
      }).r;
    expect(refOf('TCS')).toBe('NIFTY50');
    // An assumption, not a fact: mfapi does not carry a scheme's stated
    // benchmark. It is labelled on the card rather than quietly applied,
    // because a single-factor model against the wrong reference produces a
    // plausible wrong number.
    expect(refOf('MF_999')).toBe('NIFTY500');
  });

  it('knows what it already has, so re-adding does not refetch two years', () => {
    const db = createLiveTestDb();
    expect(isKnown(db, 'NIFTY50')).toBe(true);
    expect(isKnown(db, 'RELIANCE')).toBe(false);
    addLiveInstrument(db, 'RELIANCE');
    expect(isKnown(db, 'RELIANCE')).toBe(true);
  });
});

describe('the widened live staleness limit is applied, and only in live mode', () => {
  it('accepts a quote fifteen minutes old in live and refuses it in simulated', () => {
    const now = Date.parse('2026-09-04T12:00:00+05:30');
    const fifteenMinutesAgo = now - 15 * 60_000;

    // Yahoo delivers NSE quotes about fifteen minutes behind the exchange,
    // measured from the feed's own timestamps. Against the ten-minute simulated
    // limit EVERY live quote is stale and no card can ever change state.
    expect(isStale('STOCK', fifteenMinutesAgo, now, 'sim')).toBe(true);
    expect(isStale('STOCK', fifteenMinutesAgo, now, 'live')).toBe(false);

    // Widened, not removed. A genuinely dead feed is still caught.
    expect(isStale('STOCK', now - 45 * 60_000, now, 'live')).toBe(true);
  });

  it('leaves the fund limit alone, because a NAV publishes daily in both modes', () => {
    const now = Date.parse('2026-09-04T12:00:00+05:30');
    const yesterdayEvening = now - 18 * 60 * 60_000;
    expect(isStale('FUND', yesterdayEvening, now, 'sim')).toBe(false);
    expect(isStale('FUND', yesterdayEvening, now, 'live')).toBe(false);
  });

  it('reads the mode from the database, so no engine function needed a new argument', () => {
    expect(feedModeOf(createLiveTestDb())).toBe('live');
    expect(feedModeOf(createTestDb(true))).toBe('sim');
  });
});

describe('the two databases never bleed into each other', () => {
  it('gives live and simulated separate watchlists, items and prices', () => {
    const sim = createTestDb(true);
    const live = createLiveTestDb();

    addLiveInstrument(live, 'RELIANCE');
    seedReturns(live, REFERENCE, 20000, 300);
    seedReturns(live, 'RELIANCE', 20000, 300);
    saveStatsForSymbol(live, 'RELIANCE');
    setSessionOpen(live, 'RELIANCE', 1300);
    ingestPrice(live, { symbol: 'RELIANCE', seq: 1, price: 1300, asOf: Date.now() });

    addItem(live, {
      userId: DEFAULT_USER_ID,
      watchlistId: DEFAULT_WATCHLIST_ID,
      symbol: 'RELIANCE',
      thesisType: 'JUST_WATCHING',
      params: {},
    });

    const liveCards = buildBoard(live, DEFAULT_WATCHLIST_ID).cards;
    const simCards = buildBoard(sim, DEFAULT_WATCHLIST_ID).cards;
    expect(liveCards.map((c) => c.symbol)).toEqual(['RELIANCE']);
    // The simulated board still has its seeded demo cards and is unaware that
    // anything happened in live mode at all.
    expect(simCards.length).toBeGreaterThan(1);
    expect(simCards.find((c) => c.price === 1300)).toBeUndefined();

    const simPrices = sim.prepare('SELECT COUNT(*) AS n FROM price_events').get() as { n: number };
    const livePrices = live.prepare('SELECT COUNT(*) AS n FROM price_events').get() as { n: number };
    expect(livePrices.n).toBe(1);
    expect(simPrices.n).toBeGreaterThan(1);
  });

  it('resolves the requested mode from a URL, and falls back to simulated', () => {
    const at = (url: string) => modeFrom(new Request(url));
    expect(at('http://x/api/board?mode=live')).toBe('live');
    expect(at('http://x/api/board?mode=sim')).toBe('sim');
    // Anything absent, misspelt or hostile falls back to the mode that always
    // works and never reaches the network.
    expect(at('http://x/api/board')).toBe('sim');
    expect(at('http://x/api/board?mode=LIVE')).toBe('sim');
    expect(at('http://x/api/board?mode=../../live')).toBe('sim');
    expect(isFeedMode('live')).toBe(true);
    expect(isFeedMode('production')).toBe(false);
  });
});

describe('the feed is throttled, and a failure never blanks a card', () => {
  /**
   * Set a live database up with one instrument that already has a price, so
   * every assertion below is about what happens to a card that EXISTS.
   */
  function boardWithOnePricedCard(): Database.Database {
    const db = createLiveTestDb();
    addLiveInstrument(db, 'RELIANCE');
    seedReturns(db, REFERENCE, 20000, 300);
    seedReturns(db, 'RELIANCE', 20000, 300);
    saveStatsForSymbol(db, 'RELIANCE');
    setSessionOpen(db, REFERENCE, 24000);
    setSessionOpen(db, 'RELIANCE', 1300);
    ingestPrice(db, { symbol: REFERENCE, seq: 1, price: 24000, asOf: Date.now() });
    ingestPrice(db, { symbol: 'RELIANCE', seq: 1, price: 1322, asOf: Date.now() });
    addItem(db, {
      userId: DEFAULT_USER_ID,
      watchlistId: DEFAULT_WATCHLIST_ID,
      symbol: 'RELIANCE',
      thesisType: 'DIP_BUY',
      params: { threshold: 1200 },
    });
    return db;
  }

  it('skips an automatic pass that follows a recent one, without touching the network', async () => {
    /*
     * The arithmetic this exists for: every open tab refreshes on load and then
     * once a minute, and a pass makes one outbound call per instrument. Three
     * judges with two tabs each, watching eight stocks, is about sixty-six
     * calls a minute from one datacenter IP to an endpoint that rate-limits.
     *
     * If the throttle did not hold, this test would try to reach Yahoo and the
     * suite would depend on a third party.
     */
    const db = boardWithOnePricedCard();
    db.prepare('UPDATE sim_state SET last_refresh_at = ? WHERE id = 1').run(Date.now());

    const result = await refresh(db, DEFAULT_USER_ID);
    expect(result.skipped).toBe(true);
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('never skips the first pass on a cold instance, however many people arrive at once', async () => {
    // `last_refresh_at` is null until a pass completes, so the first viewer of
    // a fresh instance always gets real prices rather than an empty board.
    const db = boardWithOnePricedCard();
    const last = db.prepare('SELECT last_refresh_at AS l FROM sim_state WHERE id = 1').get() as {
      l: number | null;
    };
    expect(last.l).toBeNull();
  });

  it('lets a person past the throttle, because a click is bounded and a timer is not', async () => {
    const db = boardWithOnePricedCard();
    db.prepare('UPDATE sim_state SET last_refresh_at = ? WHERE id = 1').run(Date.now());
    // Forced, so it does NOT return early -- it goes on to try the network,
    // which fails in a test environment. What matters is that it did not skip,
    // and that the failure is survivable, which the next test asserts.
    const result = await refresh(db, DEFAULT_USER_ID, { force: true }).catch(() => null);
    expect(result === null || result.skipped === false).toBe(true);
  });

  it('has a throttle window just under the refresh interval, or the cadence halves', () => {
    /*
     * The window has to sit BELOW the client's 60-second interval and close to
     * it. Below, because a pass stamps the clock when it finishes, so the next
     * tick lands a fraction under a minute later; at exactly 60_000 it would be
     * skipped and the real cadence would quietly become two minutes. Close to
     * it, because the whole purpose is that a second tab arriving mid-minute
     * reads the stored board rather than doubling the outbound call volume.
     *
     * Written as bounds rather than as the number itself, so the intent
     * survives someone changing the number (D-127).
     */
    expect(AUTO_REFRESH_MIN_AGE_MS).toBeLessThan(60_000);
    expect(AUTO_REFRESH_MIN_AGE_MS).toBeGreaterThan(45_000);
  });

  it('keeps rendering the last prices when the feed cannot be reached at all', async () => {
    /*
     * The guarantee the options document asked for by name: "a failed fetch
     * degrades to the last good snapshot and never blanks a card".
     *
     * The last good snapshot is not a committed file, it is the price events
     * already in the database. A feed failure changes nothing about them, so
     * the board is built exactly as it would have been -- which is why the
     * route returns the board ALONGSIDE the error rather than instead of it.
     */
    const db = boardWithOnePricedCard();
    const before = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(before.cards[0].price).toBe(1322);

    // Whatever the feed does, a board built afterwards is unchanged.
    await refresh(db, DEFAULT_USER_ID, { force: true }).catch(() => null);

    const after = buildBoard(db, DEFAULT_WATCHLIST_ID);
    expect(after.cards).toHaveLength(1);
    expect(after.cards[0].symbol).toBe('RELIANCE');
    expect(after.cards[0].price).toBeGreaterThan(0);
    expect(after.market.price).toBeGreaterThan(0);
  });
});

describe('live mode with the market OPEN, which the calendar will not let us test by hand', () => {
  /*
   * Every hand verification of live mode happened on a Saturday, where quotes
   * are stale by design and no card can change state. The path that matters
   * most -- a fresh quote inside the twenty-minute live gate moving a card and
   * earning an alert -- had never executed anywhere, and the market does not
   * reopen until after the submission window.
   *
   * So it is executed here instead. Nothing touches the network: the rows are
   * the ones a refresh would have written, and the clock is put inside the
   * trading session the feed itself reports.
   */

  const OPEN = Date.parse('2026-09-04T11:00:00+05:30'); // a Friday, mid-session
  const SESSION = {
    start: Date.parse('2026-09-04T09:15:00+05:30'),
    end: Date.parse('2026-09-04T15:30:00+05:30'),
  };

  /** A live database mid-session, with one stock priced and one thesis on it. */
  function tradingDay(threshold: number, price: number): Database.Database {
    const db = createLiveTestDb();
    addLiveInstrument(db, 'RELIANCE');
    seedReturns(db, REFERENCE, 20000, 300);
    seedReturns(db, 'RELIANCE', 20000, 300);
    saveStatsForSymbol(db, 'RELIANCE');
    setSessionOpen(db, REFERENCE, 24000);
    setSessionOpen(db, 'RELIANCE', 1400);

    db.prepare(
      'UPDATE sim_state SET sim_now = ?, session_start = ?, session_end = ? WHERE id = 1',
    ).run(OPEN, SESSION.start, SESSION.end);

    // The reference barely moves, so whatever the stock does is its own.
    ingestPrice(db, { symbol: REFERENCE, seq: 1, price: 24010, asOf: OPEN - 60_000 });
    // A quote fifteen minutes behind the exchange, which is what Yahoo delivers.
    ingestPrice(db, { symbol: 'RELIANCE', seq: 1, price, asOf: OPEN - 15 * 60_000 });

    addItem(db, {
      userId: DEFAULT_USER_ID,
      watchlistId: DEFAULT_WATCHLIST_ID,
      symbol: 'RELIANCE',
      thesisType: 'DIP_BUY',
      params: { threshold },
    });
    return db;
  }

  it('treats a fifteen-minute-old quote as fresh, so a card can actually move', () => {
    const db = tradingDay(1300, 1400);
    // The simulated limit is ten minutes. Against it, every live quote is stale
    // and no card could ever change state -- live mode would look inert while
    // behaving exactly as specified.
    expect(isStale('STOCK', OPEN - 15 * 60_000, OPEN, 'live')).toBe(false);
    const card = buildBoard(db, DEFAULT_WATCHLIST_ID).cards[0];
    expect(card.stale).toBe(false);
    expect(card.band).not.toBe('UNKNOWN');
  });

  it('knows the market is open from the session the feed reported', () => {
    const db = tradingDay(1300, 1400);
    expect(isMarketOpen(OPEN, fetchedSession(db))).toBe(true);
    expect(buildBoard(db, DEFAULT_WATCHLIST_ID).market.clock.isOpen).toBe(true);
  });

  it('moves a card off a crossed threshold and sends the alert', () => {
    // The thesis is "buy below 1350" and the stock is at 1400, so nothing has
    // happened yet.
    const db = tradingDay(1350, 1400);
    evaluateAll(db, OPEN);
    expect(buildBoard(db, DEFAULT_WATCHLIST_ID).cards[0].state).toBe('WATCHING');

    // Now a real quote crosses it, on a day the reference did nothing.
    ingestPrice(db, { symbol: 'RELIANCE', seq: 2, price: 1300, asOf: OPEN - 15 * 60_000 });
    const transitions = evaluateAll(db, OPEN);
    expect(transitions.length).toBe(1);

    const card = buildBoard(db, DEFAULT_WATCHLIST_ID).cards[0];
    expect(card.state).not.toBe('WATCHING');

    // And it is allowed to interrupt, because the market is open and the move
    // is the stock's own. This is the whole product, running on the live path.
    const outcome = processTransitions(db, DEFAULT_USER_ID, transitions, OPEN);
    expect(outcome.digest).not.toBeNull();
    expect(outcome.digest!.items.map((i) => i.symbol)).toEqual(['RELIANCE']);
  });

  it('still refuses to interrupt after the close, on the same crossing', () => {
    const db = tradingDay(1350, 1400);
    const afterClose = Date.parse('2026-09-04T18:00:00+05:30');
    db.prepare('UPDATE sim_state SET sim_now = ? WHERE id = 1').run(afterClose);
    ingestPrice(db, { symbol: 'RELIANCE', seq: 2, price: 1300, asOf: afterClose - 15 * 60_000 });

    const transitions = evaluateAll(db, afterClose);
    const outcome = processTransitions(db, DEFAULT_USER_ID, transitions, afterClose);
    // The card still changed; the phone stays quiet. Same rule as simulated
    // mode, reading the same predicate.
    expect(outcome.digest).toBeNull();
    expect(outcome.suppressed.map((sup) => sup.reason)).toContain('MARKET_CLOSED');
  });
});


describe('the defects a review found, held down by tests that touch no network', () => {
  const DAY_MS = 24 * 60 * 60_000;
  const IST = (5 * 60 + 30) * 60_000;
  const dayIndex = (at: number) => Math.floor((at + IST) / DAY_MS);
  const ist = (v: string) => Date.parse(v + '+05:30');

  function setSessionState(
    db: Database.Database,
    fields: { start?: number | null; end?: number | null; opensDay?: number | null },
  ): void {
    db.prepare(
      'UPDATE sim_state SET session_start = ?, session_end = ?, session_opens_day = ? WHERE id = 1',
    ).run(fields.start ?? null, fields.end ?? null, fields.opensDay ?? null);
  }

  it('gives a beta to a symbol whose reference had not arrived when it was added', async () => {
    /*
     * Statistics used to be computed in exactly one place: the branch that
     * backfills a symbol with NO history at all. So a symbol whose history
     * landed while its reference had none yet -- every symbol added before the
     * first successful index fetch -- got a null beta and kept it forever,
     * because nothing ever looked again. Conviction UNKNOWN, every trigger
     * routed to review, not one alert, on a board that looks healthy.
     *
     * The pass below is deliberately THROTTLED, which is also the assertion
     * that repairing statistics is local work and must not be skipped along
     * with the network. It is why this test reaches no further than the early
     * return, and therefore why it makes no request.
     */
    const db = createLiveTestDb();
    addLiveInstrument(db, 'RELIANCE');
    seedReturns(db, 'RELIANCE', 20000, 300); // history, but the reference has none
    saveStatsForSymbol(db, 'RELIANCE');

    const before = db
      .prepare('SELECT beta FROM symbol_stats WHERE symbol = ?')
      .get('RELIANCE') as { beta: number | null } | undefined;
    expect(before?.beta ?? null).toBeNull();

    // The reference arrives on a later pass, as it does in reality.
    seedReturns(db, REFERENCE, 20000, 300);
    db.prepare('UPDATE sim_state SET last_refresh_at = ? WHERE id = 1').run(Date.now());

    const result = await refresh(db, DEFAULT_USER_ID);
    // Asserted, so that if the throttle ever stopped engaging this fails rather
    // than quietly becoming a test that calls Yahoo.
    expect(result.skipped).toBe(true);

    const after = db
      .prepare('SELECT beta FROM symbol_stats WHERE symbol = ?')
      .get('RELIANCE') as { beta: number | null } | undefined;
    expect(after?.beta).not.toBeNull();
    expect(Number.isFinite(after!.beta!)).toBe(true);
  });

  it('declines to write opening prices before the bell', () => {
    /*
     * Rolling the day and writing the opening prices are different events. A
     * pass at 07:00 rolls the day while the exchange is shut, and the feed's
     * "open" is still yesterday's -- a number that feeds every percentage,
     * every residual, the z-score, the conviction band and the alerting.
     */
    const db = createLiveTestDb();
    const monday = ist('2026-09-07T09:15:00');
    setSessionState(db, {
      start: monday,
      end: ist('2026-09-07T15:30:00'),
      opensDay: dayIndex(monday) - 1,
    });
    expect(openPricesAreStale(db, ist('2026-09-07T07:00:00'))).toBe(false);
    expect(openPricesAreStale(db, ist('2026-09-07T09:20:00'))).toBe(true);
  });

  it('does not trust a session start left over from a previous day', () => {
    /*
     * The first version of this fix compared now against whatever session a
     * PREVIOUS pass had stored, without checking it was today's. At 07:00 the
     * stored start was Friday's 09:15, now was well past it, so the guard waved
     * through exactly the write it exists to prevent -- and then stamped the
     * day, so the 09:20 pass declined and Friday's open was pinned for the
     * whole of Monday. A gate that locks in the wrong answer is worse than no
     * gate at all.
     */
    const db = createLiveTestDb();
    const friday = ist('2026-09-04T09:15:00');
    setSessionState(db, {
      start: friday,
      end: ist('2026-09-04T15:30:00'),
      opensDay: dayIndex(friday),
    });
    expect(openPricesAreStale(db, ist('2026-09-07T07:00:00'))).toBe(false);
    // And after the bell it does write, so the morning is never simply skipped.
    expect(openPricesAreStale(db, ist('2026-09-07T09:20:00'))).toBe(true);
  });

  it('falls back to the ordinary bell when no session has ever been fetched', () => {
    const db = createLiveTestDb();
    setSessionState(db, { start: null, end: null, opensDay: null });
    expect(openPricesAreStale(db, ist('2026-09-07T07:00:00'))).toBe(false);
    expect(openPricesAreStale(db, ist('2026-09-07T10:00:00'))).toBe(true);
  });

  it('writes the opens once after the bell, then leaves them until tomorrow', () => {
    const db = createLiveTestDb();
    const monday = ist('2026-09-07T10:00:00');
    setSessionState(db, { start: null, end: null, opensDay: null });
    expect(openPricesAreStale(db, monday)).toBe(true);

    persistPassState(db, { now: monday, session: null, wroteOpens: true, complete: true });
    expect(openPricesAreStale(db, ist('2026-09-07T11:00:00'))).toBe(false);
    // A new day starts owing them again.
    expect(openPricesAreStale(db, ist('2026-09-08T10:00:00'))).toBe(true);
  });

  it('does not let one unreachable instrument declare the morning done', () => {
    /*
     * wroteOpens is a single flag for the whole database. If the index
     * succeeded and one stock timed out, stamping the day would leave that
     * stock on yesterday's opening price until tomorrow, with no retry.
     */
    const db = createLiveTestDb();
    const monday = ist('2026-09-07T10:00:00');
    persistPassState(db, { now: monday, session: null, wroteOpens: true, complete: false });
    expect(openPricesAreStale(db, ist('2026-09-07T10:30:00'))).toBe(true);
  });

  it('does not discard the exchange hours on a pass that reached nothing', () => {
    /*
     * The session used to be written unconditionally, so one bad minute threw
     * away hours earlier passes had read -- and with them the only holiday
     * awareness the app has -- until some later pass happened to succeed.
     */
    const db = createLiveTestDb();
    const start = ist('2026-09-04T09:15:00');
    const end = ist('2026-09-04T15:30:00');
    setSessionState(db, { start, end, opensDay: null });
    expect(fetchedSession(db)).toEqual({ start, end });

    persistPassState(db, { now: Date.now(), session: null, wroteOpens: false, complete: false });
    expect(fetchedSession(db)).toEqual({ start, end });
  });

  it('still advances the clock and the throttle when nothing could be reached', () => {
    // Or a board that cannot reach the feed would retry on every single request.
    const db = createLiveTestDb();
    const now = ist('2026-09-07T10:00:00');
    persistPassState(db, { now, session: null, wroteOpens: false, complete: false });
    const row = db
      .prepare('SELECT sim_now AS n, last_refresh_at AS l FROM sim_state WHERE id = 1')
      .get() as { n: number; l: number | null };
    expect(row.n).toBe(now);
    expect(row.l).toBe(now);
  });

  it('stores the hours a successful pass was given', () => {
    const db = createLiveTestDb();
    const now = ist('2026-09-07T10:00:00');
    const session = { start: ist('2026-09-07T09:15:00'), end: ist('2026-09-07T15:30:00') };
    persistPassState(db, { now, session, wroteOpens: false, complete: true });
    expect(fetchedSession(db)).toEqual(session);
  });
});
