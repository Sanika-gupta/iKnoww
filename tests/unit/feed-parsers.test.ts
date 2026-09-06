import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseChart,
  parseMfSearch,
  parseNav,
  parseYahooSearch,
  rangeFromHistory,
  chartUrl,
  FeedError,
} from '../../src/lib/feed/client';
import { yahooTickerFor } from '../../src/lib/feed/symbols';

/**
 * The parsers, run against what the vendors actually sent.
 *
 * Every fixture in `tests/fixtures/feed` was saved from the live API on
 * 2026-09-05 and is committed unedited. That matters more than it looks: a
 * parser tested against a shape someone imagined proves only that the imagined
 * shape parses. These run against 252 real trading days, 3,266 real NAVs, and
 * the exact search payloads the add form will receive.
 *
 * Nothing here touches the network. The client is split into a fetch half and a
 * parse half precisely so this file can exist, so the suite stays offline and
 * deterministic, and so a rate-limited Yahoo can never fail the build.
 */

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/feed', name), 'utf8'));

describe('Yahoo chart: history, quote and the trading session in one call', () => {
  const parsed = parseChart(fixture('yahoo-chart-tcs.json'));

  it('reads the quote and the time the EXCHANGE says it was true', () => {
    expect(parsed.quote.price).toBeGreaterThan(0);
    // The stamp is the feed's own, not when we fetched it. That distinction is
    // the entire delay story: the badge shows the observed lag rather than a
    // hardcoded fifteen minutes, and the staleness gate judges the quote by
    // when the exchange priced it.
    expect(parsed.quote.asOf).toBeGreaterThan(Date.parse('2020-01-01'));
    expect(parsed.quote.asOf).toBeLessThan(Date.parse('2030-01-01'));
  });

  it('returns two years of usable daily closes, oldest first', () => {
    expect(parsed.history.length).toBeGreaterThan(200);
    for (let i = 1; i < parsed.history.length; i += 1) {
      expect(parsed.history[i].at).toBeGreaterThan(parsed.history[i - 1].at);
    }
    // Every close must be usable as a denominator. One zero or null in the
    // series would produce an infinite return and poison the beta.
    for (const bar of parsed.history) expect(bar.close).toBeGreaterThan(0);
  });

  it('carries the exchange trading period, which is what replaces hardcoded hours', () => {
    expect(parsed.session).not.toBeNull();
    expect(parsed.session!.end).toBeGreaterThan(parsed.session!.start);
    // NSE runs 9:15 to 3:30, which is 6h15m. Asserting the DURATION rather than
    // the clock times is the point: the app never hardcodes either end, so this
    // checks the shape of what it fetches without re-hardcoding it here.
    expect(parsed.session!.end - parsed.session!.start).toBe((6 * 60 + 15) * 60_000);
  });

  it('drops days the market did not trade instead of inventing a flat one', () => {
    const withNulls = {
      chart: {
        result: [
          {
            meta: {
              regularMarketPrice: 100,
              regularMarketTime: 1_780_000_000,
              currentTradingPeriod: { regular: { start: 1, end: 2 } },
            },
            timestamp: [1000, 2000, 3000, 4000],
            indicators: {
              adjclose: [{ adjclose: [10, null, 0, 12] }],
              quote: [{ open: [9, null, null, 11] }],
            },
          },
        ],
      },
    };
    const r = parseChart(withNulls);
    // A null close is a holiday; a zero close is a bad print. Carrying either
    // forward would fabricate a zero-return day, and dividing by the zero would
    // be worse than fabricating it.
    expect(r.history.map((b) => b.close)).toEqual([10, 12]);
  });

  it('refuses a payload with no quote rather than guessing one', () => {
    expect(() => parseChart({ chart: { result: [{ meta: {} }] } })).toThrow(FeedError);
    expect(() => parseChart({ chart: { error: { description: 'No data found' } } })).toThrow(
      /No data found/,
    );
    expect(() => parseChart({})).toThrow(FeedError);
  });
});

describe('Yahoo search: NSE equities only', () => {
  const hits = parseYahooSearch(fixture('yahoo-search-tata.json'));

  it('keeps the NSE listing and drops the BSE one', () => {
    // The real payload for "tata consultancy" carries TCS.NS and TCS.BO. Keeping
    // both would let the same company become two cards with two theses and two
    // prices, which is a correctness problem rather than a tidiness one.
    expect(hits.map((h) => h.vendorId)).toEqual(['TCS.NS']);
    expect(hits[0].symbol).toBe('TCS');
    expect(hits[0].type).toBe('STOCK');
    expect(hits[0].name).toContain('Tata Consultancy');
  });

  it('drops indices, ETFs and anything that is not an equity', () => {
    const mixed = {
      quotes: [
        { symbol: '^NSEI', quoteType: 'INDEX', exchange: 'NSI', shortname: 'Nifty 50' },
        { symbol: 'NIFTYBEES.NS', quoteType: 'ETF', exchange: 'NSI', shortname: 'Nippon ETF' },
        { symbol: 'INFY', quoteType: 'EQUITY', exchange: 'NYQ', shortname: 'Infosys ADR' },
        { symbol: 'INFY.NS', quoteType: 'EQUITY', exchange: 'NSI', shortname: 'Infosys' },
      ],
    };
    // An index has no reference of its own, so its conviction would be
    // permanently UNKNOWN, and the market card already shows its move (D-074).
    // The New York listing is a different instrument in a different currency.
    expect(parseYahooSearch(mixed).map((h) => h.symbol)).toEqual(['INFY']);
  });

  it('returns nothing rather than throwing when the search finds nothing', () => {
    expect(parseYahooSearch({ quotes: [] })).toEqual([]);
    expect(parseYahooSearch({})).toEqual([]);
  });

  it('finds no NSE listing for "infosys", which is why the ticker retry exists', () => {
    /*
     * The real payload, saved unedited. Yahoo ranks results globally, and for
     * this name the NSE listing does not make the cut: it returns the New York
     * ADR, Frankfurt, a Sao Paulo receipt, a Buenos Aires CEDEAR, the Bombay
     * listing and HCL Infosystems -- and not INFY.NS.
     *
     * The filter is right to reject all of those: a New York ADR is a different
     * instrument in a different currency, and the Bombay listing is the same
     * company at a slightly different price. So the fix is not to loosen the
     * filter, it is to search again for the ticker, which does find it.
     */
    const hits = parseYahooSearch(fixture('yahoo-search-infosys.json'));
    expect(hits.map((h) => h.symbol)).toEqual(['HCL-INSYS']);
    expect(hits.every((h) => h.vendorId.endsWith('.NS'))).toBe(true);
  });
});

describe('mfapi NAV history', () => {
  const parsed = parseNav(fixture('mfapi-nav-ppfas.json'));

  it('reads thousands of real NAVs and orders them oldest first', () => {
    expect(parsed.history.length).toBeGreaterThan(3000);
    expect(parsed.history[0].at).toBeLessThan(parsed.history[parsed.history.length - 1].at);
    expect(parsed.name).toContain('Parag Parikh');
  });

  it('takes the latest NAV as the quote, stamped the evening it was published', () => {
    const latest = parsed.history[parsed.history.length - 1];
    expect(parsed.quote.price).toBe(latest.close);
    expect(parsed.quote.asOf).toBe(latest.at);
    // A NAV is published after the close, so it must land in the evening of its
    // own date. Getting this wrong by a day is how a perfectly fresh NAV starts
    // reading as stale, which is the exact wolf-crying D-025 forbids.
    const ist = new Date(parsed.quote.asOf + (5 * 60 + 30) * 60_000);
    expect(ist.getUTCHours()).toBe(18);
  });

  it('skips the zero NAVs AMFI publishes for a scheme with none that day', () => {
    const r = parseNav({
      meta: { scheme_name: 'X' },
      data: [
        { date: '04-09-2026', nav: '90.5' },
        { date: '03-09-2026', nav: '0.00000' },
        { date: '02-09-2026', nav: 'N.A.' },
        { date: '01-09-2026', nav: '89.1' },
      ],
    });
    expect(r.history.map((b) => b.close)).toEqual([89.1, 90.5]);
  });

  it('refuses an empty history rather than returning a fund with no price', () => {
    expect(() => parseNav({ data: [] })).toThrow(FeedError);
    expect(() => parseNav({ data: [{ date: 'bad', nav: 'bad' }] })).toThrow(FeedError);
  });
});

describe('mfapi search keeps plan variants apart', () => {
  const hits = parseMfSearch(fixture('mfapi-search-parag.json'));

  it('returns every plan as its own instrument', () => {
    // The real payload returns four rows for one fund: Direct and Regular,
    // Growth and IDCW. They have different NAVs, so "buy below 70" means a
    // different thing on each. Collapsing them would be the wrong-symbol
    // mistake the thesis parser already refuses to make.
    expect(hits.length).toBe(4);
    expect(new Set(hits.map((h) => h.symbol)).size).toBe(4);
    expect(hits.every((h) => h.type === 'FUND')).toBe(true);
    expect(hits.some((h) => h.name.includes('Direct Plan - Growth'))).toBe(true);
    expect(hits.some((h) => h.name.includes('IDCW'))).toBe(true);
  });

  it('prefixes the scheme code so a fund can never collide with a ticker', () => {
    for (const h of hits) {
      expect(h.symbol).toMatch(/^MF_\d+$/);
      expect(h.vendorId).toMatch(/^\d+$/);
    }
  });

  it('survives a malformed row without dropping the whole search', () => {
    expect(
      parseMfSearch([
        { schemeCode: 1, schemeName: 'Fine' },
        { schemeCode: null, schemeName: 'No code' },
        { schemeName: 'Missing code' },
      ]).map((h) => h.name),
    ).toEqual(['Fine']);
    expect(parseMfSearch({})).toEqual([]);
  });
});

describe('returns are paired by date, not by position', () => {
  /*
   * The bug this guards was invisible with generated history and would have
   * been invisible in production too: it produces a confident wrong number
   * rather than an error.
   *
   * Two NSE instruments do not necessarily share trading days. Measured on the
   * real fixtures: Reliance has 500 daily bars over two years where the Nifty
   * 50 has 496. Pairing the two series by POSITION regresses each stock return
   * against an index return four days adrift, all the way down, and reports a
   * beta with full confidence.
   */
  it('a shorter reference series does not shift the pairing', async () => {
    const { createLiveTestDb } = await import('../../src/lib/db');
    const { saveStatsForSymbol } = await import('../../src/lib/engine/stats');

    const db = createLiveTestDb();
    db.prepare(
      `INSERT INTO instruments (symbol, name, instrument_type, reference_symbol, sector, is_reference)
       VALUES ('X', 'X', 'STOCK', 'NIFTY50', NULL, 0)`,
    ).run();

    const insert = db.prepare('INSERT INTO daily_returns (symbol, day, ret) VALUES (?, ?, ?)');
    const BETA = 2;
    db.transaction(() => {
      for (let day = 0; day < 300; day += 1) {
        const market = Math.sin(day / 5) * 0.01;
        // The stock trades every day; the index is missing every seventh, which
        // is what a halted session or a data gap looks like.
        if (day % 7 !== 0) insert.run('NIFTY50', day, market);
        insert.run('X', day, BETA * market);
      }
    })();

    const stats = saveStatsForSymbol(db, 'X');
    // Paired by day, the relationship is exact and beta comes back as 2.
    // Paired by position it would be regressing against the wrong days and
    // would not.
    expect(stats.beta).toBeCloseTo(BETA, 6);
    expect(stats.windowN).toBeLessThan(300);
  });
});

describe('the 52-week range, which anchors the number the form asks for', () => {
  it('takes a stock range from the exchange rather than from the closes', () => {
    /*
     * The exchange publishes its own 52-week high and low, and they are not the
     * same as the extremes of a series of daily closes: a high printed intraday
     * and sold back down never appears as a close at all. Using the field the
     * exchange reports means the range shown is the one a person would see
     * anywhere else, rather than one this app computed and nobody can reconcile.
     */
    const parsed = parseChart(fixture('yahoo-chart-tcs.json'));
    expect(parsed.range52).toEqual({ high: 3350, low: 1976.8 });
  });

  it('leaves the range absent rather than inventing half of one', () => {
    // A bound on its own would be read as a fact about the year. Both or
    // neither, and neither is the honest answer when the payload is silent.
    const payload = JSON.parse(
      JSON.stringify(fixture('yahoo-chart-tcs.json')),
    ) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    delete payload.chart.result[0].meta.fiftyTwoWeekLow;
    expect(parseChart(payload).range52).toBeNull();
  });

  it('computes a fund range from the published NAVs, over a year and no more', () => {
    /*
     * mfapi serves AMFI's file and reports no such figure, but it does serve the
     * whole history -- 3,266 real NAVs back to 2013 in this fixture. So the
     * range is the true minimum and maximum of published NAVs, which is why the
     * window has to be applied: over the whole history the "52-week low" would
     * be the 2013 launch price.
     */
    const nav = parseNav(fixture('mfapi-nav-ppfas.json'));
    const asOf = nav.quote.asOf;
    const year = rangeFromHistory(nav.history, asOf)!;
    const allTimeLow = nav.history.reduce((m, b) => Math.min(m, b.close), Infinity);

    expect(year.low).toBeLessThanOrEqual(year.high);
    // Every NAV in the window is a real published one, and the latest sits
    // inside its own year.
    expect(nav.quote.price).toBeGreaterThanOrEqual(year.low);
    expect(nav.quote.price).toBeLessThanOrEqual(year.high);
    // The window bites: a decade of growth means the all-time low is far below
    // anything printed in the last year.
    expect(allTimeLow).toBeLessThan(year.low);
  });

  it('has no range to give when nothing falls inside the window', () => {
    const nav = parseNav(fixture('mfapi-nav-ppfas.json'));
    // Ten years after the last published NAV, the year behind us is empty.
    expect(rangeFromHistory(nav.history, nav.quote.asOf + 10 * 365 * 24 * 60 * 60_000)).toBeNull();
  });
});

describe('the ticker a request is built from', () => {
  it('asks for the ticker it was given, without appending a second suffix', () => {
    /*
     * `yahooTickerFor` maps one of our symbols to a vendor ticker by appending
     * `.NS`, which is right for RELIANCE and wrong for anything that arrived as
     * a vendor id already -- and a search result is nothing but vendor ids. Sent
     * through the mapping, HDFCBANK.NS became HDFCBANK.NS.NS and the feed
     * answered 404, so the price anchor was silently absent for every stock
     * while the fund path worked, a scheme code needing no mapping.
     *
     * Found by calling the route and reading what came back, not by a test
     * (D-126). This is the test that would have.
     */
    expect(chartUrl('HDFCBANK.NS', '1d')).toContain('/HDFCBANK.NS?');
    expect(chartUrl(yahooTickerFor('HDFCBANK'), '1d')).toBe(chartUrl('HDFCBANK.NS', '1d'));
    // The mapping is deliberately not idempotent, which is the whole reason a
    // by-ticker entry point has to exist rather than being a convenience.
    expect(yahooTickerFor('HDFCBANK.NS')).toBe('HDFCBANK.NS.NS');
  });
});
