import type Database from 'better-sqlite3';
import {
  asChoice,
  THESIS_TEMPLATES,
  type ThesisChoice,
  type ThesisType,
} from '../domain/types';

// Re-exported so existing callers keep one import site, while the browser can
// reach the same definitions without importing this module at all (D-125).
export { asChoice, type ThesisChoice };

/**
 * Which theses may be offered for a given instrument.
 *
 * The organising idea is the position (D-033). If you do not hold something,
 * your thesis is about entry. If you hold it, it is about exit or adding. That
 * split is what makes five templates prescriptive rather than a longer menu, and
 * it is why the picker can hide what cannot apply instead of offering it and
 * then refusing.
 *
 * Gating is enforced here on the server, not only in the UI. The same reasoning
 * as validating a sell against the position: a UI rule is a suggestion, and the
 * API is reachable without it.
 */

export function positionQuantity(db: Database.Database, userId: string, symbol: string): number {
  const row = db
    .prepare('SELECT quantity FROM positions WHERE user_id = ? AND symbol = ?')
    .get(userId, symbol) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

export function hasPosition(db: Database.Database, userId: string, symbol: string): boolean {
  return positionQuantity(db, userId, symbol) > 0;
}

export function templatesFor(
  db: Database.Database,
  userId: string,
  symbol: string,
): ThesisChoice[] {
  const held = hasPosition(db, userId, symbol);
  return Object.values(THESIS_TEMPLATES)
    .filter((t) => held || !t.requiresPosition)
    .map(asChoice);
}

export function isTemplateAllowed(
  db: Database.Database,
  userId: string,
  symbol: string,
  type: ThesisType,
): boolean {
  const template = THESIS_TEMPLATES[type];
  if (!template) return false;
  return !template.requiresPosition || hasPosition(db, userId, symbol);
}

/** The sentence a card shows for its thesis, with the threshold filled in. */
export function phraseThesis(type: ThesisType, threshold?: number): string {
  const template = THESIS_TEMPLATES[type];
  if (!template.direction || threshold === undefined) return template.phrasing;
  return template.phrasing.replace(
    '{t}',
    `₹${threshold.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
  );
}
