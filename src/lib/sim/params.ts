/**
 * SIMULATOR PARAMETERS. THE ENGINE MUST NEVER IMPORT THIS FILE.
 * =============================================================
 *
 * These are the "true" values used to GENERATE prices. The conviction engine
 * estimates beta and idiosyncratic volatility by regression from the generated
 * price history instead, exactly as it would from a real market feed (D-012).
 *
 * If the engine read these values directly the maths would be circular: we would
 * be proving that numbers we invented match the numbers we invented. The
 * convergence test in tests/unit/conviction.test.ts exists to prove the
 * estimation is real, and it is the single most important test in the project.
 *
 * Enforced by tests/unit/no-answer-key.test.ts, which fails if anything under
 * src/lib/engine imports from src/lib/sim/params.
 */

export interface GeneratorParams {
  symbol: string;
  /** Starting price, or NAV for a fund. Rupees. */
  basePrice: number;
  /** True sensitivity to the instrument's reference. */
  beta: number;
  /** True idiosyncratic daily volatility, the part the reference cannot explain. */
  idioVol: number;
}

/**
 * NIFTY50 is the root market factor: it has no reference of its own, so its
 * "beta" is unused and its idioVol IS its total volatility. The two other
 * indices are generated from NIFTY50, which is why a broad-market fall moves
 * everything at once.
 */
export const REFERENCE_PARAMS: GeneratorParams[] = [
  { symbol: 'NIFTY50', basePrice: 24180, beta: 0, idioVol: 0.009 },
  { symbol: 'NIFTY500', basePrice: 22100, beta: 0.98, idioVol: 0.002 },
  { symbol: 'NIFTYMID150', basePrice: 20450, beta: 1.15, idioVol: 0.005 },
];

export const STOCK_PARAMS: GeneratorParams[] = [
  { symbol: 'RELIANCE', basePrice: 2450, beta: 1.05, idioVol: 0.012 },
  { symbol: 'TCS', basePrice: 3800, beta: 0.85, idioVol: 0.011 },
  { symbol: 'INFY', basePrice: 1550, beta: 0.95, idioVol: 0.013 },
  { symbol: 'HDFCBANK', basePrice: 1680, beta: 1.1, idioVol: 0.012 },
  { symbol: 'ICICIBANK', basePrice: 1220, beta: 1.15, idioVol: 0.013 },
  { symbol: 'SBIN', basePrice: 820, beta: 1.3, idioVol: 0.016 },
  { symbol: 'DIVISLAB', basePrice: 6100, beta: 0.7, idioVol: 0.015 },
  { symbol: 'MARUTI', basePrice: 12400, beta: 1.0, idioVol: 0.014 },
  { symbol: 'ITC', basePrice: 465, beta: 0.65, idioVol: 0.01 },
];

/**
 * Funds track a benchmark closely, so their idiosyncratic volatility is far
 * smaller than a stock's. UTI_NIFTY50 is an index fund: its residual is near
 * zero by construction, which is precisely why applying a stock's surprise
 * model to it would be meaningless. Generalising conviction to a per-instrument
 * REFERENCE rather than always the market is what makes it work (D-024).
 */
export const FUND_PARAMS: GeneratorParams[] = [
  { symbol: 'PPFAS_FLEXI', basePrice: 71.4, beta: 0.92, idioVol: 0.004 },
  { symbol: 'HDFC_MIDCAP', basePrice: 178.2, beta: 0.98, idioVol: 0.005 },
  { symbol: 'UTI_NIFTY50', basePrice: 285.6, beta: 1.0, idioVol: 0.0008 },
];

export const ALL_PARAMS: GeneratorParams[] = [
  ...REFERENCE_PARAMS,
  ...STOCK_PARAMS,
  ...FUND_PARAMS,
];

export const PARAMS_BY_SYMBOL: Record<string, GeneratorParams> = Object.fromEntries(
  ALL_PARAMS.map((p) => [p.symbol, p]),
);

/** Trading days generated at boot. The stats window needs 250. */
export const BACKFILL_DAYS = 300;

/** Fixed seed so every boot, every clone and every test sees identical history. */
export const DEFAULT_SEED = 20260904;
