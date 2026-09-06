import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA_SQL } from './schema';
import { seedIfEmpty, seedLiveIfEmpty } from './seed';
import { seedDemoWatchlistIfEmpty } from './demo-seed';
import { backfillIfEmpty } from '../sim/backfill';
import { computeAllStats } from '../engine/stats';
import { initSimIfEmpty } from '../sim/ticker';
import { DEFAULT_MODE, type FeedMode } from '../domain/mode';

/**
 * Database access.
 *
 * Two properties matter more than anything else here:
 *
 * 1. SEED ON EMPTY BOOT (D-061). If the database is missing or empty we create
 *    and seed it. That is what makes `npm run dev` work on a fresh clone with no
 *    setup step, and what makes ephemeral serverless hosting acceptable rather
 *    than broken: every byte of data in this app is simulated, so a cold start
 *    that reseeds is correct, not lossy.
 *
 * 2. WAL mode, so readers never block on the writer.
 *
 * Boot order matters: seed the universe, generate history, then compute
 * statistics from that history. The statistics step reads only the database, so
 * it is the same code path that would run against a real feed.
 */

/*
 * One handle per mode, not one handle. A single slot would mean whichever mode
 * booted first owned the process for its lifetime, and every request in the
 * other mode would silently read and write the wrong database. Keyed on the
 * mode, so the two can never be confused.
 */
const instances = new Map<FeedMode, Database.Database>();

const DB_FILE: Record<FeedMode, string> = {
  sim: 'iknoww.db',
  live: 'iknoww-live.db',
};

function resolveDbPath(mode: FeedMode): string {
  // ':memory:' keeps serverless cold starts fast and is perfectly correct here,
  // because seeding is deterministic and the data is simulated anyway.
  if (process.env.DB_IN_MEMORY === '1') return ':memory:';
  // DB_DIR names the directory, because there are two files and one path
  // variable cannot address both. DB_PATH is still honoured for simulated mode
  // so an existing deployment does not break on this change.
  if (mode === 'sim' && process.env.DB_PATH) return process.env.DB_PATH;
  const dir = process.env.DB_DIR ?? join(process.cwd(), 'data');
  return join(dir, DB_FILE[mode]);
}

function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

export function getDb(mode: FeedMode = DEFAULT_MODE): Database.Database {
  const existing = instances.get(mode);
  if (existing) return existing;

  const path = resolveDbPath(mode);
  if (path !== ':memory:') {
    // Create the directory rather than asking the user to. No setup step.
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  applySchema(db);
  if (mode === 'live') bootstrapLive(db);
  else bootstrap(db, true);

  instances.set(mode, db);
  return db;
}

/**
 * Brings a database from empty to usable. Every step is a no-op if already done,
 * so a warm restart costs nothing and a cold one needs no setup command.
 */
/**
 * The only migration in the project, and it exists because the alternative is a
 * manual step. A database created before `users.name` existed would otherwise
 * have to be deleted by hand, and the README promises no such step. Adding the
 * column is idempotent, so running it on every boot is safe and cheap.
 */
function migrate(db: Database.Database): void {
  const users = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!users.some((c) => c.name === 'name')) {
    db.exec("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT 'there'");
  }

  const lists = db.prepare('PRAGMA table_info(watchlists)').all() as Array<{ name: string }>;
  if (!lists.some((c) => c.name === 'removed_at')) {
    db.exec('ALTER TABLE watchlists ADD COLUMN removed_at INTEGER');
  }

  const sim = db.prepare('PRAGMA table_info(sim_state)').all() as Array<{ name: string }>;
  if (!sim.some((c) => c.name === 'session')) {
    db.exec('ALTER TABLE sim_state ADD COLUMN session INTEGER NOT NULL DEFAULT 0');
  }

  const alerts = db.prepare('PRAGMA table_info(alerts)').all() as Array<{ name: string }>;
  if (!alerts.some((c) => c.name === 'session')) {
    db.exec('ALTER TABLE alerts ADD COLUMN session INTEGER NOT NULL DEFAULT 0');
  }

  // The live feed's four columns. A database created before live mode existed
  // is a simulated one, and 'sim' is the default, so the backfill is correct.
  const simCols = db.prepare('PRAGMA table_info(sim_state)').all() as Array<{ name: string }>;
  const has = (c: string) => simCols.some((x) => x.name === c);
  if (!has('mode')) db.exec("ALTER TABLE sim_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'sim'");
  if (!has('session_start')) db.exec('ALTER TABLE sim_state ADD COLUMN session_start INTEGER');
  if (!has('session_end')) db.exec('ALTER TABLE sim_state ADD COLUMN session_end INTEGER');
  if (!has('last_refresh_at')) {
    db.exec('ALTER TABLE sim_state ADD COLUMN last_refresh_at INTEGER');
  }
  if (!has('session_opens_day')) {
    db.exec('ALTER TABLE sim_state ADD COLUMN session_opens_day INTEGER');
  }
}

export function bootstrap(db: Database.Database, withDemoWatchlist = false): void {
  migrate(db);
  const seeded = seedIfEmpty(db);
  const filled = backfillIfEmpty(db);
  // Statistics are recomputed whenever new history arrived. They are a fixed
  // cost over the whole instrument universe, independent of users (D-040).
  if (seeded || filled) computeAllStats(db);

  if (withDemoWatchlist) {
    // Order matters: opening prices must exist before a thesis can be priced
    // against them, and the statistics must exist before a card can be
    // evaluated on the way in.
    initSimIfEmpty(db);
    seedDemoWatchlistIfEmpty(db);
  }
}

/**
 * Brings a LIVE database from empty to usable, and it is deliberately not
 * `bootstrap`. Four things it must not do:
 *
 *   - seed the twelve simulated instruments. Live starts with the three
 *     reference indices and nothing else; every other instrument arrives when
 *     someone searches for and adds it.
 *   - generate simulated price history. Real history is fetched per symbol.
 *   - run the simulated ticker. There are no ticks in live mode.
 *   - seed the demo watchlist. Live starts empty.
 *
 * What it MUST still do is create a `sim_state` row. Five places in the engine
 * read `SELECT sim_now FROM sim_state WHERE id = 1` and cast the result as
 * non-null; without the row they throw, and the board renders 1 January 1970.
 * The row is the reason live mode boots at all.
 *
 * The three reference indices and their opening prices are fetched by the feed
 * layer on the first refresh. Until then the database is empty but coherent:
 * one user, one empty watchlist, one clock.
 */
export function bootstrapLive(db: Database.Database): void {
  migrate(db);
  seedLiveIfEmpty(db);
}

/** Used by tests to get an isolated, fully bootstrapped database. */
export function createTestDb(withDemoWatchlist = false): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  bootstrap(db, withDemoWatchlist);
  return db;
}

/**
 * An isolated LIVE database for tests. Separate from `createTestDb` on purpose:
 * thirteen test files call that one, and changing its signature to carry a mode
 * would have touched every one of them to describe something they do not use.
 */
export function createLiveTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  bootstrapLive(db);
  return db;
}
