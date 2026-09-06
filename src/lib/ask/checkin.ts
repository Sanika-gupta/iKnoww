import { THESIS_TEMPLATES, type ThesisType } from '../domain/types';
import type { ConvictionResult } from '../engine/conviction';

/**
 * The pre-trade check-in.
 *
 * When someone is about to act past a weak signal, we ask one question drawn
 * from their own thesis rather than showing another warning. A warning is
 * something to dismiss; a question is something to answer, and the answer is
 * stored beside the conviction snapshot on the order.
 *
 * That is what turns "your trade remembers why you made it" from a record into
 * a reason. It also slows a weak decision without blocking it, which is the line
 * this product holds everywhere: inform, never override.
 *
 * Every number in the question is interpolated from the live conviction payload.
 * Nothing here is a canned string, so running a different scenario produces a
 * different question with different figures.
 */

export interface CheckIn {
  question: string;
  /** Shown under the question, so the user can see what prompted it. */
  context: string;
}

export function checkInFor(
  symbol: string,
  thesisType: ThesisType,
  conviction: ConvictionResult,
): CheckIn | null {
  if (conviction.band === 'HIGH') return null;

  const template = THESIS_TEMPLATES[thesisType];
  const share = conviction.shareReference;
  const referenceShare = share === null ? null : Math.round(share * 100);
  const refWord = conviction.referenceSymbol === null ? 'the market' : 'the market';

  if (conviction.band === 'UNKNOWN') {
    return {
      question: `We cannot tell yet how much of this move is about ${symbol} itself. Do you want to go ahead without that?`,
      context: conviction.explanation,
    };
  }

  if (conviction.band === 'EXTREME') {
    return {
      question: `Your thesis assumed a drift, and this is a shock. Does it still hold?`,
      context: conviction.explanation,
    };
  }

  // LOW: the diluted case, which is where this matters most.
  const opener =
    referenceShare === null
      ? `Most of this move was ${refWord}, not ${symbol}.`
      : `${referenceShare}% of this move was ${refWord}, not ${symbol}.`;

  if (template.action === 'SELL') {
    return {
      question: `${opener} Has your view of ${symbol} itself changed, or is this about the market?`,
      context: conviction.explanation,
    };
  }
  return {
    question: `Your thesis was about ${symbol}, but ${opener.toLowerCase()} Has your view of ${symbol} itself changed?`,
    context: conviction.explanation,
  };
}
