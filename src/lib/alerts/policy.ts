import type Database from 'better-sqlite3';
import { ALERTABLE_STATES, type ItemState } from '../domain/types';
import type { Transition } from '../engine/states';

/**
 * Whether we are allowed to interrupt someone.
 *
 * This is the sharpest idea in the product, and it is one sentence:
 *
 *   A low-conviction trigger changes the card but is never allowed to ring your
 *   phone. If we are not sure the move is about your instrument, we are not
 *   entitled to your attention.
 *
 * Note what does NOT exist here: an alert-configuration screen, a "notify me
 * when price crosses X", any second rule engine. You configure theses, and the
 * thesis IS the alert rule. That keeps alerting an input to the existing
 * definition of "what matters" rather than a competing answer to it (D-028).
 *
 * Every rule below is expressed in SIMULATED time, read from the clock the
 * scenarios drive. Using wall-clock time would make a compressed six-hour
 * scenario finish inside one real minute and so inside one real cooldown, and
 * the whole policy would look like it worked when it had simply never been
 * exercised.
 */

/**
 * Which run of the demo we are in.
 *
 * Reset rewinds the prices, the tick counter and the clock (D-083, D-109), and
 * for two blocks it did not rewind the alert log. That is not a cosmetic gap:
 * a notification from the previous run kept the 30-minute global cooldown alive
 * across the reset, so on a second pass the correction scenario's bad tick was
 * suppressed and no retraction was ever issued -- the scenario built to
 * demonstrate integrity quietly doing nothing. And the banner still counted that
 * stale alert, so the crash screen read "1 alert sent" underneath a narration
 * saying we send nothing.
 *
 * Alerts are NOT deleted, because an append-only log you can truncate is not
 * one, and alert_items references them. They are stamped with the session they
 * were raised in, and everything that asks "have we interrupted this person"
 * asks about the session actually being demonstrated. Same principle as D-082:
 * the log keeps everything, the screen shows what is true now.
 */
export function currentSession(db: Database.Database): number {
  const row = db.prepare('SELECT session FROM sim_state WHERE id = 1').get() as
    | { session: number }
    | undefined;
  return row?.session ?? 0;
}

export const COALESCE_WINDOW_MS = 60 * 1000;
/**
 * How old a held alert may be and still be worth delivering. Quiet hours run at
 * most ten hours, so a day is generous; past that it is history rather than
 * news someone is waiting for.
 */
export const HELD_ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const GLOBAL_COOLDOWN_MS = 30 * 60 * 1000;

/** IST, as minutes past midnight. The market and the quiet hours both use it. */
export const MARKET_OPEN_MIN = 9 * 60 + 15;
export const MARKET_CLOSE_MIN = 15 * 60 + 30;
const IST_OFFSET_MIN = 5 * 60 + 30;

export function istMinutesOfDay(epochMs: number): number {
  const utcMinutes = Math.floor(epochMs / 60000);
  return ((utcMinutes + IST_OFFSET_MIN) % 1440 + 1440) % 1440;
}

/** 12-hour IST wall time. Shared with the session badge so both read alike. */
export function clockTime(minutesOfDay: number): string {
  const h24 = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** IST day of week, 0 = Sunday. Arithmetic, for the same reason as the minutes. */
export function istDayOfWeek(epochMs: number): number {
  return new Date(epochMs + IST_OFFSET_MIN * 60_000).getUTCDay();
}

export function isWeekend(epochMs: number): boolean {
  const d = istDayOfWeek(epochMs);
  return d === 0 || d === 6;
}

/**
 * The trading session as the exchange itself reports it, when we have it.
 *
 * Live mode fetches `currentTradingPeriod` from the feed on every refresh and
 * stores it on the sim_state row. It is worth the trouble because it answers
 * three questions at once with no hardcoded knowledge: what today's hours are,
 * whether today is a trading day at all, and therefore whether weekends AND
 * exchange holidays are trading days. On a Saturday the period still points at
 * Friday's session, so "now" simply falls outside it.
 *
 * Null in simulated mode and whenever the fetch has not succeeded, in which
 * case the weekday rule below applies and the badge says it is assuming.
 */
export interface TradingSession {
  start: number;
  end: number;
}

export function fetchedSession(db: Database.Database): TradingSession | null {
  const row = db
    .prepare('SELECT session_start AS s, session_end AS e FROM sim_state WHERE id = 1')
    .get() as { s: number | null; e: number | null } | undefined;
  if (!row || row.s === null || row.e === null) return null;
  return { start: row.s, end: row.e };
}

/**
 * The one predicate. The session badge, the alert policy's MARKET_CLOSED
 * suppression and both order-timing rules all read this, so they cannot
 * disagree with each other on any minute of any day (D-107).
 *
 * Weekends were deliberately unhandled while the only session was a simulated
 * Friday. Live mode runs on the real clock, where a Saturday is an ordinary
 * occurrence, so the calendar now lives here rather than in the badge, which is
 * exactly where D-107 said it would belong if it were ever wanted.
 */
export function isMarketOpen(epochMs: number, session?: TradingSession | null): boolean {
  // The exchange's own answer wins whenever we have it.
  if (session) return epochMs >= session.start && epochMs < session.end;
  if (isWeekend(epochMs)) return false;
  const m = istMinutesOfDay(epochMs);
  return m >= MARKET_OPEN_MIN && m <= MARKET_CLOSE_MIN;
}

/** Quiet hours wrap past midnight, so the comparison has to as well. */
export function inQuietHours(epochMs: number, startMin: number, endMin: number): boolean {
  const m = istMinutesOfDay(epochMs);
  return startMin <= endMin ? m >= startMin && m < endMin : m >= startMin || m < endMin;
}

export type SuppressionReason =
  | 'LOW_CONVICTION'
  | 'STATE_NOT_ALERTABLE'
  | 'STALE_PRICE'
  | 'MARKET_CLOSED';

export interface Verdict {
  alert: boolean;
  reason: SuppressionReason | 'ALERTABLE';
}

/**
 * Does this one transition deserve someone's attention?
 *
 * ACTIONABLE and UNEXPLAINED do. NEEDS_REVIEW does only when it is CONFOUNDED:
 * a shock the thesis never contemplated is worth knowing about, whereas a
 * diluted trigger is precisely the case we refuse to shout about.
 */
export function verdictFor(t: Transition, simNow: number, session?: TradingSession | null): Verdict {
  if (t.conviction.stale) return { alert: false, reason: 'STALE_PRICE' };

  const alertableState = ALERTABLE_STATES.has(t.to as ItemState);
  const confounded = t.to === 'NEEDS_REVIEW' && t.review === 'CONFOUNDED';
  if (!alertableState && !confounded) {
    // The diluted trigger lands here, and this single line is the product's
    // most contrarian behaviour: the card changed, and the phone stayed silent.
    return {
      alert: false,
      reason: t.to === 'NEEDS_REVIEW' ? 'LOW_CONVICTION' : 'STATE_NOT_ALERTABLE',
    };
  }

  // A stock cannot meaningfully alert outside market hours. A fund can: its NAV
  // publishes after the close, and that is the normal case rather than an
  // anomaly. This is the same type-awareness as the freshness gate (D-025), and
  // it reads the instrument type off the transition rather than guessing it from
  // the shape of the symbol.
  if (t.instrumentType === 'STOCK' && !isMarketOpen(simNow, session)) {
    return { alert: false, reason: 'MARKET_CLOSED' };
  }

  return { alert: true, reason: 'ALERTABLE' };
}

// ------------------------------------------------------------------ delivery

export interface DigestItem {
  itemId: string;
  symbol: string;
  state: ItemState;
  headline: string;
}

export interface Digest {
  alertId: number;
  status: 'SENT' | 'HELD_QUIET_HOURS';
  title: string;
  items: DigestItem[];
}

export interface AlertOutcome {
  digest: Digest | null;
  considered: number;
  suppressed: Array<{ symbol: string; reason: SuppressionReason }>;
  /** Set when eligible transitions existed but the cooldown swallowed them. */
  heldByCooldown: number;
}

/**
 * When we last interrupted this user, as of `now`.
 *
 * The `created_at <= now` guard is not defensive noise. The cooldown asks how
 * long it has been since we last spent someone's attention, and an alert that
 * has not happened yet on the current clock cannot have spent anything. Without
 * it, rewinding the simulated session (D-109) leaves every alert from the
 * previous run stamped in the future, the subtraction goes negative, and the
 * cooldown silently suppresses everything for the rest of the demo. A real
 * clock never goes backwards; a replayable one does, and this is the price.
 */
function lastAlertAt(db: Database.Database, userId: string, now: number): number | null {
  const session = currentSession(db);
  const row = db
    .prepare(
      `SELECT created_at AS at FROM alerts
        WHERE user_id = ? AND kind = 'DIGEST' AND created_at <= ? AND session = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, now, session) as { at: number } | undefined;
  return row?.at ?? null;
}

/** One line on a lock screen has to justify itself in about twelve words. */
function headlineFor(t: Transition): string {
  const share = t.conviction.shareReference;
  const own = share === null ? null : Math.round((1 - share) * 100);

  if (t.to === 'UNEXPLAINED') {
    const z = t.conviction.z === null ? '' : ` ${Math.abs(t.conviction.z).toFixed(1)}x its normal,`;
    return `${t.symbol} moved on its own,${z} and nothing in your thesis covers it`;
  }
  if (t.to === 'NEEDS_REVIEW') {
    return `${t.symbol} hit your trigger, but this is a shock rather than a drift`;
  }
  return own === null
    ? `${t.symbol} hit your trigger`
    : `${t.symbol} hit your trigger, and it is the stock, not the market (${own}% its own)`;
}

/**
 * Turns a tick's worth of transitions into at most one notification.
 *
 * Every alert is a digest, even a digest of one. That collapses deduplication
 * and batching into a single mechanism, and it caps notification volume by
 * design rather than by luck: at most two interruptions an hour, no matter what
 * the market does. A naive build sends one push per state change, which on a
 * market-wide fall means twelve notifications, and we would have spent the whole
 * design arguing against panic and then manufactured it (D-030).
 */
export function processTransitions(
  db: Database.Database,
  userId: string,
  transitions: Transition[],
  simNow: number,
): AlertOutcome {
  const suppressed: AlertOutcome['suppressed'] = [];
  const eligible: Transition[] = [];
  // Read once for the whole batch: it is the same session for every transition
  // in one tick, and this is on the hot path.
  const session = fetchedSession(db);

  for (const t of transitions) {
    const verdict = verdictFor(t, simNow, session);
    if (verdict.alert) eligible.push(t);
    else suppressed.push({ symbol: t.symbol, reason: verdict.reason as SuppressionReason });
  }

  if (eligible.length === 0) {
    return { digest: null, considered: transitions.length, suppressed, heldByCooldown: 0 };
  }

  const last = lastAlertAt(db, userId, simNow);
  if (last !== null && simNow - last < GLOBAL_COOLDOWN_MS) {
    // Deliberately dropped rather than queued. The card already changed and the
    // digest on next open will reconcile it, so nothing is lost; what is refused
    // is a second interruption inside half an hour.
    return {
      digest: null,
      considered: transitions.length,
      suppressed,
      heldByCooldown: eligible.length,
    };
  }

  const user = db
    .prepare('SELECT quiet_hours_start AS qs, quiet_hours_end AS qe FROM users WHERE id = ?')
    .get(userId) as { qs: number; qe: number };
  const quiet = inQuietHours(simNow, user.qs, user.qe);

  const items: DigestItem[] = eligible.map((t) => ({
    itemId: t.itemId,
    symbol: t.symbol,
    state: t.to,
    headline: headlineFor(t),
  }));
  const title =
    items.length === 1 ? '1 item needs your attention' : `${items.length} items need your attention`;

  // Persisted BEFORE any send is attempted. Push can fail silently, a device can
  // be offline, a subscription can expire; the alert log is what lets the app say
  // "3 alerts were sent while you were away" instead of quietly losing them.
  const status: Digest['status'] = quiet ? 'HELD_QUIET_HOURS' : 'SENT';
  const info = db
    .prepare(
      `INSERT INTO alerts (user_id, kind, body, channel, status, created_at, sent_at, session)
       VALUES (?, 'DIGEST', ?, 'IN_APP', ?, ?, ?, ?)`,
    )
    .run(
      userId,
      JSON.stringify({ title, items }),
      status,
      simNow,
      quiet ? null : simNow,
      currentSession(db),
    );
  const alertId = Number(info.lastInsertRowid);

  for (const t of eligible) {
    db.prepare('INSERT INTO alert_items (alert_id, thesis_event_id) VALUES (?, ?)').run(
      alertId,
      t.eventId,
    );
    // Delivering marks the event NOTIFIED, never READ. Seeing a banner on a lock
    // screen is not reading the card, so the unread badge survives (D-031).
    if (!quiet) {
      db.prepare('UPDATE thesis_events SET notified_at = ? WHERE id = ?').run(simNow, t.eventId);
    }
  }

  return {
    digest: { alertId, status, title, items },
    considered: transitions.length,
    suppressed,
    heldByCooldown: 0,
  };
}

/** Alerts held through quiet hours are delivered at the open, never dropped. */
export function releaseHeldAlerts(db: Database.Database, userId: string, simNow: number): number {
  /*
   * Held alerts are filtered on TIME, not on session, and the difference is a
   * bug I shipped and had to take back out.
   *
   * Scoping this to the current session looked right by analogy with the alert
   * log and the cooldown (D-114), and it is wrong here for a reason specific to
   * quiet hours: they run 21:30 to 07:30, so an alert held overnight is ALWAYS
   * held across an IST day boundary, and live mode advances the session on
   * exactly that boundary. The alert it was written to deliver at the open was
   * the one alert it could never deliver.
   *
   * What the session filter was really reaching for is D-109's predicate: after
   * a simulated reset the clock rewinds, so the previous run's alerts are
   * stamped in the FUTURE and must not be delivered. That is what this checks.
   * A clock that moved forward, which is every live day, releases normally.
   *
   * And it is bounded at both ends. Unbounded, an alert held on Tuesday night
   * would be delivered at Thursday's open, stamped as sent on Thursday and
   * marking its cards notified -- while the banner, which is session-scoped,
   * would not show it. The "we told you" flag would be spent on something
   * nobody could see. Quiet hours are at most ten hours long, so a day is
   * generous; anything older than that is not held news, it is history, and it
   * stays held rather than being announced late.
   */
  const held = db
    .prepare(
      `SELECT id FROM alerts
        WHERE user_id = ? AND status = 'HELD_QUIET_HOURS'
          AND created_at <= ? AND created_at >= ?
        ORDER BY id ASC`,
    )
    .all(userId, simNow, simNow - HELD_ALERT_MAX_AGE_MS) as Array<{ id: number }>;
  if (held.length === 0) return 0;

  const user = db
    .prepare('SELECT quiet_hours_start AS qs, quiet_hours_end AS qe FROM users WHERE id = ?')
    .get(userId) as { qs: number; qe: number };
  if (inQuietHours(simNow, user.qs, user.qe)) return 0;

  for (const a of held) {
    db.prepare("UPDATE alerts SET status = 'SENT', sent_at = ? WHERE id = ?").run(simNow, a.id);
    db.prepare(
      `UPDATE thesis_events SET notified_at = ?
        WHERE id IN (SELECT thesis_event_id FROM alert_items WHERE alert_id = ?)`,
    ).run(simNow, a.id);
  }
  return held.length;
}

export interface AlertLogEntry {
  id: number;
  kind: string;
  status: string;
  createdAt: number;
  sentAt: number | null;
  title: string;
  items: DigestItem[];
  retractsAlertId: number | null;
}

export function alertLog(db: Database.Database, userId: string, limit = 20): AlertLogEntry[] {
  const rows = db
    .prepare(
      `SELECT id, kind, status, created_at AS createdAt, sent_at AS sentAt, body,
              retracts_alert_id AS retractsAlertId
         FROM alerts WHERE user_id = ? AND session = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, currentSession(db), limit) as Array<{
    id: number;
    kind: string;
    status: string;
    createdAt: number;
    sentAt: number | null;
    body: string;
    retractsAlertId: number | null;
  }>;

  return rows.map((r) => {
    const body = JSON.parse(r.body) as { title: string; items?: DigestItem[] };
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
      title: body.title,
      items: body.items ?? [],
      retractsAlertId: r.retractsAlertId,
    };
  });
}

export interface Retraction {
  alertId: number;
  retractsAlertId: number;
  symbol: string;
  title: string;
}

/**
 * A wrong alert is never left standing.
 *
 * This is the behaviour Section 5.6 calls the most trust-building thing in the
 * product, and it is the reason the price log is append-only rather than a
 * mutable column: you cannot retract an alert you can no longer prove you sent,
 * about a price you have already overwritten.
 *
 * What gets retracted is deliberately narrow. Only an alert that was actually
 * DELIVERED (a held one was never seen, so there is nothing to take back), that
 * carried a transition triggered by the exact print now known to be wrong, and
 * that has not already been retracted. That last guard is not defensive noise:
 * a scenario can be replayed, and an apology delivered twice is its own kind of
 * noise.
 *
 * The bad transitions are also stamped `superseded_by`, pointing at whatever the
 * item did next once the corrected price was evaluated. History is never
 * rewritten — the wrong state stays in the log, marked as having been overtaken.
 */
export function retractAlertsForCorrection(
  db: Database.Database,
  userId: string,
  symbol: string,
  correctedEventId: number,
  simNow: number,
): Retraction[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.id AS alertId, a.created_at AS createdAt
         FROM alerts a
         JOIN alert_items ai ON ai.alert_id = a.id
         JOIN thesis_events te ON te.id = ai.thesis_event_id
        WHERE a.user_id = ?
          AND a.kind = 'DIGEST'
          AND a.status = 'SENT'
          AND te.price_event_id = ?
          AND a.session = ?
          AND NOT EXISTS (SELECT 1 FROM alerts r WHERE r.retracts_alert_id = a.id)`,
    )
    .all(userId, correctedEventId, currentSession(db)) as Array<{ alertId: number; createdAt: number }>;

  // Mark the overtaken transitions whether or not anything was alerted: a state
  // can be rolled back without ever having earned a notification.
  db.prepare(
    `UPDATE thesis_events
        SET superseded_by = (
              SELECT later.id FROM thesis_events later
               WHERE later.item_id = thesis_events.item_id
                 AND later.id > thesis_events.id
               ORDER BY later.id ASC LIMIT 1)
      WHERE price_event_id = ? AND superseded_by IS NULL`,
  ).run(correctedEventId);

  const out: Retraction[] = [];
  for (const r of rows) {
    const title =
      `The ${clockTime(istMinutesOfDay(r.createdAt))} alert about ${symbol} was based on ` +
      `a price that has since been corrected.`;
    const info = db
      .prepare(
        `INSERT INTO alerts (user_id, kind, body, channel, status, created_at, sent_at,
                             retracts_alert_id, session)
         VALUES (?, 'RETRACTION', ?, 'IN_APP', 'SENT', ?, ?, ?, ?)`,
      )
      .run(
        userId,
        JSON.stringify({ title, items: [], symbol }),
        simNow,
        simNow,
        r.alertId,
        currentSession(db),
      );
    out.push({
      alertId: Number(info.lastInsertRowid),
      retractsAlertId: r.alertId,
      symbol,
      title,
    });
  }
  return out;
}
