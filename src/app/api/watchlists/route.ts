import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import { createWatchlist, listWatchlists, type ListError } from '@/lib/watchlist/lists';

export const dynamic = 'force-dynamic';

/**
 * Every failure the service can return maps to a status code. Nothing is thrown
 * for an expected outcome, and nothing returns 200 with an error inside it.
 */
const STATUS: Record<ListError, number> = {
  EMPTY_NAME: 422,
  NAME_TOO_LONG: 422,
  DUPLICATE_NAME: 409,
  UNKNOWN_WATCHLIST: 404,
  LAST_WATCHLIST: 409,
  TOO_MANY_WATCHLISTS: 409,
};

export async function GET(request: Request) {
  return NextResponse.json({
    watchlists: listWatchlists(getDb(modeFrom(request)), DEFAULT_USER_ID),
  });
}

export async function POST(request: Request) {
  const db = getDb(modeFrom(request));

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }
  if (typeof body.name !== 'string') {
    return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
  }

  const result = createWatchlist(db, DEFAULT_USER_ID, body.name);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS[result.error] ?? 400 });
  }

  // The caller gets the whole set back, so the tab bar never has to guess what
  // it now looks like or fire a second request to find out.
  return NextResponse.json(
    { watchlist: result.watchlist, watchlists: listWatchlists(db, DEFAULT_USER_ID) },
    { status: 201 },
  );
}
