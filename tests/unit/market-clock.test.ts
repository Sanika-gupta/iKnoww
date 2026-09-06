import { describe, it, expect } from 'vitest';
import { marketSession } from '../../src/lib/api/board';
import {
  isMarketOpen,
  isWeekend,
  MARKET_OPEN_MIN,
  MARKET_CLOSE_MIN,
} from '../../src/lib/alerts/policy';

/**
 * The session clock shown above the index.
 *
 * The point of these tests is not the string formatting, it is that the badge
 * and the alert policy can never disagree about whether the market is open. If
 * the card says "Open" while the policy is silently suppressing alerts as
 * MARKET_CLOSED, the product is lying on screen about its own behaviour.
 */

const ist = (s: string) => Date.parse(`${s}+05:30`);

describe('market session clock', () => {
  it('formats the simulated instant in IST, not UTC', () => {
    // 03:45 UTC is 09:15 IST. Reading this as UTC would print the wrong day
    // part as well as the wrong hour.
    const clock = marketSession(Date.parse('2026-09-04T03:45:00Z'));
    expect(clock.label).toBe('Fri 4 Sep 2026 · 9:15 AM IST');
  });

  it('uses 12-hour time with a padded minute', () => {
    expect(marketSession(ist('2026-09-04T09:05:00')).label).toContain('9:05 AM');
    expect(marketSession(ist('2026-09-04T15:30:00')).label).toContain('3:30 PM');
    // Noon and midnight are where a naive h % 12 prints "0".
    expect(marketSession(ist('2026-09-04T12:00:00')).label).toContain('12:00 PM');
    expect(marketSession(ist('2026-09-04T00:00:00')).label).toContain('12:00 AM');
  });

  it('opens at 9:15 and closes at 3:30, inclusive of both edges', () => {
    expect(marketSession(ist('2026-09-04T09:14:59')).isOpen).toBe(false);
    expect(marketSession(ist('2026-09-04T09:15:00')).isOpen).toBe(true);
    expect(marketSession(ist('2026-09-04T15:30:00')).isOpen).toBe(true);
    expect(marketSession(ist('2026-09-04T15:31:00')).isOpen).toBe(false);
  });

  it('says what happens next rather than only what is true now', () => {
    expect(marketSession(ist('2026-09-04T10:30:00')).session).toBe('Open · closes 3:30 PM');
    // Friday evening. The next open is Monday, not "9:15" with no day, which is
    // what this said before weekends existed and would have been wrong by two
    // days on every Friday night in live mode.
    expect(marketSession(ist('2026-09-04T18:00:00')).session).toBe('Closed · opens Mon 9:15 AM');
    // Before the open on a trading day, the next open is today, so no day part.
    expect(marketSession(ist('2026-09-04T07:00:00')).session).toBe('Closed · opens 9:15 AM');
  });

  it('is closed all weekend, at every hour', () => {
    // Simulated mode never reaches a Saturday. Live mode reaches one every week,
    // and a badge reading "Open · closes 3:30 PM" on a Saturday would be the
    // product lying on screen -- while the alert policy, reading the same
    // predicate, would have been letting stock alerts through all weekend.
    for (const day of ['2026-09-05', '2026-09-06']) {
      for (const hour of ['00:00', '09:15', '11:00', '15:30', '23:59']) {
        const at = ist(`${day}T${hour}:00`);
        expect(isWeekend(at)).toBe(true);
        expect(marketSession(at).isOpen).toBe(false);
      }
    }
    expect(marketSession(ist('2026-09-05T11:00:00')).session).toBe('Closed · opens Mon 9:15 AM');
    expect(marketSession(ist('2026-09-06T11:00:00')).session).toBe('Closed · opens Mon 9:15 AM');
  });

  it("takes the exchange's own trading period over the hardcoded rule", () => {
    // What live mode fetches with the quotes. It is what makes the hours
    // correct without hardcoding them, and it is why a badge can be honest
    // about whether it knows or is assuming.
    const session = { start: ist('2026-09-04T09:15:00'), end: ist('2026-09-04T15:30:00') };
    expect(marketSession(ist('2026-09-04T10:00:00'), session).isOpen).toBe(true);
    expect(marketSession(ist('2026-09-04T10:00:00'), session).hoursSource).toBe('feed');
    expect(marketSession(ist('2026-09-04T10:00:00')).hoursSource).toBe('assumed');

    // A Saturday, where the fetched period still points at Friday's session --
    // which is exactly how a weekend and an exchange holiday both come out
    // closed without the app knowing a calendar.
    expect(marketSession(ist('2026-09-05T11:00:00'), session).isOpen).toBe(false);

    // A shortened session, such as a muhurat day. The badge reports the hours
    // it was given, not the ones it assumed.
    const short = { start: ist('2026-09-04T18:15:00'), end: ist('2026-09-04T19:15:00') };
    expect(marketSession(ist('2026-09-04T18:30:00'), short).session).toBe(
      'Open · closes 7:15 PM',
    );
    expect(marketSession(ist('2026-09-04T12:00:00'), short).isOpen).toBe(false);
  });

  it('never disagrees with the predicate the alert policy uses', () => {
    // Every minute of a whole week, both must answer identically. The badge and
    // the silence are two faces of one rule, and the week rather than the day
    // is what makes the weekend part of that guarantee rather than an
    // afterthought bolted onto the badge.
    const midnight = ist('2026-09-04T00:00:00'); // Friday through Thursday
    for (let m = 0; m < 1440 * 7; m += 1) {
      const at = midnight + m * 60_000;
      expect(marketSession(at).isOpen).toBe(isMarketOpen(at));
    }
  });

  it('agrees with the policy on a fetched session too', () => {
    const session = { start: ist('2026-09-04T09:15:00'), end: ist('2026-09-04T15:30:00') };
    const midnight = ist('2026-09-04T00:00:00');
    for (let m = 0; m < 1440 * 2; m += 1) {
      const at = midnight + m * 60_000;
      expect(marketSession(at, session).isOpen).toBe(isMarketOpen(at, session));
    }
  });

  it('reports the boundaries the policy actually holds', () => {
    expect(MARKET_OPEN_MIN).toBe(9 * 60 + 15);
    expect(MARKET_CLOSE_MIN).toBe(15 * 60 + 30);
  });

  it('carries the instant it was given, so the caller can prove it is simulated', () => {
    const at = ist('2026-09-04T11:04:00');
    expect(marketSession(at).at).toBe(at);
  });
});
