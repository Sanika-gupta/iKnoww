import type Database from 'better-sqlite3';
import { ingestPrice, nextSeq } from '../engine/ingest';
import { evaluateAll } from '../engine/states';

/**
 * Rewinds to the start of the trading day.
 *
 * The demo has to run twice in a row from a cold start (manual check M5), and a
 * judge will want to try a second scenario after the first. This republishes
 * every instrument at its opening price and puts the tick counter back to zero,
 * so a replayed scenario follows an identical path rather than a merely similar
 * one.
 *
 * What it does NOT do is delete anything. The rewind is expressed as new price
 * events appended to the log, not as an edit of the old ones. An append-only log
 * that can be silently truncated is not an append-only log, and the correction
 * and retraction machinery both depend on history surviving.
 *
 * The first version of this adopted whatever the prices happened to be rather
 * than the opening ones, which looked right until the demo was run a second
 * time: every card had already crossed its trigger, so nothing could cross it
 * again and the whole board sat silent (D-083).
 *
 * The clock had the same bug for the same reason, and it stayed invisible until
 * the session badge was put on screen. Rewinding the prices while letting the
 * simulated clock run on left the board showing opening prices under a "Closed"
 * badge, and worse: the alert policy suppresses stock alerts outside market
 * hours, so running the single-stock shock after the six-hour scenario sent
 * NOTHING rather than exactly one notification. The demo's central contrast
 * broke silently. A rewind has to rewind the clock too (D-109).
 */
export function resetSession(db: Database.Database): void {
  const opens = db.prepare('SELECT symbol, open_price AS openPrice FROM session_opens').all() as
    | Array<{ symbol: string; openPrice: number }>;

  // The instant the session opened, recovered from the seeded price events:
  // those are written at seq 0, and every later event including a rewind uses
  // nextSeq. So the open needs no extra column to remember it.
  const opened = db
    .prepare('SELECT as_of AS at FROM price_events WHERE seq = 0 ORDER BY id ASC LIMIT 1')
    .get() as { at: number } | undefined;
  const sim = db.prepare('SELECT sim_now AS simNow FROM sim_state WHERE id = 1').get() as
    | { simNow: number }
    | undefined;
  const now = opened?.at ?? sim?.simNow ?? Date.now();

  db.transaction(() => {
    for (const o of opens) {
      ingestPrice(db, {
        symbol: o.symbol,
        seq: nextSeq(db, o.symbol),
        price: o.openPrice,
        asOf: now,
      });
    }

    // Tick zero AND the clock back to the open, so a replayed scenario draws the
    // same random numbers at the same time of day. Without the clock, a replay
    // after a long scenario runs after hours and the alert policy correctly
    // refuses to notify, which looks exactly like alerting being broken.
    // The session counter goes UP while everything else goes back, because it is
    // the one thing that must not repeat. Alerts are stamped with it, so the
    // previous run's notifications stop counting against the cooldown and stop
    // appearing in the banner, without a single row being deleted (D-114).
    db.prepare(
      `UPDATE sim_state
          SET scenario = NULL, scenario_tick = 0, tick = 0, sim_now = ?, session = session + 1
        WHERE id = 1`,
    ).run(now);

    const items = db
      .prepare(
        `SELECT id, state FROM watchlist_items
          WHERE removed_at IS NULL AND state != 'WATCHING' AND state != 'FULFILLED'`,
      )
      .all() as Array<{ id: string; state: string }>;

    for (const item of items) {
      db.prepare(
        `INSERT INTO thesis_events (item_id, from_state, to_state, reason, conviction, at)
         VALUES (?, ?, 'WATCHING', 'New session. Back to today''s opening prices.', '{}', ?)`,
      ).run(item.id, item.state, now);
      db.prepare("UPDATE watchlist_items SET state = 'WATCHING' WHERE id = ?").run(item.id);
    }
  })();

  // A thesis can be met at the open, so settle every card before anyone looks at
  // it. Same reasoning as evaluating on add (D-078): the range query only finds
  // thresholds the price has just crossed, and nothing crossed during a rewind.
  evaluateAll(db, now);

  // A reset is the user's own action, so whatever it produced is already seen.
  const maxEvent = db.prepare('SELECT MAX(id) AS m FROM thesis_events').get() as {
    m: number | null;
  };
  db.prepare(
    `INSERT INTO read_state (item_id, last_seen_seq)
     SELECT id, ? FROM watchlist_items WHERE removed_at IS NULL
     ON CONFLICT (item_id) DO UPDATE SET last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq)`,
  ).run(maxEvent.m ?? 0);
}
