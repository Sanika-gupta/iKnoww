import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { seedIfEmpty, isEmpty, ALL_INSTRUMENTS, STOCKS, FUNDS, REFERENCES } from '../../src/lib/db/seed';
import { SCHEMA_SQL } from '../../src/lib/db/schema';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

describe('seed-on-empty-boot', () => {
  it('seeds an empty database', () => {
    const db = freshDb();
    expect(isEmpty(db)).toBe(true);

    expect(seedIfEmpty(db)).toBe(true);

    expect(isEmpty(db)).toBe(false);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM instruments').get() as { n: number };
    expect(n).toBe(ALL_INSTRUMENTS.length);
  });

  it('is idempotent: a second boot changes nothing', () => {
    const db = freshDb();
    seedIfEmpty(db);
    const before = db.prepare('SELECT COUNT(*) AS n FROM instruments').get() as { n: number };

    // This is what a warm restart does. It must not duplicate or throw.
    expect(seedIfEmpty(db)).toBe(false);

    const after = db.prepare('SELECT COUNT(*) AS n FROM instruments').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('creates exactly one default user and one default watchlist', () => {
    const db = freshDb();
    seedIfEmpty(db);

    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    const lists = db.prepare('SELECT COUNT(*) AS n FROM watchlists').get() as { n: number };
    expect(users.n).toBe(1);
    expect(lists.n).toBe(1);
  });

  it('gives every non-reference instrument a reference that actually exists', () => {
    const db = freshDb();
    seedIfEmpty(db);

    // Conviction is always the residual against a reference (D-024). An
    // instrument with a dangling reference could never be scored.
    const orphans = db
      .prepare(
        `SELECT i.symbol FROM instruments i
         WHERE i.is_reference = 0
           AND (i.reference_symbol IS NULL
                OR i.reference_symbol NOT IN (SELECT symbol FROM instruments))`,
      )
      .all();
    expect(orphans).toEqual([]);
  });

  it('has the intended shape: 9 stocks, 3 funds, 3 references', () => {
    expect(STOCKS).toHaveLength(9);
    expect(FUNDS).toHaveLength(3);
    expect(REFERENCES).toHaveLength(3);
  });

  it('every fund is benchmarked, since a fund NAV is meaningless without one', () => {
    for (const fund of FUNDS) {
      expect(fund.referenceSymbol).toBeTruthy();
    }
  });
});
