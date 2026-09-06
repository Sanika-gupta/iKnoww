import { NextResponse } from 'next/server';
import { modeFrom } from '@/lib/domain/mode';
import { quoteFor } from '@/lib/feed/instruments';
import { FeedError } from '@/lib/feed/client';
import type { InstrumentType } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

/**
 * The price and 52-week range for a searched instrument, before it is added.
 *
 * Live mode only, for the same reason search is: in simulated mode every
 * instrument is already in the database, so the anchor is a row read rather
 * than a request and no route is needed for it.
 *
 * A failure is reported as a 200 with no quote rather than as an error. The
 * anchor helps you choose a number; it is not part of adding one, and a feed
 * that is rate-limiting must not be able to stop you watching something.
 */
export async function GET(request: Request) {
  if (modeFrom(request) !== 'live') {
    return NextResponse.json({ error: 'ONLY_IN_LIVE_MODE' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const vendorId = params.get('vendorId');
  const type: InstrumentType = params.get('type') === 'FUND' ? 'FUND' : 'STOCK';
  if (!vendorId) return NextResponse.json({ error: 'NO_SYMBOL' }, { status: 400 });

  try {
    return NextResponse.json({ quote: await quoteFor(type, vendorId) });
  } catch (err) {
    const kind = err instanceof FeedError ? err.kind : 'UNKNOWN';
    return NextResponse.json({ quote: null, kind }, { status: 200 });
  }
}
