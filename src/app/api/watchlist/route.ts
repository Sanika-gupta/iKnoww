import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import { addItem, type AddError } from '@/lib/watchlist/items';
import { resolveWatchlist } from '@/lib/watchlist/lists';
import { ensureInstrument, isKnown } from '@/lib/feed/instruments';
import { FeedError } from '@/lib/feed/client';
import type { InstrumentType, ThesisType } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

/**
 * Every failure the service can return maps to a status code. Nothing is thrown
 * for an expected outcome, and nothing returns 200 with an error inside it.
 */
const STATUS: Record<AddError, number> = {
  UNKNOWN_SYMBOL: 404,
  NOT_WATCHABLE: 422,
  UNKNOWN_WATCHLIST: 404,
  UNKNOWN_TEMPLATE: 422,
  POSITION_REQUIRED: 409,
  THRESHOLD_REQUIRED: 422,
  INVALID_THRESHOLD: 422,
  DUPLICATE: 409,
};

export async function POST(request: Request) {
  const mode = modeFrom(request);
  const db = getDb(mode);

  let body: {
    symbol?: string;
    thesisType?: string;
    threshold?: number;
    watchlistId?: string;
    /** Live mode only: the vendor id and name, so a searched symbol can be added. */
    vendorId?: string;
    name?: string;
    instrumentType?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  if (!body.symbol || !body.thesisType) {
    return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
  }

  const active = resolveWatchlist(db, DEFAULT_USER_ID, body.watchlistId);
  if (!active) return NextResponse.json({ error: 'NO_WATCHLIST' }, { status: 404 });

  /*
   * In live mode the universe grows, so a symbol the app has never seen has to
   * be fetched and made evaluable before it can be watched. This is the one
   * request in the app that reaches the network, and it is deliberately the one
   * a user explicitly asked for.
   *
   * Only when it is genuinely unknown: re-adding something already there must
   * still hit addItem's duplicate rule, which offers to edit the existing
   * thesis rather than refetching two years of history.
   */
  let assumedBenchmark = false;
  if (mode === 'live' && !isKnown(db, body.symbol)) {
    if (!body.vendorId) {
      return NextResponse.json({ error: 'UNKNOWN_SYMBOL' }, { status: 404 });
    }
    /*
     * Refused here by name (D-074, D-134). Without this the type was coerced to
     * STOCK, the index was inserted as one, its ticker was mangled to
     * "^NSEBANK.NS", the feed answered 404 and the rollback happened to save
     * the day -- a refusal by accident, reported as the feed being down.
     */
    if (body.instrumentType === 'INDEX') {
      return NextResponse.json({ error: 'INDEX_NOT_WATCHABLE' }, { status: 400 });
    }
    try {
      const ensured = await ensureInstrument(db, {
        vendorId: body.vendorId,
        symbol: body.symbol,
        name: body.name ?? body.symbol,
        type: (body.instrumentType === 'FUND' ? 'FUND' : 'STOCK') as InstrumentType,
      });
      assumedBenchmark = ensured.assumedBenchmark;
    } catch (err) {
      const kind = err instanceof FeedError ? err.kind : 'UNKNOWN';
      return NextResponse.json(
        { error: 'FEED_UNAVAILABLE', kind },
        { status: kind === 'RATE_LIMIT' ? 429 : 503 },
      );
    }
  }

  const result = addItem(db, {
    userId: DEFAULT_USER_ID,
    watchlistId: active.id,
    symbol: body.symbol,
    thesisType: body.thesisType as ThesisType,
    params: body.threshold === undefined ? {} : { threshold: Number(body.threshold) },
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, itemId: result.itemId ?? null },
      { status: STATUS[result.error] ?? 400 },
    );
  }

  return NextResponse.json(
    { item: result.item, restored: result.restored, assumedBenchmark },
    { status: 201 },
  );
}
