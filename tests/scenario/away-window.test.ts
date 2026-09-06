import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import { startScenario, tick } from '../../src/lib/sim/ticker';
import { evaluateAll } from '../../src/lib/engine/states';
import { processTransitions, releaseHeldAlerts, alertLog } from '../../src/lib/alerts/policy';
import { changesSince, latestSeq, markRead, unreadCount } from '../../src/lib/watchlist/read';
import { DIPS_WATCHLIST_ID } from '../../src/lib/db/demo-seed';

const USER = DEFAULT_USER_ID;

/**
 * Six hours away, and what you come back to.
 *
 * The sharp interaction this file exists for is that alerts and read state are
 * DIFFERENT THINGS, and a careless build conflates them. Seeing a banner is not
 * reading a card. If delivery marked things read, the digest would tell you
 * about a move and the unread badge would vanish in the same breath, so the one
 * card you were told about is the one you can no longer find.
 */

function away(db: Database.Database, ticks: number): number {
  startScenario(db, 'away-window');
  let sent = 0;
  for (let i = 0; i < ticks; i += 1) {
    const result = tick(db);
    const transitions = evaluateAll(db);
    releaseHeldAlerts(db, USER, result.simNow);
    if (processTransitions(db, USER, transitions, result.simNow).digest) sent += 1;
  }
  return sent;
}

function notifiedItemIds(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT te.item_id AS itemId
           FROM thesis_events te
           JOIN alert_items ai ON ai.thesis_event_id = te.id
          WHERE te.notified_at IS NOT NULL`,
      )
      .all() as Array<{ itemId: string }>
  ).map((r) => r.itemId);
}

describe('coming back after six hours away', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(true);
  });

  it('leaves something to come back to, in whichever list it happened in', () => {
    away(db, 24);

    // Both lists are checked rather than just the one on screen, because a list
    // you are NOT looking at is exactly the one that can quietly need you --
    // which is the whole reason the greeting counts attention across every list
    // rather than the current one (D-101).
    const here = changesSince(db, DEFAULT_WATCHLIST_ID);
    const elsewhere = changesSince(db, DIPS_WATCHLIST_ID);
    expect(here.length + elsewhere.length).toBeGreaterThan(0);

    // INFY goes ACTIONABLE partway through and drifts back to WATCHING before
    // the window ends, which is the case this scenario is really about: you come
    // back to a calm card and the only record that anything happened is the
    // alert log and the unread badge. A product that reconciled by re-reading
    // the card would tell you nothing at all.
    const infy = here.filter((c) => c.symbol === 'INFY');
    expect(infy.length).toBeGreaterThan(0);
  });

  it('marks an alerted card notified, never read', () => {
    away(db, 24);
    const alerted = notifiedItemIds(db);
    expect(alerted.length).toBeGreaterThan(0);

    // The whole point: being told about it did not spend the unread badge.
    for (const itemId of alerted) {
      expect(unreadCount(db, itemId)).toBeGreaterThan(0);
    }
  });

  it('clears the badge only when the card itself is opened', () => {
    away(db, 24);
    const [itemId] = notifiedItemIds(db);
    expect(unreadCount(db, itemId)).toBeGreaterThan(0);

    markRead(db, itemId, latestSeq(db, itemId));

    expect(unreadCount(db, itemId)).toBe(0);
    // And only that card. Opening one is not glancing at twelve (D-015).
    const others = notifiedItemIds(db).filter((id) => id !== itemId);
    for (const other of others) {
      expect(unreadCount(db, other)).toBeGreaterThan(0);
    }
  });

  it('reconciles on return: the log says what you were told while away', () => {
    const sent = away(db, 24);
    const log = alertLog(db, USER, 20).filter((a) => a.kind === 'DIGEST');

    expect(log.length).toBe(sent);
    for (const entry of log) {
      // An alert that cannot say what it was about cannot be reconciled against
      // anything, so the body is never allowed to be empty.
      expect(entry.items.length).toBeGreaterThan(0);
      expect(entry.title).not.toBe('');
    }
  });

  it('holds the interruption budget across the whole window', () => {
    // Six compressed hours is twelve possible cooldown windows, and the promise
    // is at most two interruptions an hour however much the market does.
    const sent = away(db, 24);
    expect(sent).toBeLessThanOrEqual(12);
  });

  it('re-reading is idempotent, so a second device changes nothing', () => {
    away(db, 24);
    const [itemId] = notifiedItemIds(db);
    const seq = latestSeq(db, itemId);

    markRead(db, itemId, seq);
    const after = unreadCount(db, itemId);
    // Out of order and repeated, exactly as two devices would send it.
    markRead(db, itemId, seq - 1);
    markRead(db, itemId, seq);

    expect(unreadCount(db, itemId)).toBe(after);
  });
});
