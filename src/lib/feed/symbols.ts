/**
 * The vendor id table, and the browser user-agent, in one place.
 *
 * Two keyless sources, chosen because they need no signup and no key, which is
 * the entire premise of the live mode (D-116):
 *
 *   - Yahoo Finance's chart endpoint for NSE stocks and indices. It is
 *     UNOFFICIAL. It has no SLA and it can stop answering at any time, which is
 *     why simulated mode remains the default and a live failure never leaves
 *     live mode.
 *   - mfapi.in for mutual fund NAVs, which serves AMFI's own daily file.
 *
 * The user-agent is not decoration. Measured on 2026-09-05: the same chart URL
 * answered a plain `curl` in the morning and returned 429 in 60ms by the
 * afternoon, on both query1 and query2, for chart and for search. With a
 * browser UA it answered in 200-400ms. So every Yahoo request carries one.
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** iKnoww's own symbol -> Yahoo ticker, for the instruments seeded in live mode. */
export const YAHOO_TICKER: Record<string, string> = {
  NIFTY50: '^NSEI',
  NIFTY500: '^CRSLDX',
  NIFTYMID150: 'NIFTYMIDCAP150.NS',
};

/** Every other NSE stock follows one rule, so search results need no table. */
export function yahooTickerFor(symbol: string): string {
  return YAHOO_TICKER[symbol] ?? `${symbol}.NS`;
}

/**
 * The reverse: which of our references, if any, a vendor index id names.
 *
 * A search for "nifty" returns `^NSEI`, which is NIFTY50 -- the reference the
 * engine already prices and every stock is measured against. Answering about it
 * from the board, rather than fetching it again as a stranger, is what lets the
 * Ask panel say "3 of your 6 cards are moving with it" (D-134).
 */
export function knownReferenceFor(vendorId: string): string | null {
  for (const [symbol, ticker] of Object.entries(YAHOO_TICKER)) {
    if (ticker === vendorId) return symbol;
  }
  return null;
}

/** mfapi scheme codes for the three funds the simulated universe carries. */
export const MFAPI_SCHEME: Record<string, string> = {
  PPFAS_FLEXI: '122639',
  HDFC_MIDCAP: '118989',
  UTI_NIFTY50: '120716',
};

export const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
export const YAHOO_SEARCH = 'https://query2.finance.yahoo.com/v1/finance/search';
export const MFAPI = 'https://api.mfapi.in/mf';
