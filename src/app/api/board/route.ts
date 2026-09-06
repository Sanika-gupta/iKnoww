import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import { buildBoard } from '@/lib/api/board';
import { resolveWatchlist } from '@/lib/watchlist/lists';

// Every route reads live database state, so nothing here may be pre-rendered.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const db = getDb(modeFrom(request));
  // A tab left open on a list that has since been deleted asks for an id that
  // no longer exists. That must fall back to a real list rather than render an
  // empty screen, so resolution happens here rather than being trusted.
  const requested = new URL(request.url).searchParams.get('watchlist');
  const active = resolveWatchlist(db, DEFAULT_USER_ID, requested);
  if (!active) return NextResponse.json({ error: 'NO_WATCHLIST' }, { status: 404 });
  return NextResponse.json(buildBoard(db, active.id));
}
