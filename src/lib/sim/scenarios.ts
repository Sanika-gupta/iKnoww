/**
 * Scenario definitions.
 *
 * These are not demo choreography, they are product UI (D-055). No video is
 * required at submission and judges will run the app themselves, so every
 * interesting behaviour needs a market event that a stranger can trigger from
 * the main screen within thirty seconds of loading.
 *
 * A scenario is a list of shocks applied on top of the ordinary factor model,
 * indexed by how many ticks into the scenario we are.
 */

export interface Shock {
  /** Tick within the scenario at which this applies. */
  atTick: number;
  /** Extra return applied to the root market factor this tick. */
  market?: number;
  /** Extra return applied to a specific symbol, on top of its market response. */
  symbol?: string;
  amount?: number;
  /** Stop delivering price updates for stocks, to exercise the freshness gate. */
  freezeQuotes?: boolean;
  /**
   * Re-publish a symbol's price as a correction of an earlier event, which
   * rolls back any state change that the bad price caused.
   */
  correct?: { symbol: string; toPrice: number; correctsTicksAgo: number };
}

export interface Scenario {
  id: string;
  label: string;
  /** One line the UI shows so a judge knows what they are about to see. */
  blurb: string;
  lengthTicks: number;
  /** Minutes of simulated market time each tick represents. */
  minutesPerTick: number;
  shocks: Shock[];
}

/**
 * Every scenario is short enough to sit inside a five-minute demo, and each one
 * exists to prove exactly one claim.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: 'market-crash',
    label: 'Market crash',
    blurb:
      'The whole market falls about 3%. Watch triggers fire and stay silent, because the move is not about your stocks.',
    lengthTicks: 12,
    minutesPerTick: 5,
    // Spread across several ticks so it looks like a slide rather than a jump.
    shocks: [
      { atTick: 1, market: -0.006 },
      { atTick: 2, market: -0.005 },
      { atTick: 3, market: -0.004 },
      { atTick: 4, market: -0.005 },
      { atTick: 5, market: -0.004 },
      { atTick: 6, market: -0.003 },
      { atTick: 7, market: -0.002 },
      { atTick: 8, market: -0.001 },
    ],
  },
  {
    id: 'single-stock-shock',
    label: 'Single-stock shock',
    blurb:
      'One stock moves hard while the market sits still. Nothing in your thesis anticipated it, so this is the one that earns a notification.',
    lengthTicks: 8,
    minutesPerTick: 5,
    shocks: [
      { atTick: 2, symbol: 'DIVISLAB', amount: 0.032 },
      { atTick: 3, symbol: 'DIVISLAB', amount: 0.021 },
      { atTick: 4, symbol: 'DIVISLAB', amount: 0.012 },
    ],
  },
  {
    id: 'away-window',
    label: 'Six hours away',
    blurb:
      'Compresses six hours of market into a few seconds. Close the tab first: this is what you come back to.',
    lengthTicks: 24,
    minutesPerTick: 15,
    shocks: [
      { atTick: 4, market: -0.004 },
      { atTick: 9, symbol: 'INFY', amount: -0.026 },
      { atTick: 15, market: 0.003 },
      { atTick: 18, symbol: 'SBIN', amount: 0.019 },
    ],
  },
  {
    id: 'correction',
    label: 'Bad tick, then a correction',
    blurb:
      'A wrong price arrives and moves a card. The exchange corrects it. Watch the state roll back and the alert get retracted rather than quietly dropped.',
    lengthTicks: 12,
    minutesPerTick: 5,
    shocks: [
      // Phase one: quotes freeze while fund NAVs stay perfectly normal, which is
      // what type-aware freshness has to get right (D-025).
      { atTick: 1, freezeQuotes: true },
      { atTick: 2, freezeQuotes: true },
      { atTick: 3, freezeQuotes: true },
      // Phase two: a bad print, then the correction three ticks later.
      { atTick: 5, symbol: 'TCS', amount: -0.038 },
      { atTick: 8, correct: { symbol: 'TCS', toPrice: 0, correctsTicksAgo: 3 } },
    ],
  },
];

export const SCENARIOS_BY_ID: Record<string, Scenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s]),
);
