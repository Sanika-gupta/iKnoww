import { NextResponse } from 'next/server';
import { modeFrom } from '@/lib/domain/mode';
import { searchInstruments } from '@/lib/feed/instruments';
import { FeedError } from '@/lib/feed/client';
import type { InstrumentType } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

/**
 * Instrument search, live mode only.
 *
 * Search was cut permanently in simulated mode (D-036): a fixed picker over
 * twelve instruments demonstrates identical flows and cost nothing. That still
 * holds, and this does not reopen it. In live mode the fixed list would be
 * three unwatchable indices, so search is not a nicety here, it is the only way
 * to put anything on the board at all.
 */
export async function GET(request: Request) {
  if (modeFrom(request) !== 'live') {
    return NextResponse.json({ error: 'ONLY_IN_LIVE_MODE' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const q = params.get('q') ?? '';
  // INDEX is for the Ask panel's picker only (D-134). The add form never sends
  // it, and ensureInstrument refuses it on the server regardless, so widening
  // the search here cannot put an index on the board.
  const raw = params.get('type');
  const type: InstrumentType | 'INDEX' = raw === 'FUND' ? 'FUND' : raw === 'INDEX' ? 'INDEX' : 'STOCK';

  try {
    return NextResponse.json({ results: await searchInstruments(type, q) });
  } catch (err) {
    // A failed search says so and changes nothing else on the screen. The feed
    // is unofficial and rate-limits, so this is a normal condition.
    const kind = err instanceof FeedError ? err.kind : 'UNKNOWN';
    return NextResponse.json(
      { error: 'SEARCH_UNAVAILABLE', kind },
      { status: kind === 'RATE_LIMIT' ? 429 : 503 },
    );
  }
}
