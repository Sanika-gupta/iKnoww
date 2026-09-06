import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import {
  deleteWatchlist,
  listWatchlists,
  renameWatchlist,
  type ListError,
} from '@/lib/watchlist/lists';
import { simNow } from '@/lib/sim/ticker';

export const dynamic = 'force-dynamic';

const STATUS: Record<ListError, number> = {
  EMPTY_NAME: 422,
  NAME_TOO_LONG: 422,
  DUPLICATE_NAME: 409,
  UNKNOWN_WATCHLIST: 404,
  LAST_WATCHLIST: 409,
  TOO_MANY_WATCHLISTS: 409,
};

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
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

  const result = renameWatchlist(db, id, DEFAULT_USER_ID, body.name);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS[result.error] ?? 400 });
  }

  return NextResponse.json({
    watchlist: result.watchlist,
    watchlists: listWatchlists(db, DEFAULT_USER_ID),
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const db = getDb(modeFrom(request));

  // The simulated clock, never the wall clock (D-088): a soft-removal stamped
  // with real time would sit in a different era from every event around it.
  const result = deleteWatchlist(db, id, DEFAULT_USER_ID, simNow(db));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS[result.error] ?? 400 });
  }

  return NextResponse.json({
    removedItems: result.removedItems,
    watchlists: listWatchlists(db, DEFAULT_USER_ID),
  });
}
