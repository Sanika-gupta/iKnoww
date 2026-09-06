import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import { buildInstruments } from '@/lib/api/board';
import { resolveWatchlist } from '@/lib/watchlist/lists';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const db = getDb(modeFrom(request));
  // "Already watched" is per LIST, not per user: a stock you follow for the long
  // term is a perfectly reasonable thing to also watch for a dip, under a
  // different thesis.
  const requested = new URL(request.url).searchParams.get('watchlist');
  const active = resolveWatchlist(db, DEFAULT_USER_ID, requested);
  if (!active) return NextResponse.json({ error: 'NO_WATCHLIST' }, { status: 404 });
  return NextResponse.json({ instruments: buildInstruments(db, DEFAULT_USER_ID, active.id) });
}
