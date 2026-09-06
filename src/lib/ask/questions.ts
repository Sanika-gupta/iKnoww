/**
 * The seven questions the live feed's Ask panel can be asked (D-133).
 *
 * Pure: no database, no feed, no imports. The browser needs this list to
 * render the buttons and the server needs it to validate a request, and a
 * module that both can import without dragging the database into the client
 * bundle is the same rule that moved the thesis choices into `domain`
 * (D-125). It is also why there is exactly one list: a second copy in the
 * client would drift, and drift here means offering a question the server
 * refuses, or refusing one it would answer.
 */

export type QuestionId =
  | 'MARKET_SHARE'
  | 'UNUSUAL'
  | 'FLAGGED'
  | 'WHERE'
  | 'MARKET'
  | 'MISSED'
  | 'ADVICE';

/**
 * `INDEX` is a thing that can be asked about, not an instrument the engine
 * can hold (D-074, reversed for Ask only in D-134). It is deliberately not an
 * `InstrumentType`.
 */
export type SubjectKind = 'STOCK' | 'FUND' | 'INDEX';

/** What the picker hands over: a search hit, or one of the tracked references. */
export interface AskSubject {
  vendorId: string;
  symbol: string;
  name: string;
  type: SubjectKind;
}

export interface CannedQuestion {
  id: QuestionId;
  text: string;
  /** Which kinds of subject it makes sense for. Empty means no subject needed. */
  kinds: SubjectKind[];
  /** Only offered when the picked instrument is on the board being looked at. */
  watchedOnly?: boolean;
  /**
   * Whether answering READS the instrument, as opposed to merely being offered
   * for one.
   *
   * The distinction exists because of a defect a review found: "Should I buy
   * it?" is offered for a stock, so resolving the subject fetched two years of
   * history before the answer -- a constant refusal -- discarded all of it. A
   * rate-limited feed therefore replaced the product's headline safety
   * guarantee with "the price feed did not answer". **The one answer that must
   * never depend on a third party was the one that did** (D-135).
   */
  readsSubject?: boolean;
}

/**
 * Judgement questions only -- what the app thinks, not what the feed reports.
 * Volume, market cap, day range and P/E are deliberately absent, for the
 * reason the card refuses them (D-130): each is true and none is actionable,
 * and a panel that served them would be a quote lookup with a chat skin.
 * There is no eighth question by construction.
 */
export const QUESTIONS: CannedQuestion[] = [
  { id: 'MARKET_SHARE', text: 'How much of today’s move is the market?', kinds: ['STOCK', 'FUND'], readsSubject: true },
  { id: 'UNUSUAL', text: 'Is anything unusual happening to it?', kinds: ['STOCK', 'FUND'], readsSubject: true },
  {
    id: 'FLAGGED',
    text: 'Why is it flagged, and how far is it from my trigger?',
    kinds: ['STOCK', 'FUND'],
    watchedOnly: true,
    readsSubject: true,
  },
  { id: 'WHERE', text: 'Where does it trade, and how fresh is that?', kinds: ['STOCK', 'FUND', 'INDEX'], readsSubject: true },
  { id: 'MARKET', text: 'How is the market doing?', kinds: ['INDEX'], readsSubject: true },
  { id: 'MISSED', text: 'What did I miss?', kinds: [] },
  // Offered for an instrument, reads nothing about it: the answer is the same
  // refusal whatever was picked, and it must work with the feed down.
  { id: 'ADVICE', text: 'Should I buy it?', kinds: ['STOCK', 'FUND'] },
];

/** The questions to offer for what has been picked. Shared by the UI and the route. */
export function questionsFor(kind: SubjectKind | null, watched: boolean): CannedQuestion[] {
  return QUESTIONS.filter((q) => {
    if (q.kinds.length === 0) return true;
    if (kind === null || !q.kinds.includes(kind)) return false;
    return !q.watchedOnly || watched;
  });
}
