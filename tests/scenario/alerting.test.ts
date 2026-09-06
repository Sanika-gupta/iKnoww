import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import { startScenario, tick, currentPrice } from '../../src/lib/sim/ticker';
import { evaluateAll, conditionMet, HYSTERESIS } from '../../src/lib/engine/states';
import {
  processTransitions,
  releaseHeldAlerts,
  verdictFor,
  inQuietHours,
  isMarketOpen,
  istMinutesOfDay,
  GLOBAL_COOLDOWN_MS,
} from '../../src/lib/alerts/policy';
import { addItem } from '../../src/lib/watchlist/items';
import { ingestPrice, nextSeq } from '../../src/lib/engine/ingest';

const USER = DEFAULT_USER_ID;

function simNow(db: Database.Database): number {
  return (db.prepare('SELECT sim_now AS n FROM sim_state WHERE id = 1').get() as { n: number }).n;
}

function alertCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number }).n;
}

/** One tick of the real pipeline: prices, states, then the alert policy. */
function step(db: Database.Database): ReturnType<typeof processTransitions> {
  const result = tick(db);
  const transitions = evaluateAll(db);
  releaseHeldAlerts(db, USER, result.simNow);
  return processTransitions(db, USER, transitions, result.simNow);
}

describe('the claim the whole design rests on', () => {
  let db: Database.Database;
  let outcomes: ReturnType<typeof processTransitions>[];

  beforeEach(() => {
    db = createTestDb(true);
    startScenario(db, 'market-crash');
    outcomes = [];
    for (let i = 0; i < 12; i++) outcomes.push(step(db));
  });

  it('sends no notification at all during a market-wide crash', () => {
    // Six cards move, three theses trigger, and the phone stays silent. A naive
    // build sends one push per state change, which is twelve notifications and
    // exactly the panic the rest of this design argues against.
    expect(alertCount(db)).toBe(0);
  });

  it('suppresses those triggers for the stated reason, not by accident', () => {
    const reasons = outcomes.flatMap((o) => o.suppressed.map((s) => s.reason));
    expect(reasons).toContain('LOW_CONVICTION');
  });

  it('still changes the cards, because silence is not concealment', () => {
    const review = db
      .prepare("SELECT COUNT(*) AS n FROM watchlist_items WHERE state = 'NEEDS_REVIEW'")
      .get() as { n: number };
    expect(review.n).toBeGreaterThanOrEqual(2);
  });
});

describe('a single-stock shock is the one that earns attention', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(true);
    startScenario(db, 'single-stock-shock');
    for (let i = 0; i < 8; i++) step(db);
  });

  it('produces exactly one digest', () => {
    expect(alertCount(db)).toBe(1);
  });

  it('carries the conviction in the body, not just the fact of a move', () => {
    // A generic broker alert says "DIVISLAB is up 6%". Ours has to say why that
    // matters, in the twelve words a lock screen allows.
    const row = db.prepare('SELECT body FROM alerts ORDER BY id DESC LIMIT 1').get() as {
      body: string;
    };
    const body = JSON.parse(row.body) as { title: string; items: Array<{ headline: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].headline).toContain('DIVISLAB');
    expect(body.items[0].headline).toMatch(/on its own|its normal|nothing in your thesis/i);
  });

  it('marks the event notified but leaves the card unread', () => {
    // Seeing a banner on a lock screen is not reading the card. The unread badge
    // has to survive delivery, or the two systems quietly contradict each other.
    const notified = db
      .prepare('SELECT COUNT(*) AS n FROM thesis_events WHERE notified_at IS NOT NULL')
      .get() as { n: number };
    expect(notified.n).toBe(1);

    const unread = db
      .prepare(
        `SELECT COUNT(*) AS n FROM thesis_events te
           LEFT JOIN read_state rs ON rs.item_id = te.item_id
          WHERE te.notified_at IS NOT NULL AND te.id > COALESCE(rs.last_seen_seq, 0)`,
      )
      .get() as { n: number };
    expect(unread.n).toBe(1);
  });
});

describe('twelve transitions become one digest', () => {
  it('coalesces everything eligible in one pass into a single alert', () => {
    const db = createTestDb(true);
    const now = simNow(db);

    // Force many simultaneous, genuinely alertable moves by shocking every
    // stock idiosyncratically while the market stays put.
    for (const s of ['TCS', 'INFY', 'RELIANCE', 'HDFCBANK', 'DIVISLAB']) {
      ingestPrice(db, {
        symbol: s,
        seq: nextSeq(db, s),
        price: currentPrice(db, s)! * 1.08,
        asOf: now,
      });
    }
    const transitions = evaluateAll(db, now);
    const outcome = processTransitions(db, USER, transitions, now);

    expect(transitions.length).toBeGreaterThanOrEqual(3);
    expect(alertCount(db)).toBe(1);
    expect(outcome.digest!.items.length).toBe(transitions.filter((t) => t.to !== 'WATCHING').length);
    expect(outcome.digest!.title).toMatch(/items need your attention/);
  });
});

describe('at most two interruptions an hour, whatever the market does', () => {
  let db: Database.Database;
  let now: number;

  beforeEach(() => {
    db = createTestDb(true);
    now = simNow(db);
    ingestPrice(db, {
      symbol: 'DIVISLAB',
      seq: nextSeq(db, 'DIVISLAB'),
      price: currentPrice(db, 'DIVISLAB')! * 1.08,
      asOf: now,
    });
    processTransitions(db, USER, evaluateAll(db, now), now);
  });

  it('sends the first one', () => {
    expect(alertCount(db)).toBe(1);
  });

  it('swallows a second inside the cooldown', () => {
    const later = now + 5 * 60 * 1000;
    ingestPrice(db, {
      symbol: 'TCS',
      seq: nextSeq(db, 'TCS'),
      price: currentPrice(db, 'TCS')! * 1.08,
      asOf: later,
    });
    const outcome = processTransitions(db, USER, evaluateAll(db, later), later);

    expect(alertCount(db)).toBe(1);
    expect(outcome.heldByCooldown).toBeGreaterThan(0);
  });

  it('allows the next one after the cooldown expires', () => {
    const later = now + GLOBAL_COOLDOWN_MS + 1000;
    ingestPrice(db, {
      symbol: 'TCS',
      seq: nextSeq(db, 'TCS'),
      price: currentPrice(db, 'TCS')! * 1.08,
      asOf: later,
    });
    processTransitions(db, USER, evaluateAll(db, later), later);
    expect(alertCount(db)).toBe(2);
  });
});

describe('an oscillating price does not flap', () => {
  it('fires once, not eight times, for a price jittering on its trigger', () => {
    // A bare comparison would fire, unfire and refire on every tick. The
    // condition is a Schmitt trigger: armed at the threshold, disarmed only once
    // the price has come back a quarter of a percent past it (D-087).
    const threshold = 3800;
    let met = false;
    let flips = 0;
    // Eight ticks resting on the threshold, jittering by a hundredth of a percent.
    for (const price of [3799.9, 3800.1, 3799.8, 3800.2, 3799.7, 3800.3, 3799.9, 3800.1]) {
      const next = conditionMet('DIP_BUY', { threshold }, price, met);
      if (next !== met) flips++;
      met = next;
    }
    expect(flips).toBe(1);
    expect(met).toBe(true);
  });

  it('does release once the price genuinely recovers past the band', () => {
    const threshold = 3800;
    const justOutside = threshold * (1 + HYSTERESIS) + 1;
    expect(conditionMet('DIP_BUY', { threshold }, justOutside, true)).toBe(false);
  });
});

describe('quiet hours hold rather than drop', () => {
  it('knows when it is quiet, wrapping past midnight', () => {
    const night = Date.parse('2026-09-04T23:00:00+05:30');
    const morning = Date.parse('2026-09-04T10:00:00+05:30');
    expect(inQuietHours(night, 1290, 450)).toBe(true);
    expect(inQuietHours(morning, 1290, 450)).toBe(false);
  });

  it('reads the clock in IST, not UTC', () => {
    expect(istMinutesOfDay(Date.parse('2026-09-04T09:15:00+05:30'))).toBe(9 * 60 + 15);
  });

  it('holds an alert raised at night and delivers it at the open', () => {
    // Quiet hours are a FUND concern in practice: stock market hours never
    // overlap them, so a stock is already suppressed as MARKET_CLOSED. A NAV
    // published late is exactly the case this rule exists for.
    const db = createTestDb(true);
    const night = Date.parse('2026-09-04T23:10:00+05:30');
    ingestPrice(db, {
      symbol: 'UTI_NIFTY50',
      seq: nextSeq(db, 'UTI_NIFTY50'),
      price: currentPrice(db, 'UTI_NIFTY50')! * 1.08,
      asOf: night,
    });
    processTransitions(db, USER, evaluateAll(db, night), night);

    const held = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'HELD_QUIET_HOURS'").get() as {
      n: number;
    };
    expect(held.n).toBe(1);

    const morning = Date.parse('2026-09-05T08:00:00+05:30');
    expect(releaseHeldAlerts(db, USER, morning)).toBe(1);
    const sent = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'SENT'").get() as {
      n: number;
    };
    expect(sent.n).toBe(1);
  });

  it('does not release an alert the clock has rewound past', () => {
    /*
     * The right rule, and it took a shipped bug to find it.
     *
     * This was written as "do not release an alert from a previous session",
     * by analogy with the alert log and the cooldown (D-114). That is wrong,
     * and wrong in the one case it was written for: quiet hours run 21:30 to
     * 07:30, so an alert held overnight ALWAYS crosses an IST day boundary,
     * and live mode advances the session on exactly that boundary. The alert
     * it was meant to deliver at the open was the only one it could never
     * deliver. Verified: released 0, still held 1.
     *
     * What the session filter was reaching for is D-109's predicate. After a
     * simulated reset the clock rewinds, so the previous run's alerts are
     * stamped in the FUTURE, and an alert that has not happened yet cannot be
     * delivered. A clock that moved forward -- every live day -- releases
     * normally, which the test below this one asserts.
     */
    const db = createTestDb(true);
    const later = Date.parse('2026-09-04T22:00:00+05:30');
    db.prepare(
      `INSERT INTO alerts (user_id, kind, body, channel, status, created_at, session)
       VALUES (?, 'DIGEST', '{}', 'IN_APP', 'HELD_QUIET_HOURS', ?, 0)`,
    ).run(USER, later);

    // The clock is rewound behind that alert, which is what a reset does.
    const rewound = Date.parse('2026-09-04T09:15:00+05:30');
    expect(releaseHeldAlerts(db, USER, rewound)).toBe(0);
    const stillHeld = db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'HELD_QUIET_HOURS'")
      .get() as { n: number };
    expect(stillHeld.n).toBe(1);
  });

  it('releases an alert held overnight, even though the session advanced', () => {
    // The live case the session filter broke. Quiet hours cross midnight by
    // definition, and a new IST day bumps the session, so this is not an edge
    // case: it is every single overnight alert live mode would ever hold.
    const db = createTestDb(true);
    const night = Date.parse('2026-09-04T22:00:00+05:30');
    db.prepare(
      `INSERT INTO alerts (user_id, kind, body, channel, status, created_at, session)
       VALUES (?, 'DIGEST', '{}', 'IN_APP', 'HELD_QUIET_HOURS', ?, 0)`,
    ).run(USER, night);
    db.prepare('UPDATE sim_state SET session = session + 1 WHERE id = 1').run();

    const morning = Date.parse('2026-09-05T08:00:00+05:30');
    expect(releaseHeldAlerts(db, USER, morning)).toBe(1);
    const sent = db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'SENT'")
      .get() as { n: number };
    expect(sent.n).toBe(1);
  });
});

describe('market hours', () => {
  it('knows the session', () => {
    expect(isMarketOpen(Date.parse('2026-09-04T10:00:00+05:30'))).toBe(true);
    expect(isMarketOpen(Date.parse('2026-09-04T18:00:00+05:30'))).toBe(false);
  });
});

describe('the system stays quiet when it does not know', () => {
  it('never alerts on a stale price', () => {
    const db = createTestDb(true);
    const now = simNow(db);
    const transition = {
      itemId: 'x',
      symbol: 'TCS',
      instrumentType: 'STOCK' as const,
      from: 'WATCHING' as const,
      to: 'ACTIONABLE' as const,
      reason: 'r',
      review: null,
      eventId: 1,
      conviction: {
        band: 'HIGH' as const,
        z: 1.5,
        shareReference: 0.2,
        beta: 1,
        referenceSymbol: 'NIFTY50',
        referenceReturn: 0.001,
        instrumentReturn: 0.02,
        explanation: 'x',
        stale: true,
      },
    };
    expect(verdictFor(transition, now)).toEqual({ alert: false, reason: 'STALE_PRICE' });
  });

  it('never alerts on a card it could not compute conviction for', () => {
    const db = createTestDb(true);
    const now = simNow(db);
    const id = addItem(db, {
      userId: USER,
      watchlistId: DEFAULT_WATCHLIST_ID,
      symbol: 'ITC',
      thesisType: 'DIP_BUY',
      params: { threshold: Math.round(currentPrice(db, 'ITC')! * 1.05) },
    });
    expect(id.ok).toBe(true);
    // Wipe the statistics so conviction degrades to UNKNOWN.
    db.prepare("DELETE FROM symbol_stats WHERE symbol = 'ITC'").run();
    ingestPrice(db, {
      symbol: 'ITC',
      seq: nextSeq(db, 'ITC'),
      price: currentPrice(db, 'ITC')! * 1.02,
      asOf: now,
    });
    const before = alertCount(db);
    processTransitions(db, USER, evaluateAll(db, now), now);
    // An UNKNOWN trigger routes to NEEDS_REVIEW-unverifiable, which never alerts.
    expect(alertCount(db)).toBe(before);
  });
});
