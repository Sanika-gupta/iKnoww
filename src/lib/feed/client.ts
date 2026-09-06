import {
  BROWSER_UA,
  MFAPI,
  MFAPI_SCHEME,
  YAHOO_CHART,
  YAHOO_SEARCH,
  yahooTickerFor,
} from './symbols';

/**
 * The only module in the project that talks to the network.
 *
 * Everything here is split into a fetch half and a parse half, and the parse
 * half is exported and pure. That is not tidiness: it is what lets the tests
 * run the real vendor payloads, saved as fixtures on 2026-09-05, without a
 * network call. A parser tested against a shape someone imagined is worth very
 * little; these run against what Yahoo and mfapi actually sent.
 *
 * Every Yahoo request carries a browser user-agent. Measured on Render's own
 * IP: with it, 200 in 495ms; without it, 429 in 353ms.
 */

export class FeedError extends Error {
  constructor(
    message: string,
    readonly kind: 'HTTP' | 'SHAPE' | 'NETWORK' | 'RATE_LIMIT',
    readonly status = 0,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}

const TIMEOUT_MS = 8000;

/**
 * Back-off after a rate limit, remembered across requests.
 *
 * Yahoo's endpoint began returning 429 partway through the build, and hammering
 * it after that is how it stops answering for longer. So a 429 buys sixty
 * seconds of silence for that host: every request in the window fails fast with
 * the same honest error instead of spending the next refusal.
 *
 * Per host rather than global, because mfapi and Yahoo have nothing to do with
 * each other and one being rate-limited must not silence the other.
 */
const backoffUntil = new Map<string, number>();
const BACKOFF_MS = 60_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function getJson(url: string, ua: boolean): Promise<unknown> {
  const host = hostOf(url);
  const until = backoffUntil.get(host) ?? 0;
  if (Date.now() < until) {
    throw new FeedError('backing off after a rate limit', 'RATE_LIMIT', 429);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: ua ? { 'User-Agent': BROWSER_UA } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FeedError(err instanceof Error ? err.message : 'network error', 'NETWORK');
  }
  if (res.status === 429) {
    backoffUntil.set(host, Date.now() + BACKOFF_MS);
    throw new FeedError('the feed is rate-limiting us', 'RATE_LIMIT', 429);
  }
  // A good answer clears the penalty rather than waiting it out.
  backoffUntil.delete(host);
  if (!res.ok) {
    throw new FeedError(`the feed answered ${res.status}`, 'HTTP', res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new FeedError('the feed sent something that is not JSON', 'SHAPE', res.status);
  }
}

// ------------------------------------------------------------------- parsing

export interface Quote {
  price: number;
  /** When the exchange says this price was true, not when we fetched it. */
  asOf: number;
}

export interface DailyBar {
  /** Epoch ms of the session, from the feed. */
  at: number;
  close: number;
}

export interface ChartResult {
  quote: Quote;
  /** Oldest first, non-trading days already dropped. */
  history: DailyBar[];
  /** Today's opening price, when the feed reports one. */
  open: number | null;
  /** The exchange's own trading window for the session the feed is showing. */
  session: { start: number; end: number } | null;
  /**
   * The 52-week range, as the exchange reports it.
   *
   * Not a decoration: it is the context for the number a person is about to
   * type. A thesis at a price outside the last year's range is one that cannot
   * fire, and the form used to ask for that number with nothing on screen to
   * judge it against (D-126).
   */
  range52: { high: number; low: number } | null;
  currency: string | null;
  name: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rangeOf(high: number | null, low: number | null): { high: number; low: number } | null {
  // Both or neither. A range with one end missing is not a range, and half of
  // one rendered as a bound would be read as a fact.
  return high !== null && low !== null && low > 0 && high >= low ? { high, low } : null;
}

const YEAR_MS = 365 * 24 * 60 * 60_000;

/**
 * The 52-week range computed from a history, for a fund.
 *
 * mfapi serves AMFI's NAV file and reports no such figure, but it does serve
 * the whole history, so the range is the real minimum and maximum of published
 * NAVs rather than anything derived. Stocks take theirs from the exchange's own
 * field instead, because the exchange knows about intraday highs that a series
 * of closes cannot see.
 */
export function rangeFromHistory(history: DailyBar[], now: number): { high: number; low: number } | null {
  let high: number | null = null;
  let low: number | null = null;
  for (const bar of history) {
    if (bar.at < now - YEAR_MS || bar.at > now) continue;
    if (high === null || bar.close > high) high = bar.close;
    if (low === null || bar.close < low) low = bar.close;
  }
  return rangeOf(high, low);
}

/**
 * Yahoo's chart payload. One call gives history, the latest quote and the
 * trading session, which is why it is worth using an unofficial endpoint at
 * all: the official-looking alternatives need a key.
 */
export function parseChart(payload: unknown): ChartResult {
  const root = payload as {
    chart?: {
      result?: Array<{
        meta?: Record<string, unknown>;
        timestamp?: number[];
        indicators?: {
          adjclose?: Array<{ adjclose?: Array<number | null> }>;
          quote?: Array<{ close?: Array<number | null>; open?: Array<number | null> }>;
        };
      }>;
      error?: { description?: string };
    };
  };

  if (root?.chart?.error) {
    throw new FeedError(root.chart.error.description ?? 'the feed refused the symbol', 'SHAPE');
  }
  const r = root?.chart?.result?.[0];
  const meta = r?.meta;
  if (!r || !meta) throw new FeedError('no result in the chart payload', 'SHAPE');

  const price = num(meta.regularMarketPrice);
  const time = num(meta.regularMarketTime);
  if (price === null || time === null) {
    throw new FeedError('the chart payload carries no quote', 'SHAPE');
  }

  // adjclose is the right series for returns: it is adjusted for splits and
  // dividends, so a 1:5 split does not read as an 80% crash. Falling back to
  // close is better than failing, and costs nothing for an index, where the
  // two series are identical.
  const adj = r.indicators?.adjclose?.[0]?.adjclose ?? r.indicators?.quote?.[0]?.close ?? [];
  const stamps = r.timestamp ?? [];

  const history: DailyBar[] = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const close = num(adj[i]);
    const at = num(stamps[i]);
    // A null close is a non-trading day or a halted session. Skipping it is
    // right; carrying it forward would invent a zero-return day, and dividing
    // by it would be worse.
    if (close === null || at === null || close <= 0) continue;
    history.push({ at: at * 1000, close });
  }

  const period = meta.currentTradingPeriod as
    | { regular?: { start?: number; end?: number } }
    | undefined;
  const start = num(period?.regular?.start);
  const end = num(period?.regular?.end);

  const opens = r.indicators?.quote?.[0]?.open ?? [];
  const lastOpen = num(opens[opens.length - 1]);

  return {
    quote: { price, asOf: time * 1000 },
    history,
    open: lastOpen,
    session: start !== null && end !== null ? { start: start * 1000, end: end * 1000 } : null,
    range52: rangeOf(num(meta.fiftyTwoWeekHigh), num(meta.fiftyTwoWeekLow)),
    currency: typeof meta.currency === 'string' ? meta.currency : null,
    name:
      typeof meta.longName === 'string'
        ? meta.longName
        : typeof meta.shortName === 'string'
          ? meta.shortName
          : null,
  };
}

export interface SearchHit {
  /** The vendor's id, which is what a later fetch needs. */
  vendorId: string;
  /** iKnoww's own symbol for it. */
  symbol: string;
  name: string;
  /**
   * `INDEX` is a thing the Ask panel can read about, not an instrument the
   * engine can hold (D-074, reversed for Ask only in D-134). It is deliberately
   * NOT an `InstrumentType`: the add path refuses it, and keeping the two types
   * apart is what keeps "an index is never a card" true everywhere except the
   * one panel that reads about them.
   */
  type: 'STOCK' | 'FUND' | 'INDEX';
}

/**
 * Yahoo's search, filtered hard.
 *
 * Only NSE equities survive. BSE listings are dropped because the same company
 * on two exchanges would become two cards with two theses and two prices, and
 * indices are dropped because an index cannot be watched as a card: it has no
 * reference of its own, so its conviction would be permanently UNKNOWN while
 * the market card already shows its move (D-074).
 */
export function parseYahooSearch(payload: unknown): SearchHit[] {
  return collectHits(payload).nse;
}

/**
 * NSE indices from the same search payload, for the Ask panel only.
 *
 * Probed 2026-09-05: "nifty" returns `^NSEI`, `^NSEBANK` and
 * `NIFTY_MIDCAP_100.NS` as `INDEX` on exchange `NSI`, beside a Japanese equity
 * and two BSE mutual funds that the filter drops. The symbol is the vendor id
 * itself: there is no `.NS` rule for indices (`^NSEI` has no suffix at all), and
 * an index is never written to the instrument table, so it needs no name of
 * ours. The three references the engine already uses are recognised by their
 * vendor id and answered from the board rather than the feed (D-134).
 */
export function parseYahooIndexSearch(payload: unknown): SearchHit[] {
  const quotes = (payload as { quotes?: Array<Record<string, unknown>> })?.quotes ?? [];
  const hits: SearchHit[] = [];
  for (const q of quotes) {
    if (q.quoteType !== 'INDEX' || q.exchange !== 'NSI') continue;
    if (typeof q.symbol !== 'string' || q.symbol === '') continue;
    const name =
      (typeof q.longname === 'string' && q.longname) ||
      (typeof q.shortname === 'string' && q.shortname) ||
      q.symbol;
    hits.push({ vendorId: q.symbol, symbol: q.symbol, name, type: 'INDEX' });
  }
  return hits;
}

/**
 * The NSE hits, and the tickers worth a second look.
 *
 * Yahoo ranks its search results globally, and for some company names the NSE
 * listing does not make the cut. Measured: "tcs" and "reliance" return their
 * NSE listing, "infosys" returns the New York ADR, the Frankfurt line, a Sao
 * Paulo receipt, the Buenos Aires CEDEAR and the BOMBAY listing -- and not
 * INFY.NS. Searching the ticker "INFY" returns it immediately.
 *
 * So when a name search finds no NSE equity, the base tickers of the non-NSE
 * listings it DID find are exactly the query that would have worked. One extra
 * request, only on a miss, and never a guess: the retry runs the same search
 * and the same filter, so nothing reaches a card without Yahoo confirming the
 * NSE listing exists.
 */
function collectHits(payload: unknown): { nse: SearchHit[]; retryTickers: string[] } {
  const quotes = (payload as { quotes?: Array<Record<string, unknown>> })?.quotes ?? [];
  const hits: SearchHit[] = [];
  for (const q of quotes) {
    if (q.quoteType !== 'EQUITY' || q.exchange !== 'NSI') continue;
    const vendorId = typeof q.symbol === 'string' ? q.symbol : null;
    if (!vendorId || !vendorId.endsWith('.NS')) continue;
    const name =
      (typeof q.longname === 'string' && q.longname) ||
      (typeof q.shortname === 'string' && q.shortname) ||
      vendorId;
    hits.push({ vendorId, symbol: vendorId.slice(0, -3), name, type: 'STOCK' });
  }

  /*
   * One retry, and only on the precise signal that Yahoo mis-ranked the NSE
   * listing: its own TOP result is a foreign or BSE listing of a company we did
   * not match on the NSE.
   *
   * Measured on the saved fixtures. "tata consultancy" ranks TCS.NS first, so
   * nothing is retried. "infosys" ranks the New York ADR first and never
   * returns INFY.NS at all -- while still returning one NSE row, HCL
   * Infosystems, so "no NSE hits" would not have caught it either.
   *
   * The narrowness is the point rather than fussiness. An earlier version
   * retried whenever any unmatched foreign ticker appeared, which doubled the
   * request volume on ordinary searches; three searches in a row was enough to
   * earn a 429, and the back-off then made a perfectly good search for
   * "reliance" return nothing at all. Spending someone else's rate limit to
   * re-find a result we already have is a bad trade.
   */
  const top = quotes[0];
  const retry: string[] = [];
  if (top && top.quoteType === 'EQUITY' && typeof top.symbol === 'string' && top.exchange !== 'NSI') {
    // "INFY", "INFY.BO" and "INFY.BA" all point at one company; the base ticker
    // is what Yahoo matches an NSE listing on.
    const base = top.symbol.split('.')[0];
    if (base && !hits.some((h) => h.symbol === base)) retry.push(base);
  }
  return { nse: hits, retryTickers: retry };
}

/**
 * mfapi's search. Plan variants are deliberately NOT collapsed: Direct Growth
 * and Regular IDCW have different NAVs, so "buy below 70" means a different
 * thing on each, and picking one silently is the wrong-symbol mistake the
 * thesis parser already refuses to make.
 */
export function parseMfSearch(payload: unknown): SearchHit[] {
  const rows = payload as Array<{ schemeCode?: unknown; schemeName?: unknown }>;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const code = num(r.schemeCode);
    const name = typeof r.schemeName === 'string' ? r.schemeName : null;
    if (code === null || !name) return [];
    return [{ vendorId: String(code), symbol: `MF_${code}`, name, type: 'FUND' as const }];
  });
}

export interface NavResult {
  quote: Quote;
  history: DailyBar[];
  name: string | null;
  category: string | null;
}

/**
 * A `dd-mm-yyyy` NAV date, which is how AMFI publishes them, as an instant.
 *
 * Stamped at 18:00 IST, which is after the 15:30 close and before midnight, so
 * it is both realistic and unambiguous. It also keeps a NAV comfortably inside
 * the 30-hour fund staleness window on the day after it is published, which is
 * the whole point of that window being 30 hours rather than 10 minutes (D-025).
 */
function parseNavDate(s: string): number | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 30, 0);
}

export function parseNav(payload: unknown): NavResult {
  const root = payload as {
    meta?: { scheme_name?: unknown; scheme_category?: unknown };
    data?: Array<{ date?: unknown; nav?: unknown }>;
  };
  const rows = root?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new FeedError('the NAV payload carries no history', 'SHAPE');
  }

  const history: DailyBar[] = [];
  for (const row of rows) {
    if (typeof row.date !== 'string' || typeof row.nav !== 'string') continue;
    const at = parseNavDate(row.date);
    const nav = Number(row.nav);
    // AMFI publishes "0.00000" for a scheme with no NAV that day. Zero is not a
    // price, and a zero denominator would make every return infinite.
    if (at === null || !Number.isFinite(nav) || nav <= 0) continue;
    history.push({ at, close: nav });
  }
  if (history.length === 0) throw new FeedError('no usable NAV rows', 'SHAPE');

  // mfapi returns newest first. Everything downstream wants oldest first.
  history.sort((a, b) => a.at - b.at);
  const latest = history[history.length - 1];

  return {
    quote: { price: latest.close, asOf: latest.at },
    history,
    name: typeof root.meta?.scheme_name === 'string' ? root.meta.scheme_name : null,
    category: typeof root.meta?.scheme_category === 'string' ? root.meta.scheme_category : null,
  };
}

// ------------------------------------------------------------------- fetches

/** Two years of daily history plus the latest quote, in one call. */
export async function fetchChart(symbol: string, range = '2y'): Promise<ChartResult> {
  return fetchChartByTicker(yahooTickerFor(symbol), range);
}

/**
 * The same call, given the vendor's own ticker rather than one of ours.
 *
 * The distinction is not pedantry. `yahooTickerFor` maps an iKnoww symbol to a
 * ticker by appending `.NS`, so handing it a ticker that already carries the
 * suffix asks the feed for `HDFCBANK.NS.NS` and gets a 404 -- which is exactly
 * what a search result does, since a search returns vendor ids. Found by
 * calling the route rather than by a test, the fund path having worked because
 * a scheme code needs no mapping at all.
 */
export function chartUrl(ticker: string, range: string): string {
  return `${YAHOO_CHART}/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
}

export async function fetchChartByTicker(ticker: string, range = '2y'): Promise<ChartResult> {
  return parseChart(await getJson(chartUrl(ticker, range), true));
}

export async function fetchNav(symbol: string, schemeCode?: string): Promise<NavResult> {
  const code = schemeCode ?? MFAPI_SCHEME[symbol] ?? symbol.replace(/^MF_/, '');
  return parseNav(await getJson(`${MFAPI}/${encodeURIComponent(code)}`, false));
}

const searchUrl = (q: string) =>
  `${YAHOO_SEARCH}?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&region=IN`;

export async function searchStocks(q: string): Promise<SearchHit[]> {
  const first = collectHits(await getJson(searchUrl(q), true));
  if (first.retryTickers.length === 0) return first.nse;

  // Exactly one extra request, and only when the first search turned up a
  // company we have not already matched on the NSE. See collectHits. A failed
  // retry is not an error: we simply return what the first search found.
  let extra: SearchHit[] = [];
  try {
    extra = parseYahooSearch(await getJson(searchUrl(first.retryTickers[0]), true));
  } catch {
    return first.nse;
  }

  const seen = new Set(first.nse.map((h) => h.symbol));
  // The retried ticker first: it is the thing the user was most likely after.
  return [...extra.filter((h) => !seen.has(h.symbol)), ...first.nse];
}

export async function searchFunds(q: string): Promise<SearchHit[]> {
  return parseMfSearch(await getJson(`${MFAPI}/search?q=${encodeURIComponent(q)}`, false));
}

/** Indices, for the Ask panel only. Same call as a stock search, different filter. */
export async function searchIndices(q: string): Promise<SearchHit[]> {
  return parseYahooIndexSearch(await getJson(searchUrl(q), true));
}
