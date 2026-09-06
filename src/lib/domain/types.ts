/**
 * Core domain types. Shared verbatim between server and browser, which is the
 * main reason this project is TypeScript end to end (D-018).
 */

// ---------------------------------------------------------------- instruments

export type InstrumentType = 'STOCK' | 'FUND';

export interface Instrument {
  symbol: string;
  name: string;
  instrumentType: InstrumentType;
  /** Market index for a stock, stated benchmark for a fund. See D-024. */
  referenceSymbol: string | null;
  sector: string | null;
}

/**
 * How stale a price may be before it stops being allowed to move a state.
 * Type-aware on purpose: a 14-hour-old NAV is perfectly normal while a
 * 10-minute-old quote is not. Never cry wolf on a fund (D-025).
 */
export const STALENESS_LIMIT_MS: Record<InstrumentType, number> = {
  STOCK: 10 * 60 * 1000, // 10 minutes
  FUND: 30 * 60 * 60 * 1000, // 30 hours, comfortably past one NAV cycle
};

/**
 * The same limits for the live feed, and the widened one is not a fudge.
 *
 * Yahoo delivers NSE quotes about fifteen minutes behind the exchange, measured
 * from the feed's own timestamps rather than recalled: on 4 September the quote
 * for TCS was stamped 15:15 against a 15:30 close. Against a ten-minute limit
 * EVERY live quote is stale, no card can ever change state, and live mode would
 * look broken while behaving exactly as designed.
 *
 * So the stock limit becomes twenty minutes in live mode: the real delay plus
 * enough room for one missed refresh. What makes this honest rather than a
 * loosened check is that the delay is never hidden. The card, the badge and the
 * tooltip all say the quote is delayed and by how much, computed from the
 * feed's own timestamp rather than from this constant.
 *
 * The fund limit is unchanged. A NAV is published once daily after the close in
 * both modes, so nothing about it differs.
 */
export const STALENESS_LIMIT_MS_LIVE: Record<InstrumentType, number> = {
  STOCK: 20 * 60 * 1000,
  FUND: 30 * 60 * 60 * 1000,
};

// -------------------------------------------------------------------- theses

export type ThesisType =
  | 'DIP_BUY'
  | 'BREAKOUT_BUY'
  | 'ADD_MORE'
  | 'BOOK_PROFIT'
  | 'PROTECT'
  | 'JUST_WATCHING';

export type Direction = 'BELOW' | 'ABOVE';
export type Action = 'BUY' | 'SELL' | 'NONE';

export interface ThesisTemplate {
  type: ThesisType;
  label: string;
  /** Rendered with the threshold substituted for {t}. */
  phrasing: string;
  direction: Direction | null;
  requiresPosition: boolean;
  action: Action;
  /** Shown when the condition is met but conviction is LOW. */
  dilutedLine: string;
  /**
   * The same line for a mutual fund. A fund has a benchmark and a category, not
   * a market and a stock, so "this is not your dip" is stock language wearing a
   * fund's name. Found by reading a real fund card (D-079).
   */
  dilutedLineFund: string;
}

/**
 * Five templates plus a default (D-033). Mechanically there are only two
 * conditions, price-below and price-above; a template is a row of config, not
 * a code path. Split by whether a position is held, which is what makes the
 * list prescriptive rather than an arbitrary menu.
 */
export const THESIS_TEMPLATES: Record<ThesisType, ThesisTemplate> = {
  DIP_BUY: {
    type: 'DIP_BUY',
    label: 'Buy the dip',
    phrasing: 'Buy if it falls below {t}',
    direction: 'BELOW',
    requiresPosition: false,
    action: 'BUY',
    dilutedLine: 'This is not your dip.',
    dilutedLineFund: 'This is a category-wide fall, not a fund problem.',
  },
  BREAKOUT_BUY: {
    type: 'BREAKOUT_BUY',
    label: 'Buy the breakout',
    phrasing: 'Buy if it rises above {t}',
    direction: 'ABOVE',
    requiresPosition: false,
    action: 'BUY',
    dilutedLine: 'This is not your breakout. The whole market is up.',
    dilutedLineFund: 'This is not your breakout. The whole category is up.',
  },
  ADD_MORE: {
    type: 'ADD_MORE',
    label: 'Add more',
    phrasing: 'Add to my position if it falls below {t}',
    direction: 'BELOW',
    requiresPosition: true,
    action: 'BUY',
    dilutedLine: 'The market fell, not this stock. Adding here is buying the market.',
    dilutedLineFund: 'The category fell, not this fund. Adding here is buying the benchmark.',
  },
  BOOK_PROFIT: {
    type: 'BOOK_PROFIT',
    label: 'Book profit',
    phrasing: 'Book profit if it rises above {t}',
    direction: 'ABOVE',
    requiresPosition: true,
    action: 'SELL',
    dilutedLine: 'Your target hit on a market rally, not on company strength.',
    dilutedLineFund: 'Your target hit on a category rally, not on the manager beating the benchmark.',
  },
  PROTECT: {
    type: 'PROTECT',
    label: 'Protect my position',
    phrasing: 'Exit if it falls below {t}',
    direction: 'BELOW',
    requiresPosition: true,
    action: 'SELL',
    // The strongest sentence in the product. Panic-selling into a market-wide
    // fall is the most destructive thing a retail investor does.
    dilutedLine: 'You would be selling the market, not exiting your thesis.',
    dilutedLineFund: 'You would be selling the whole category, not exiting your thesis.',
  },
  JUST_WATCHING: {
    type: 'JUST_WATCHING',
    label: 'Just watching',
    phrasing: 'No conditions, tell me if something odd happens',
    direction: null,
    requiresPosition: false,
    action: 'NONE',
    dilutedLine: '',
    dilutedLineFund: '',
  },
};

/**
 * A template as a picker needs it.
 *
 * `prompt` exists because the raw `phrasing` carries a `{t}` placeholder that
 * only means anything once a threshold is known, and a picker showing a literal
 * "{t}" to a user is a defect (D-076). `requiresThreshold` is derived here
 * rather than restated anywhere, which is the whole reason this lives beside
 * the templates: the price input was once gated on a hand-copied parallel list
 * that had simply omitted the flag, so the box never appeared and the form
 * could not be completed (D-125).
 *
 * It sits in `domain` rather than in `watchlist/templates` because the browser
 * needs it too, and nothing the browser imports should reach a module that
 * mentions the database.
 */
export interface ThesisChoice extends ThesisTemplate {
  /** Phrasing with the threshold shown as a blank to be filled. */
  prompt: string;
  requiresThreshold: boolean;
}

const THRESHOLD_BLANK = '₹—';

export function asChoice(template: ThesisTemplate): ThesisChoice {
  return {
    ...template,
    prompt: template.phrasing.replace('{t}', THRESHOLD_BLANK),
    requiresThreshold: template.direction !== null,
  };
}

/**
 * The theses offerable on something the app has never seen.
 *
 * A searched instrument has no position by construction, so this is exactly the
 * no-position set the server would return, derived from the same table rather
 * than typed out again.
 */
export const ENTRY_CHOICES: ThesisChoice[] = Object.values(THESIS_TEMPLATES)
  .filter((t) => !t.requiresPosition)
  .map(asChoice);

export interface ThesisParams {
  /** Absent for JUST_WATCHING. */
  threshold?: number;
}

// -------------------------------------------------------------------- states

/**
 * Five states (D-050). INVALIDATED was folded into NEEDS_REVIEW-confounded,
 * which carries the same meaning and the same alert behaviour.
 */
export type ItemState =
  | 'WATCHING'
  | 'ACTIONABLE'
  | 'NEEDS_REVIEW'
  | 'UNEXPLAINED'
  | 'FULFILLED';

/** Which states are allowed to send a notification. Low conviction never does. */
export const ALERTABLE_STATES: ReadonlySet<ItemState> = new Set<ItemState>([
  'ACTIONABLE',
  'UNEXPLAINED',
]);

// ---------------------------------------------------------------- conviction

export type ConvictionBand = 'LOW' | 'HIGH' | 'EXTREME' | 'UNKNOWN';

/** Band boundaries on |z|. Both tails route to review; only the middle is clean. */
export const Z_LOW_MAX = 1.0;
export const Z_EXTREME_MIN = 2.5;
/** A large idiosyncratic move with no condition met becomes UNEXPLAINED. */
export const Z_UNEXPLAINED_MIN = 2.5;
/**
 * Window length for the statistics.
 *
 * 250 observations, about a trading year, not the 60 first planned. At 60 the
 * standard error on beta is 0.14 to 0.23 for our instruments, which is far too
 * loose to put "82% of this move was the market" in front of someone. At 250 it
 * halves, and the resulting error in the surprise score is about 0.10 against
 * band widths of 1.0 and 2.5. The cost is generated history, so it is free.
 */
export const MIN_WINDOW_OBS = 120;
export const WINDOW_OBS = 250;

export interface Conviction {
  band: ConvictionBand;
  /** Surprise score: residual over its own standard deviation. Null if UNKNOWN. */
  z: number | null;
  /** 0..1 share of the move explained by the reference. Null if UNKNOWN. */
  shareReference: number | null;
  beta: number | null;
  referenceSymbol: string | null;
  referenceReturn: number | null;
  instrumentReturn: number | null;
  /** Why we could not compute, when band is UNKNOWN. */
  unknownReason?: 'INSUFFICIENT_HISTORY' | 'ZERO_REFERENCE_VARIANCE' | 'NO_REFERENCE';
}

export const UNKNOWN_CONVICTION: Conviction = {
  band: 'UNKNOWN',
  z: null,
  shareReference: null,
  beta: null,
  referenceSymbol: null,
  referenceReturn: null,
  instrumentReturn: null,
  unknownReason: 'INSUFFICIENT_HISTORY',
};
