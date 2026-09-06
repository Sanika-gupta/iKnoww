import type Database from 'better-sqlite3';
import { fetchChart, fetchNav, FeedError } from './client';
import { MFAPI_SCHEME } from './symbols';
import { MIN_USABLE_BARS, backfillSymbol, setSessionOpen } from './backfill';
import { saveStatsForSymbol } from '../engine/stats';
import { ingestPrice, nextSeq } from '../engine/ingest';
import { evaluateAll } from '../engine/states';
import {
  MARKET_OPEN_MIN,
  fetchedSession,
  processTransitions,
  releaseHeldAlerts,
} from '../alerts/policy';
import type { InstrumentType } from '../domain/types';

/**
 * One pass of the live feed: fetch every watched instrument, write the prices,
 * move the clock, and run exactly the pipeline a simulated tick runs.
 *
 * The order below is the same as the tick handler's, and it is the same for the
 * same reasons: cards are evaluated after prices land, held alerts are released
 * at the open before anything new is considered, and the digest is formed once
 * over all of it so a market-wide move cannot become twelve notifications.
 *
 * What is deliberately absent is a server-side timer. The refresh is driven
 * from the browser, like the tick loop (D-085), so there is no background
 * interval to die or double-run on ephemeral hosting.
 */

const DAY_MS = 24 * 60 * 60_000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** Which IST calendar day an instant falls on. */
function istDayIndex(at: number): number {
  return Math.floor((at + IST_OFFSET_MS) / DAY_MS);
}

/**
 * How recently a pass must have run for the next automatic one to be skipped.
 *
 * The reason this exists is arithmetic rather than tidiness. Every open tab
 * refreshes on load and then once a minute, and every pass makes ONE outbound
 * call per instrument. A judge watching eight stocks costs eleven calls a
 * minute per tab; three judges with two tabs each is about sixty-six calls a
 * minute from a single datacenter IP, to an endpoint that already answered us
 * with 429 today. The feature would rate-limit itself in front of exactly the
 * people it was built for.
 *
 * With this, any number of viewers costs one fetch cycle rather than one each,
 * because they all read the same stored board.
 *
 * Five seconds under the client's 60-second interval, and the gap is load
 * bearing in both directions. At 30 seconds two tabs half a minute apart could
 * each fetch, so "at most one call a minute" described a tab rather than the
 * instance. At exactly 60 it would describe nothing: a pass stamps the clock
 * when it finishes, so the next tick arrives a fraction UNDER a minute after
 * that stamp, is skipped, and the effective cadence silently halves to two
 * minutes. The tolerance is what makes a single tab actually refresh every
 * minute while a second one rides along on the same fetch (D-127).
 */
export const AUTO_REFRESH_MIN_AGE_MS = 55_000;

export interface RefreshResult {
  at: number;
  /** True when the throttle served stored prices instead of fetching. */
  skipped: boolean;
  /** Symbols whose price actually moved on, with the observed feed lag. */
  updated: Array<{ symbol: string; price: number; asOf: number; delayMs: number }>;
  /** Symbols the feed refused, with why, so the UI can say so plainly. */
  failed: Array<{ symbol: string; reason: string }>;
  transitions: number;
  alerted: number;
  newDay: boolean;
  session: { start: number; end: number } | null;
  /** The largest observed lag, which is what the badge reports. */
  maxDelayMs: number;
}

/**
 * A new IST calendar day, handled once rather than discovered.
 *
 * Two things have to happen, and the second is the one that would have been a
 * silent bug. The session opens must be rewritten, or every card would report
 * its move against a price from a previous day and call it "today". And the
 * session counter must advance, because everything that asks "have we already
 * interrupted this person" is scoped to it (D-114): in simulated mode a reset
 * bumps it, and live mode has no reset, so without this the alert banner would
 * accumulate every alert ever raised and the 30-minute cooldown would be judged
 * against yesterday.
 *
 * The counter goes UP while the prices go forward, which is the same shape as
 * the simulated reset even though everything else about it is reversed.
 */
function rollDayIfNeeded(db: Database.Database, previousNow: number, now: number): boolean {
  if (istDayIndex(previousNow) === istDayIndex(now)) return false;
  db.prepare('UPDATE sim_state SET session = session + 1 WHERE id = 1').run();
  return true;
}

/**
 * Whether today's opening prices still need writing.
 *
 * Rolling the day and writing the opens are two different events, and treating
 * them as one was a real defect. A refresh at 07:00 rolls the day, but the
 * exchange has not opened, so the feed's "open" is still YESTERDAY's -- and
 * writing it would pin the whole session's reference price to the wrong day.
 * Every card's percentage, every residual, every z-score and therefore the
 * conviction band and the alerting all hang off that number.
 *
 * So the opens are written the first time a pass runs AFTER today's bell, and
 * the day they belong to is recorded, which is what lets an earlier pass
 * decline and a later one pick it up.
 *
 * The first version of this got the "after the bell" part wrong in a way that
 * was worse than the defect it replaced. It compared `now` against the session
 * start left by a PREVIOUS pass without checking that the session was today's,
 * so at 07:00 on a new day the stored start was yesterday's 09:15, `now` was
 * comfortably past it, and the guard waved through exactly the write it exists
 * to prevent -- and then stamped the day, so the 09:20 pass declined and
 * yesterday's open was pinned for the whole session with no retry. A gate that
 * locks in the wrong answer is worse than no gate.
 */
export function openPricesAreStale(db: Database.Database, now: number): boolean {
  const row = db
    .prepare('SELECT session_opens_day AS day, session_start AS start FROM sim_state WHERE id = 1')
    .get() as { day: number | null; start: number | null } | undefined;

  if (row?.day === istDayIndex(now)) return false;

  // Today's bell. The stored session is used only when it IS today's; a stale
  // one says nothing about when this morning starts, so the ordinary weekday
  // opening time stands in. Both are the same value on a normal day, and the
  // fallback is what makes a holiday or a first boot behave.
  const start =
    row?.start != null && istDayIndex(row.start) === istDayIndex(now)
      ? row.start
      : istMidnight(now) + MARKET_OPEN_MIN * 60_000;

  // Before the bell there is no opening price to record yet. Declining keeps
  // yesterday's, which is stale but at least honestly belongs to a named day,
  // and leaves `session_opens_day` unstamped so a later pass tries again.
  return now >= start;
}

/** IST midnight of the day an instant falls in. */
function istMidnight(at: number): number {
  return istDayIndex(at) * DAY_MS - IST_OFFSET_MS;
}

/**
 * Estimates a beta for every instrument that has enough history and does not
 * have one yet.
 *
 * Bounded by construction: it only touches symbols whose statistics are missing
 * or whose stored beta is null. On a healthy board that is no rows at all.
 *
 * It is NOT always nothing, and the exception is worth naming rather than
 * discovering. `MIN_USABLE_BARS` counts a symbol's own returns, while the
 * regression needs 120 returns PAIRED with its reference's. A symbol with two
 * hundred of its own and fewer than a hundred and twenty overlapping -- which
 * is the state while a reference index is still short -- stays a candidate and
 * is recomputed each pass until the reference catches up. That is a covariance
 * over a few hundred numbers, and it is self-limiting, so the cost is worth
 * paying to avoid the alternative: a card stuck on a null beta forever.
 *
 * The order it runs in matters. Statistics are estimated against the
 * reference's returns, so this must run after the pass that fetched them --
 * which is exactly the case it exists to repair: a symbol added before the
 * first index fetch had no reference series to regress against, got a null
 * beta, and nothing ever looked at it again.
 */
function recomputeMissingStats(db: Database.Database): number {
  const pending = db
    .prepare(
      `SELECT i.symbol AS symbol
         FROM instruments i
         JOIN (SELECT symbol, COUNT(*) AS n FROM daily_returns GROUP BY symbol) r
           ON r.symbol = i.symbol
         LEFT JOIN symbol_stats s ON s.symbol = i.symbol
        WHERE i.is_reference = 0
          AND r.n >= ?
          AND (s.symbol IS NULL OR s.beta IS NULL)`,
    )
    .all(MIN_USABLE_BARS) as Array<{ symbol: string }>;

  let fixed = 0;
  for (const row of pending) {
    const stats = saveStatsForSymbol(db, row.symbol);
    if (stats.beta !== null) fixed += 1;
  }
  return fixed;
}

/**
 * What a completed pass writes back, extracted so it can be tested without a
 * network call. Every rule in here was a defect once.
 */
export function persistPassState(
  db: Database.Database,
  state: {
    now: number;
    session: { start: number; end: number } | null;
    wroteOpens: boolean;
    /** True when every instrument was reached. */
    complete: boolean;
  },
): void {
  /*
   * The trading session is written ONLY when this pass actually got one.
   *
   * Writing `session?.start ?? null` unconditionally meant a pass where every
   * fetch failed threw away hours that earlier passes had successfully read --
   * so one bad minute cost the app its exchange-reported hours, and with them
   * its only awareness of exchange holidays, until a later pass happened to
   * succeed. A failure must never be more destructive than doing nothing.
   */
  if (state.session) {
    db.prepare(
      `UPDATE sim_state
          SET sim_now = ?, session_start = ?, session_end = ?, last_refresh_at = ?
        WHERE id = 1`,
    ).run(state.now, state.session.start, state.session.end, state.now);
  } else {
    // The clock and the throttle still advance, or a board that cannot reach
    // the feed would retry on every single request.
    db.prepare('UPDATE sim_state SET sim_now = ?, last_refresh_at = ? WHERE id = 1').run(
      state.now,
      state.now,
    );
  }

  /*
   * The day is stamped only when EVERY instrument was reached.
   *
   * `wroteOpens` is one flag for the whole database, so if the index succeeded
   * and one stock timed out, stamping the day would declare the morning done
   * and leave that stock on yesterday's opening price until tomorrow, with no
   * retry. Requiring a complete pass costs at most one redundant rewrite and
   * removes a way for a single timeout to corrupt a card's percentage for a
   * whole session.
   */
  if (state.wroteOpens && state.complete) {
    db.prepare('UPDATE sim_state SET session_opens_day = ? WHERE id = 1').run(
      istDayIndex(state.now),
    );
  }
}

async function latestFor(
  db: Database.Database,
  symbol: string,
  type: InstrumentType,
): Promise<{ price: number; asOf: number; open: number | null; session: { start: number; end: number } | null }> {
  if (type === 'FUND') {
    const nav = await fetchNav(symbol, MFAPI_SCHEME[symbol]);
    const previous = nav.history[nav.history.length - 2]?.close ?? null;
    return { price: nav.quote.price, asOf: nav.quote.asOf, open: previous, session: null };
  }
  // range=1d is the cheap call: it carries the quote, today's open and the
  // trading period, and none of the two years of history we already stored.
  const chart = await fetchChart(symbol, '1d');
  return { price: chart.quote.price, asOf: chart.quote.asOf, open: chart.open, session: chart.session };
}

export interface RefreshOptions {
  /**
   * Bypass the throttle. Set only for a refresh a person actually asked for:
   * a click is bounded by how fast someone can click, whereas the timer is
   * bounded by nothing. It is also the escape hatch if the feed does start
   * rate-limiting us, which is why the button stays available when the
   * automatic refresh is turned off.
   */
  force?: boolean;
  minAgeMs?: number;
}

export async function refresh(
  db: Database.Database,
  userId: string,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const state = db
    .prepare('SELECT sim_now AS now, last_refresh_at AS last FROM sim_state WHERE id = 1')
    .get() as { now: number; last: number | null } | undefined;
  const previousNow = state?.now ?? Date.now();
  const now = Date.now();

  /*
   * Repairing statistics is local work, not a fetch, so it runs even on a
   * throttled pass. Skipping it with the network is how a symbol added just
   * before its reference arrived would keep a null beta through every
   * subsequent visit -- the throttle would decline to fetch, and declining to
   * fetch would also decline to fix it.
   *
   * It is a single indexed query that returns nothing once the board is
   * healthy, so the cost of running it always is not worth reasoning about.
   */
  recomputeMissingStats(db);

  const minAge = options.minAgeMs ?? AUTO_REFRESH_MIN_AGE_MS;
  // Never skipped on a cold boot: `last` is null until a pass has completed, so
  // the first viewer of a fresh instance always gets real prices.
  if (!options.force && state?.last != null && now - state.last < minAge) {
    return {
      at: now,
      skipped: true,
      updated: [],
      failed: [],
      transitions: 0,
      alerted: 0,
      newDay: false,
      session: fetchedSession(db),
      maxDelayMs: 0,
    };
  }

  const newDay = rollDayIfNeeded(db, previousNow, now);

  const instruments = db
    .prepare(
      `SELECT symbol, instrument_type AS type FROM instruments
        ORDER BY is_reference DESC, symbol ASC`,
    )
    .all() as Array<{ symbol: string; type: InstrumentType }>;

  const updated: RefreshResult['updated'] = [];
  const failed: RefreshResult['failed'] = [];
  let session: RefreshResult['session'] = null;
  const needOpens = openPricesAreStale(db, now);
  let wroteOpens = false;

  for (const inst of instruments) {
    try {
      // A symbol with no history yet -- added while the feed was down, or by a
      // path that could not reach the network -- is backfilled here rather than
      // left inert. A card with no returns can never leave UNKNOWN.
      const hasHistory = (
        db.prepare('SELECT COUNT(*) AS n FROM daily_returns WHERE symbol = ?').get(inst.symbol) as {
          n: number;
        }
      ).n;
      if (hasHistory === 0) {
        const done = await backfillSymbol(db, inst.symbol, inst.type);
        updated.push({
          symbol: inst.symbol,
          price: done.price,
          asOf: done.asOf,
          delayMs: Math.max(0, now - done.asOf),
        });
        if (done.session) session = done.session;
        // backfillSymbol writes the opening price itself, so the bookkeeping
        // has to be told. Without this the first-ever pass leaves
        // session_opens_day unset and the next pass rewrites every open for no
        // reason.
        if (needOpens) wroteOpens = true;
        continue;
      }

      const latest = await latestFor(db, inst.symbol, inst.type);
      if (latest.session) session = latest.session;
      if (needOpens && latest.open !== null) {
        setSessionOpen(db, inst.symbol, latest.open);
        wroteOpens = true;
      }

      const result = ingestPrice(db, {
        symbol: inst.symbol,
        seq: nextSeq(db, inst.symbol),
        price: latest.price,
        asOf: latest.asOf,
      });
      if (result.outcome === 'ACCEPTED' || result.outcome === 'DUPLICATE') {
        updated.push({
          symbol: inst.symbol,
          price: latest.price,
          asOf: latest.asOf,
          delayMs: Math.max(0, now - latest.asOf),
        });
      } else {
        failed.push({ symbol: inst.symbol, reason: result.outcome });
      }
    } catch (err) {
      // One symbol failing must never take the board with it. The rest of the
      // list refreshes, the card keeps its last known price, and the UI says
      // which ones it could not reach.
      failed.push({
        symbol: inst.symbol,
        reason: err instanceof FeedError ? err.kind : 'UNKNOWN',
      });
    }
  }

  // The clock moves only after the prices land, so a card is never evaluated
  // against a "now" that is ahead of the data it is judging.
  persistPassState(db, { now, session, wroteOpens, complete: failed.length === 0 });

  /*
   * F4: anything still without a usable beta gets one now.
   *
   * Statistics used to be computed in exactly one place, the branch that
   * backfills a symbol with no history at all. A symbol whose history landed
   * while its REFERENCE had none yet -- which is every symbol added before the
   * first successful index fetch -- got `beta = null` and kept it forever,
   * because nothing ever looked again. That is the silent failure this module's
   * own docstring warns about: conviction UNKNOWN, every trigger routed to
   * review, and not one alert, on a board that looks entirely healthy.
   */
  recomputeMissingStats(db);

  const transitions = evaluateAll(db);
  releaseHeldAlerts(db, userId, now);
  const outcome = processTransitions(db, userId, transitions, now);

  return {
    at: now,
    skipped: false,
    updated,
    failed,
    transitions: transitions.length,
    alerted: outcome.digest ? outcome.digest.items.length : 0,
    newDay,
    session,
    maxDelayMs: updated.reduce((max, u) => Math.max(max, u.delayMs), 0),
  };
}
