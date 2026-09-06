import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID } from '../../src/lib/db/seed';
import { startScenario, tick, simNow, currentPrice } from '../../src/lib/sim/ticker';
import { evaluateAll } from '../../src/lib/engine/states';
import {
  processTransitions,
  releaseHeldAlerts,
  retractAlertsForCorrection,
  alertLog,
} from '../../src/lib/alerts/policy';
import { ingestPrice, ingestCorrection, nextSeq } from '../../src/lib/engine/ingest';

const USER = DEFAULT_USER_ID;

/**
 * A wrong alert is never left standing.
 *
 * The scenario button promises, in the user's own words on screen, that the
 * state rolls back and the alert is retracted "rather than quietly dropped".
 * Until this file existed the first half was true by accident and the second
 * half was not true at all: the schema allowed a RETRACTION and nothing ever
 * wrote one. A promise the product makes on screen and cannot keep is worse
 * than a feature it never claimed.
 */

/** Runs the loop the /api/sim route runs, including the retraction step. */
function step(db: Database.Database): { sent: number; retracted: number } {
  const result = tick(db);
  const transitions = evaluateAll(db);
  releaseHeldAlerts(db, USER, result.simNow);
  const sent = processTransitions(db, USER, transitions, result.simNow).digest ? 1 : 0;
  let retracted = 0;
  for (const c of result.correctedEvents) {
    retracted += retractAlertsForCorrection(db, USER, c.symbol, c.eventId, result.simNow).length;
  }
  return { sent, retracted };
}

function run(db: Database.Database, scenario: string, ticks: number) {
  startScenario(db, scenario);
  let sent = 0;
  let retracted = 0;
  for (let i = 0; i < ticks; i += 1) {
    const r = step(db);
    sent += r.sent;
    retracted += r.retracted;
  }
  return { sent, retracted };
}

function retractions(db: Database.Database) {
  return alertLog(db, USER, 50).filter((a) => a.kind === 'RETRACTION');
}

/** A bad print big enough to alert, then the correction that undoes it. */
function badPrintThenCorrection(db: Database.Database, symbol: string) {
  const at = simNow(db);
  const good = currentPrice(db, symbol)!;
  const bad = ingestPrice(db, {
    symbol,
    seq: nextSeq(db, symbol),
    price: good * 0.9,
    asOf: at,
  });
  expect(bad.outcome).toBe('ACCEPTED');

  const transitions = evaluateAll(db);
  const digest = processTransitions(db, USER, transitions, at).digest;

  const fix = ingestCorrection(db, {
    symbol,
    correctsEventId: bad.eventId!,
    price: good,
    asOf: at,
  });
  expect(fix.outcome).toBe('ACCEPTED');
  evaluateAll(db);

  return { badEventId: bad.eventId!, digest, at };
}

describe('a corrected price', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(true);
  });

  it('rolls the card back off the bad print', () => {
    const before = db
      .prepare("SELECT state FROM watchlist_items WHERE symbol = 'TCS' LIMIT 1")
      .get() as { state: string };

    const { badEventId } = badPrintThenCorrection(db, 'TCS');

    // The correction is the newest print, so it is what the card is evaluated on.
    const after = db
      .prepare("SELECT state FROM watchlist_items WHERE symbol = 'TCS' LIMIT 1")
      .get() as { state: string };
    expect(after.state).toBe(before.state);

    // History is never truncated: the wrong transition is still in the log.
    const stranded = db
      .prepare('SELECT COUNT(*) AS n FROM thesis_events WHERE price_event_id = ?')
      .get(badEventId) as { n: number };
    expect(stranded.n).toBeGreaterThan(0);
  });

  it('retracts an alert that the bad print caused', () => {
    const { badEventId, digest, at } = badPrintThenCorrection(db, 'TCS');
    expect(digest).not.toBeNull();

    const out = retractAlertsForCorrection(db, USER, 'TCS', badEventId, at);

    expect(out).toHaveLength(1);
    expect(out[0].retractsAlertId).toBe(digest!.alertId);
    expect(out[0].title).toContain('TCS');
    expect(out[0].title).toContain('has since been corrected');

    const log = retractions(db);
    expect(log).toHaveLength(1);
    expect(log[0].retractsAlertId).toBe(digest!.alertId);
    expect(log[0].status).toBe('SENT');
  });

  it('marks the overtaken transition superseded rather than deleting it', () => {
    const { badEventId, at } = badPrintThenCorrection(db, 'TCS');
    retractAlertsForCorrection(db, USER, 'TCS', badEventId, at);

    // Only the transition the bad print caused is superseded. The rollback is
    // stamped with the CORRECTION, not with the print it undoes, so it is not
    // swept up here — which is the whole point of D-110.
    const rows = db
      .prepare('SELECT id, superseded_by AS by FROM thesis_events WHERE price_event_id = ?')
      .all(badEventId) as Array<{ id: number; by: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].by).not.toBeNull();
  });

  it('apologises once, however many times a scenario is replayed', () => {
    const { badEventId, at } = badPrintThenCorrection(db, 'TCS');
    retractAlertsForCorrection(db, USER, 'TCS', badEventId, at);
    retractAlertsForCorrection(db, USER, 'TCS', badEventId, at);
    retractAlertsForCorrection(db, USER, 'TCS', badEventId, at);

    // An apology delivered three times is its own kind of noise.
    expect(retractions(db)).toHaveLength(1);
  });

  it('retracts nothing when the bad print never earned an alert', () => {
    // A card can roll back without ever having been worth interrupting anyone
    // for. There is nothing to take back, so nothing is sent.
    const at = simNow(db);
    const good = currentPrice(db, 'RELIANCE')!;
    const bad = ingestPrice(db, {
      symbol: 'RELIANCE',
      seq: nextSeq(db, 'RELIANCE'),
      price: good * 1.001,
      asOf: at,
    });
    evaluateAll(db);
    ingestCorrection(db, {
      symbol: 'RELIANCE',
      correctsEventId: bad.eventId!,
      price: good,
      asOf: at,
    });

    expect(retractAlertsForCorrection(db, USER, 'RELIANCE', bad.eventId!, at)).toHaveLength(0);
    expect(retractions(db)).toHaveLength(0);
  });

  it('runs the whole correction scenario end to end', () => {
    const { retracted } = run(db, 'correction', 12);
    // The scenario is the demo, so whatever it does must at least be coherent:
    // every retraction points at a real delivered alert, and none is orphaned.
    const log = alertLog(db, USER, 50);
    const sentIds = new Set(log.filter((a) => a.kind === 'DIGEST').map((a) => a.id));
    for (const r of log.filter((a) => a.kind === 'RETRACTION')) {
      expect(r.retractsAlertId).not.toBeNull();
      expect(sentIds.has(r.retractsAlertId!)).toBe(true);
    }
    expect(retracted).toBe(log.filter((a) => a.kind === 'RETRACTION').length);
  });
});
