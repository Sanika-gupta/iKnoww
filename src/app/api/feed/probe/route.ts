import { NextResponse } from 'next/server';
import { BROWSER_UA, YAHOO_CHART, YAHOO_SEARCH, MFAPI } from '@/lib/feed/symbols';

export const dynamic = 'force-dynamic';

/**
 * Step 0 of the live feed: does either API answer from THIS host's IP?
 *
 * It exists because the one thing that could not be tested from a laptop is
 * whether Yahoo's unofficial endpoint answers a datacenter address. It has
 * tightened against them before, and it began rate-limiting requests without a
 * browser user-agent partway through the build. If it refuses Render, the stock
 * half of live mode is cut before any of it is built rather than after.
 *
 * Read-only, touches no database, and is safe to leave deployed: it reports
 * status codes and latencies and nothing else.
 */

async function probe(name: string, url: string, ua: boolean) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: ua ? { 'User-Agent': BROWSER_UA } : {},
      cache: 'no-store',
    });
    const body = await res.text();
    return {
      name,
      ua,
      status: res.status,
      ms: Date.now() - started,
      bytes: body.length,
      sample: res.ok ? body.slice(0, 160) : body.slice(0, 200),
    };
  } catch (err) {
    return {
      name,
      ua,
      status: 0,
      ms: Date.now() - started,
      bytes: 0,
      sample: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const results = await Promise.all([
    probe('yahoo-chart-with-ua', `${YAHOO_CHART}/TCS.NS?range=1d&interval=1d`, true),
    probe('yahoo-chart-no-ua', `${YAHOO_CHART}/TCS.NS?range=1d&interval=1d`, false),
    probe('yahoo-search-with-ua', `${YAHOO_SEARCH}?q=tata&quotesCount=5&newsCount=0&region=IN`, true),
    probe('mfapi-nav', `${MFAPI}/122639`, false),
    probe('mfapi-search', `${MFAPI}/search?q=parag%20parikh%20flexi`, false),
  ]);

  return NextResponse.json({
    at: new Date().toISOString(),
    verdict: {
      stocks: results[0].status === 200 ? 'AVAILABLE' : 'REFUSED',
      funds: results[3].status === 200 ? 'AVAILABLE' : 'REFUSED',
    },
    results,
  });
}
