import type Database from 'better-sqlite3';
import { addItem } from '../watchlist/items';
import { currentPrice } from '../sim/ticker';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from './seed';
import type { ThesisType } from '../domain/types';

/**
 * A watchlist that already has something in it.
 *
 * No video is required at submission, so judges run the app themselves and land
 * wherever the first screen puts them. An empty watchlist would make the product
 * look inert and put a data-entry task between a stranger and the idea, so the
 * demo user arrives with five theses and two positions already in place (D-081).
 *
 * The five are chosen to tell the whole story in one crash: a dip trigger that
 * fires and is diluted, a protective stop that fires and is diluted (the most
 * valuable moment in the product), an index fund that tracked its benchmark, a
 * dip trigger far enough away that it correctly does nothing, and a card with no
 * thesis at all so the surprise detector has somewhere to land.
 *
 * There are two lists, because a feature nobody can see on the first screen may
 * as well not exist (D-081 again). They are named for INTENT rather than for
 * sectors, since intent is what this product is built on.
 *
 * The whole crash story stays inside "Long term", so the demo beat is untouched
 * by the split. "Waiting for dips" exists to show the case that makes multiple
 * lists non-trivial: RELIANCE appears in BOTH, under two different theses at two
 * different distances from the price. In a crash one fires and the other
 * correctly does not, and the two carry independent read positions. That is the
 * reason read state was keyed on the item rather than the symbol (D-043).
 */

interface DemoCard {
  symbol: string;
  thesisType: ThesisType;
  /** Threshold as a multiple of the opening price. */
  ratio?: number;
}

const POSITIONS: Array<{ symbol: string; quantity: number; avgPrice: number }> = [
  { symbol: 'INFY', quantity: 50, avgPrice: 1480 },
  { symbol: 'HDFCBANK', quantity: 40, avgPrice: 1610 },
];

/** The second list, created alongside the default one. */
export const DIPS_WATCHLIST_ID = 'wl_dips';

const CARDS: DemoCard[] = [
  { symbol: 'TCS', thesisType: 'DIP_BUY', ratio: 0.98 },
  { symbol: 'INFY', thesisType: 'PROTECT', ratio: 0.98 },
  { symbol: 'UTI_NIFTY50', thesisType: 'DIP_BUY', ratio: 0.98 },
  { symbol: 'HDFCBANK', thesisType: 'BOOK_PROFIT', ratio: 1.06 },
  { symbol: 'RELIANCE', thesisType: 'DIP_BUY', ratio: 0.9 },
  { symbol: 'DIVISLAB', thesisType: 'JUST_WATCHING' },
];

const DIPS_CARDS: DemoCard[] = [
  // Same stock as the long-term list, different thesis, much closer to the
  // price. This is the pair that proves two lists are not two copies.
  { symbol: 'RELIANCE', thesisType: 'DIP_BUY', ratio: 0.98 },
  { symbol: 'ITC', thesisType: 'DIP_BUY', ratio: 0.9 },
  { symbol: 'PPFAS_FLEXI', thesisType: 'DIP_BUY', ratio: 0.9 },
];

function addCards(db: Database.Database, watchlistId: string, cards: DemoCard[]): void {
  for (const card of cards) {
    const price = currentPrice(db, card.symbol);
    if (price === null) continue;
    addItem(db, {
      userId: DEFAULT_USER_ID,
      watchlistId,
      symbol: card.symbol,
      thesisType: card.thesisType,
      params: card.ratio === undefined ? {} : { threshold: Math.round(price * card.ratio) },
    });
  }
}

export function seedDemoWatchlistIfEmpty(db: Database.Database): boolean {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM watchlist_items WHERE watchlist_id = ?')
    .get(DEFAULT_WATCHLIST_ID) as { n: number };
  if (existing.n > 0) return false;

  for (const p of POSITIONS) {
    db.prepare(
      `INSERT INTO positions (user_id, symbol, quantity, avg_price) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, symbol) DO NOTHING`,
    ).run(DEFAULT_USER_ID, p.symbol, p.quantity, p.avgPrice);
  }

  // The generic default list is named for the intent it actually holds, and the
  // second list is created beside it.
  db.prepare('UPDATE watchlists SET name = ? WHERE id = ?').run('Long term', DEFAULT_WATCHLIST_ID);
  db.prepare(
    `INSERT INTO watchlists (id, user_id, name, position) VALUES (?, ?, ?, 1)
     ON CONFLICT (id) DO NOTHING`,
  ).run(DIPS_WATCHLIST_ID, DEFAULT_USER_ID, 'Waiting for dips');

  addCards(db, DEFAULT_WATCHLIST_ID, CARDS);
  addCards(db, DIPS_WATCHLIST_ID, DIPS_CARDS);

  return true;
}
