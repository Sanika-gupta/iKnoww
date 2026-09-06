import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import { modeFrom } from '@/lib/domain/mode';
import { refresh } from '@/lib/feed/refresh';
import { FeedError } from '@/lib/feed/client';
import { buildBoard } from '@/lib/api/board';
import { resolveWatchlist } from '@/lib/watchlist/lists';

export const dynamic = 'force-dynamic';

/**
 * Live mode's equivalent of a simulated tick, and deliberately the same shape:
 * the client asks for it, the server does one pass, and the board comes back.
 * There is no timer here for the same reason there is none in the simulator
 * (D-085) -- nothing to die or double-run on ephemeral hosting.
 *
 * Refused in simulated mode rather than quietly ignored. Fetching real prices
 * into the simulated database would put real quotes into a deterministic
 * replay, and the demo would stop being reproducible.
 *
 * `?force=1` bypasses the throttle and is sent only when a person pressed the
 * button. The automatic refresh never forces, because a timer in every open tab
 * is what makes the call volume unbounded in the first place.
 */
export async function POST(request: Request) {
  const mode = modeFrom(request);
  if (mode !== 'live') {
    return NextResponse.json({ error: 'ONLY_IN_LIVE_MODE' }, { status: 403 });
  }

  const db = getDb('live');
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  const active = resolveWatchlist(db, DEFAULT_USER_ID, url.searchParams.get('watchlist'));
  if (!active) return NextResponse.json({ error: 'NO_WATCHLIST' }, { status: 404 });

  let result;
  try {
    result = await refresh(db, DEFAULT_USER_ID, { force });
  } catch (err) {
    /*
     * The whole feed being unreachable is a normal condition for an unofficial
     * endpoint with no SLA, not an exception to log and forget.
     *
     * The board is still returned, built from whatever prices were last stored,
     * so the caller never has to choose between showing an error and showing
     * cards. That is the entire "never blanks a card" guarantee: the failure is
     * a field beside the board, not instead of it.
     */
    const kind = err instanceof FeedError ? err.kind : 'UNKNOWN';
    return NextResponse.json(
      {
        ...buildBoard(db, active.id),
        feedError: { kind, detail: err instanceof Error ? err.message : 'unknown' },
      },
      { status: 200 },
    );
  }

  return NextResponse.json({ ...buildBoard(db, active.id), feed: result });
}
