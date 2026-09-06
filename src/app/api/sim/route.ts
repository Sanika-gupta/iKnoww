import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import { resolveWatchlist } from '@/lib/watchlist/lists';
import { startScenario, tick } from '@/lib/sim/ticker';
import { SCENARIOS_BY_ID } from '@/lib/sim/scenarios';
import { resetSession } from '@/lib/sim/session';
import { evaluateAll } from '@/lib/engine/states';
import { processTransitions, releaseHeldAlerts, retractAlertsForCorrection } from '@/lib/alerts/policy';
import { buildBoard } from '@/lib/api/board';

export const dynamic = 'force-dynamic';

/**
 * The demo controls, and they are product UI rather than choreography (D-055).
 *
 * No video is required at submission, so a judge runs the app themselves and
 * lands on a calm watchlist where, by design, nothing is happening. Every
 * interesting behaviour needs a market event to exist at all, so these have to
 * be visible, labelled buttons on the main screen.
 *
 * The tick loop is driven one step at a time by the client rather than by a
 * timer on the server. That keeps the simulation deterministic, lets a judge
 * watch cards flip one tick at a time, and avoids a background interval that
 * would either die or double-run on ephemeral hosting.
 */
export async function POST(request: Request) {
  // The simulator does not exist in live mode, and hiding the panel is not the
  // same as closing the route. A stray POST here would tick a simulated clock
  // over real prices, and `action: 'start'` calls resetSession, which would
  // rewind the live clock to whenever the instance first booted. Refused at the
  // boundary rather than defended against downstream.
  if (modeFrom(request) === 'live') {
    return NextResponse.json({ error: 'NOT_IN_LIVE_MODE' }, { status: 403 });
  }

  const db = getDb();

  let body: { action?: string; scenario?: string; watchlistId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  switch (body.action) {
    case 'start': {
      if (!body.scenario || !SCENARIOS_BY_ID[body.scenario]) {
        return NextResponse.json({ error: 'UNKNOWN_SCENARIO' }, { status: 404 });
      }
      resetSession(db);
      startScenario(db, body.scenario);
      break;
    }
    case 'tick': {
      const result = tick(db);
      const transitions = evaluateAll(db);
      // Anything held through quiet hours is delivered at the open, never dropped.
      releaseHeldAlerts(db, DEFAULT_USER_ID, result.simNow);
      // One digest at most, however many cards moved.
      processTransitions(db, DEFAULT_USER_ID, transitions, result.simNow);
      // Order matters: the correction was written during the tick, evaluateAll
      // has just rolled the card back off the bad price, and only now is it
      // true that the earlier alert was wrong.
      for (const c of result.correctedEvents) {
        retractAlertsForCorrection(db, DEFAULT_USER_ID, c.symbol, c.eventId, result.simNow);
      }
      break;
    }
    case 'reset': {
      resetSession(db);
      break;
    }
    default:
      return NextResponse.json({ error: 'UNKNOWN_ACTION' }, { status: 400 });
  }

  // A scenario is market-wide and moves every list, but the caller is looking
  // at exactly one, so it gets that one back.
  const active = resolveWatchlist(db, DEFAULT_USER_ID, body.watchlistId);
  if (!active) return NextResponse.json({ error: 'NO_WATCHLIST' }, { status: 404 });
  return NextResponse.json(buildBoard(db, active.id));
}
