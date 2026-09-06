import type { ConvictionBand, InstrumentType } from '../domain/types';

/**
 * The sentence a card actually shows.
 *
 * Generated from the numbers rather than chosen from a list, so it can never
 * claim something the data does not support.
 *
 * The rule that matters here was found by reading real output. An attribution
 * split is only meaningful when there is a move worth splitting. A stock that
 * drifted 0.4% on a flat day is genuinely "88% stock-specific", and saying so
 * out loud is technically true and completely misleading: it sounds like an
 * alarm about nothing. So a move smaller than the instrument's own ordinary
 * daily noise gets told plainly that nothing is happening, which is also what
 * makes "nothing changed" a designed state rather than an empty one.
 */

export interface ExplainInput {
  instrumentType: InstrumentType;
  band: ConvictionBand;
  /** 0..1 share of the move attributable to the reference. */
  shareReference: number;
  referenceReturn: number;
  instrumentReturn: number;
  z: number;
  /** The instrument's ordinary daily idiosyncratic move, used as the yardstick. */
  idioVol: number;
}

/** Percent with no sign and no negative zero. */
function pct(x: number, dp = 0): string {
  const v = Math.abs(x) * 100;
  return `${v.toFixed(dp)}%`;
}

/** Signed percent, but never renders "-0.0%". */
function signedPct(x: number, dp = 1): string {
  const v = x * 100;
  const rounded = Number(v.toFixed(dp));
  if (rounded === 0) return `${(0).toFixed(dp)}%`;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(dp)}%`;
}

export function explain(input: ExplainInput): string {
  const { instrumentType, band, shareReference, referenceReturn, instrumentReturn, z, idioVol } = input;
  const isFund = instrumentType === 'FUND';
  const refWord = isFund ? 'its benchmark' : 'the market';
  const selfWord = isFund ? 'the fund' : 'the stock';

  // Nothing worth explaining. The move is inside a normal day's noise.
  if (Math.abs(instrumentReturn) < idioVol && band === 'LOW') {
    return 'Moving normally. Nothing unusual today.';
  }

  if (band === 'LOW') {
    return isFund
      ? `${pct(shareReference)} of this is ${refWord} moving ${signedPct(referenceReturn)}. Tracking, not diverging.`
      : `${pct(shareReference)} of this move is ${refWord} (${signedPct(referenceReturn)}), only ${pct(1 - shareReference)} is ${selfWord} itself.`;
  }

  if (band === 'EXTREME') {
    return `${pct(1 - shareReference)} of this move is ${selfWord} itself, ${Math.abs(z).toFixed(1)}× its normal. ${refWord[0].toUpperCase()}${refWord.slice(1)} moved ${signedPct(referenceReturn)}.`;
  }

  // HIGH: a real, instrument-specific move of ordinary size.
  return `${pct(1 - shareReference)} of this move is ${selfWord} itself. ${refWord[0].toUpperCase()}${refWord.slice(1)} moved ${signedPct(referenceReturn)}.`;
}
