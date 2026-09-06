import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID } from '../../src/lib/db/seed';
import { startScenario, tick, simNow } from '../../src/lib/sim/ticker';
import { resetSession } from '../../src/lib/sim/session';
import { evaluateAll } from '../../src/lib/engine/states';
import {
  processTransitions,
  releaseHeldAlerts,
  retractAlertsForCorrection,
  isMarketOpen,
  alertLog,
} from '../../src/lib/alerts/policy';
import { marketSession } from '../../src/lib/api/board';

const USER = DEFAULT_USER_ID;

/**
 * Running the demo twice.
 *
 * D-083 fixed half of this: a reset that adopted the current prices left every
 * trigger already crossed, so a second run sat silent. The clock had exactly the
 * same bug and stayed invisible until the session badge went on screen. Rewind
 * the prices but not the clock and a replay happens after 3:30, where the alert
 * policy correctly refuses to notify — which is indistinguishable from alerting
 * being broken (D-109).
 */

function run(db: Database.Database, scenario: string, ticks: number): number {
  startScenario(db, scenario);
  let sent = 0;
  for (let i = 0; i < ticks; i += 1) {
    const result = tick(db);
    const transitions = evaluateAll(db);
    releaseHeldAlerts(db, USER, result.simNow);
    if (processTransitions(db, USER, transitions, result.simNow).digest) sent += 1;
    for (const c of result.correctedEvents) {
      retractAlertsForCorrection(db, USER, c.symbol, c.eventId, result.simNow);
    }
  }
  return sent;
}

function alertCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number }).n;
}

describe('replaying the demo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(true);
  });

  it('rewinds the clock to the open, not just the prices', () => {
    const openedAt = simNow(db);
    expect(marketSession(openedAt).isOpen).toBe(true);

    // Six compressed hours takes the session past the close.
    run(db, 'away-window', 80);
    expect(isMarketOpen(simNow(db))).toBe(false);

    resetSession(db);
    expect(simNow(db)).toBe(openedAt);
    expect(marketSession(simNow(db)).isOpen).toBe(true);
  });

  it('still alerts on a single-stock shock after a long scenario and a reset', () => {
    // The defect this exists for. Before the fix the clock stayed past 3:30, the
    // policy suppressed every stock alert as MARKET_CLOSED, and the demo's whole
    // contrast — a crash sends nothing, one stock moving alone sends one —
    // quietly stopped working on the second run.
    run(db, 'away-window', 80);
    resetSession(db);
    // Alerts are never deleted here: alert_items references them, and an
    // append-only log that can be truncated is not one. Measure the delta.
    const before = alertCount(db);

    const sent = run(db, 'single-stock-shock', 12);
    expect(sent).toBeGreaterThan(0);
    expect(alertCount(db)).toBeGreaterThan(before);
  });

  it('a crash still sends nothing on the second run', () => {
    run(db, 'market-crash', 12);
    resetSession(db);
    const before = alertCount(db);

    expect(run(db, 'market-crash', 12)).toBe(0);
    expect(alertCount(db)).toBe(before);
  });

  it('leaves the board calm and every card back at WATCHING', () => {
    run(db, 'market-crash', 12);
    const during = db
      .prepare("SELECT COUNT(*) AS n FROM watchlist_items WHERE state = 'NEEDS_REVIEW'")
      .get() as { n: number };
    expect(during.n).toBeGreaterThan(0);

    resetSession(db);

    const after = db
      .prepare(
        `SELECT COUNT(*) AS n FROM watchlist_items
          WHERE removed_at IS NULL AND state != 'WATCHING' AND state != 'FULFILLED'`,
      )
      .get() as { n: number };
    expect(after.n).toBe(0);
  });

  /*
   * D-114, and the reason manual check M5 exists at all.
   *
   * Reset rewound the prices (D-083) and then the clock (D-109) and still left
   * the alert log alone, which is not a cosmetic gap. A notification from the
   * previous run kept the 30-minute global cooldown alive across the reset, so
   * the second pass of the demo was quietly running with alerting disabled. The
   * unit suite could not see it because every test started from a fresh
   * database; only running the whole demo twice in a row exposed it.
   */

  it("does not inherit the previous run's notifications", () => {
    expect(run(db, 'single-stock-shock', 12)).toBe(1);
    expect(alertLog(db, USER, 20).length).toBeGreaterThan(0);

    resetSession(db);

    // A new session starts with nothing to show. The rows still exist -- an
    // append-only log you can truncate is not one -- they belong to a run that
    // is over.
    expect(alertLog(db, USER, 20)).toHaveLength(0);
    const kept = db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number };
    expect(kept.n).toBeGreaterThan(0);
  });

  it('a crash on the second run still sends nothing, and the banner agrees', () => {
    run(db, 'single-stock-shock', 12);
    resetSession(db);

    // The bug on screen: the crash suppressed everything correctly, and the
    // banner underneath still read "1 alert sent" from the run before.
    expect(run(db, 'market-crash', 12)).toBe(0);
    expect(alertLog(db, USER, 20).filter((a) => a.status === 'SENT')).toHaveLength(0);
  });

  it('still retracts on a replay, instead of being swallowed by a stale cooldown', () => {
    run(db, 'single-stock-shock', 12);
    resetSession(db);
    run(db, 'correction', 12);

    const retractions = alertLog(db, USER, 20).filter((a) => a.kind === 'RETRACTION');
    expect(retractions.length).toBeGreaterThan(0);
    expect(retractions[0].title).toContain('has since been corrected');
  });
});
