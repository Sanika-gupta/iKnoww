import { THESIS_TEMPLATES, type ThesisType } from '../domain/types';

/**
 * The thesis parser.
 *
 * This is the one capability in the Ask panel that is NOT scripted. Turning
 * "watch HDFC Bank, add more below 1500" into a template, a symbol and a
 * threshold is about a hundred lines of deterministic matching, and it genuinely
 * works on input nobody anticipated. That is both more honest and more
 * impressive than a lookup table, and it makes adding a thesis a five-second act
 * rather than a three-field form.
 *
 * It never saves anything. It shows back what it understood and waits for
 * confirmation, because a wrong symbol on a real order is unacceptable and the
 * cost of asking is one tap.
 */

export interface ParsedThesis {
  symbol: string;
  thesisType: ThesisType;
  threshold?: number;
  /** The sentence to show back for confirmation. */
  restated: string;
}

export type ParseFailure =
  | { reason: 'NO_SYMBOL'; understood: string }
  | { reason: 'AMBIGUOUS_SYMBOL'; candidates: string[]; understood: string }
  | { reason: 'NO_THRESHOLD'; symbol: string; thesisType: ThesisType; understood: string }
  | { reason: 'NO_INTENT'; symbol: string; understood: string };

export type ParseResult = { ok: true; thesis: ParsedThesis } | { ok: false; failure: ParseFailure };

export interface Candidate {
  symbol: string;
  name: string;
}

/** Phrases that pick a template, longest and most specific first. */
const INTENTS: Array<{ type: ThesisType; patterns: RegExp[] }> = [
  { type: 'ADD_MORE', patterns: [/\badd (?:more|to)\b/, /\btop up\b/, /\baverage down\b/] },
  { type: 'BOOK_PROFIT', patterns: [/\bbook (?:profit|profits)\b/, /\btake profit\b/] },
  {
    type: 'PROTECT',
    patterns: [/\b(?:exit|stop|protect|get out|sell out|cut)\b/, /\bstop[- ]?loss\b/],
  },
  { type: 'BREAKOUT_BUY', patterns: [/\bbreakout\b/, /\bbuy .*\babove\b/, /\bbuy .*\bover\b/] },
  { type: 'DIP_BUY', patterns: [/\bdip\b/, /\bbuy\b/] },
  { type: 'JUST_WATCHING', patterns: [/\bjust watch(?:ing)?\b/, /\bkeep an eye\b/, /\btrack\b/] },
];

const ABOVE = /\b(?:above|over|crosses?|breaks?|higher than|more than|>=?)\b/;
const BELOW = /\b(?:below|under|beneath|drops? to|falls? to|less than|<=?)\b/;

/** Normalises "1,500", "1500", "₹1500", "1.5k" and "1.5 lakh" to a number. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, '').toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(k|l|lakh|cr|crore)?$/.exec(cleaned);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'k':
      return n * 1_000;
    case 'l':
    case 'lakh':
      return n * 100_000;
    case 'cr':
    case 'crore':
      return n * 10_000_000;
    default:
      return n;
  }
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Resolves a symbol from free text.
 *
 * Matches the ticker, the full name, and any run of words from the name, so
 * "HDFC Bank", "hdfcbank" and "hdfc" all reach the same instrument. Where a
 * fragment genuinely matches several, it refuses and presents the candidates
 * rather than guessing.
 */
export function resolveSymbol(
  text: string,
  universe: Candidate[],
): { symbol: string } | { candidates: string[] } | null {
  const hay = normalise(text);
  const exact = universe.filter((c) => hay.includes(normalise(c.symbol)));
  if (exact.length === 1) return { symbol: exact[0].symbol };
  if (exact.length > 1) return { candidates: exact.map((c) => c.symbol) };

  const scored: Array<{ symbol: string; score: number }> = [];
  for (const c of universe) {
    const words = normalise(c.name).split(' ').filter((w) => w.length > 2);
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;
    if (score > 0) scored.push({ symbol: c.symbol, score });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].score;
  const tied = scored.filter((s) => s.score === best);
  if (tied.length > 1) return { candidates: tied.map((t) => t.symbol) };
  return { symbol: scored[0].symbol };
}

function detectIntent(text: string): ThesisType | null {
  for (const intent of INTENTS) {
    for (const p of intent.patterns) if (p.test(text)) return intent.type;
  }
  return null;
}

/**
 * Pulls the threshold out, preferring a number that follows a direction word so
 * that "add more HDFC below 1500" does not pick up a quantity mentioned earlier.
 */
function detectThreshold(text: string): number | null {
  const directional =
    /\b(?:above|over|crosses?|breaks?|below|under|beneath|drops? to|falls? to|at)\s*(₹?\s*[\d,]+(?:\.\d+)?\s*(?:k|l|lakh|cr|crore)?)/i.exec(
      text,
    );
  if (directional) {
    const v = parseAmount(directional[1]);
    if (v !== null && v > 0) return v;
  }
  const any = /(₹?\s*[\d,]+(?:\.\d+)?\s*(?:k|l|lakh|cr|crore)?)/i.exec(text);
  if (!any) return null;
  const v = parseAmount(any[1]);
  return v !== null && v > 0 ? v : null;
}

export function parseThesis(input: string, universe: Candidate[]): ParseResult {
  const text = input.toLowerCase().trim();

  const resolved = resolveSymbol(text, universe);
  if (resolved === null) {
    return { ok: false, failure: { reason: 'NO_SYMBOL', understood: describeUnderstood(text) } };
  }
  if ('candidates' in resolved) {
    return {
      ok: false,
      failure: {
        reason: 'AMBIGUOUS_SYMBOL',
        candidates: resolved.candidates,
        understood: describeUnderstood(text),
      },
    };
  }

  let thesisType = detectIntent(text);
  if (thesisType === null) {
    // A bare direction still tells us the shape of the intent.
    if (ABOVE.test(text)) thesisType = 'BREAKOUT_BUY';
    else if (BELOW.test(text)) thesisType = 'DIP_BUY';
  }
  if (thesisType === null) {
    return {
      ok: false,
      failure: { reason: 'NO_INTENT', symbol: resolved.symbol, understood: describeUnderstood(text) },
    };
  }

  // A direction word overrides the template's default where they disagree, so
  // "book profit on ITC below 400" is read as a protective exit rather than
  // silently flipped into a target above.
  if (thesisType === 'DIP_BUY' && ABOVE.test(text)) thesisType = 'BREAKOUT_BUY';
  if (thesisType === 'BREAKOUT_BUY' && BELOW.test(text)) thesisType = 'DIP_BUY';
  if (thesisType === 'BOOK_PROFIT' && BELOW.test(text)) thesisType = 'PROTECT';

  const template = THESIS_TEMPLATES[thesisType];
  if (template.direction === null) {
    return {
      ok: true,
      thesis: {
        symbol: resolved.symbol,
        thesisType,
        restated: `Just watch ${resolved.symbol}, and tell me if something odd happens.`,
      },
    };
  }

  const threshold = detectThreshold(text);
  if (threshold === null) {
    return {
      ok: false,
      failure: {
        reason: 'NO_THRESHOLD',
        symbol: resolved.symbol,
        thesisType,
        understood: `${template.label} on ${resolved.symbol}`,
      },
    };
  }

  return {
    ok: true,
    thesis: {
      symbol: resolved.symbol,
      thesisType,
      threshold,
      restated: `${resolved.symbol}: ${template.phrasing.replace(
        '{t}',
        `₹${threshold.toLocaleString('en-IN')}`,
      )}.`,
    },
  };
}

/** What we did understand, so a failure is a conversation rather than a refusal. */
function describeUnderstood(text: string): string {
  const bits: string[] = [];
  const intent = detectIntent(text);
  if (intent) bits.push(THESIS_TEMPLATES[intent].label.toLowerCase());
  const threshold = detectThreshold(text);
  if (threshold !== null) bits.push(`a price of ₹${threshold.toLocaleString('en-IN')}`);
  if (ABOVE.test(text)) bits.push('a level above');
  else if (BELOW.test(text)) bits.push('a level below');
  return bits.length === 0 ? 'nothing usable' : bits.join(', ');
}
