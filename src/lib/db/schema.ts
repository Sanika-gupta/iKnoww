/**
 * The schema, as a module rather than a file read at runtime.
 *
 * It began as schema.sql loaded with readFileSync from process.cwd(). That
 * works on a laptop and is a deployment hazard everywhere else: the working
 * directory of a running server is not the repository root, and a bundler has
 * no reason to ship a .sql file it cannot see being imported. Since this is read
 * on every cold boot, and cold boots are exactly when seed-on-empty-boot has to
 * work, the file was the single most likely thing to make a deployed build fail
 * in a way no local test would catch (D-084).
 *
 * Postgres-compatible on purpose, so migrating off SQLite is a connection string
 * rather than a rewrite.
 */
export const SCHEMA_SQL = `
-- iKnoww schema.
-- Written to be Postgres-compatible so that migrating off SQLite is a
-- connection-string change rather than a rewrite (D-018).
--
-- price_events, thesis_events, orders and alerts are APPEND-ONLY. Every derived
-- view is rebuildable from them, which is what makes correction, rollback and
-- alert retraction tractable rather than terrifying.

CREATE TABLE IF NOT EXISTS instruments (
  symbol            TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  instrument_type   TEXT NOT NULL CHECK (instrument_type IN ('STOCK', 'FUND')),
  reference_symbol  TEXT,
  sector            TEXT,
  is_reference      INTEGER NOT NULL DEFAULT 0
);

-- Append-only. UNIQUE(symbol, seq) makes ingestion idempotent: a duplicate
-- delivery is a no-op rather than a second event.
CREATE TABLE IF NOT EXISTS price_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol             TEXT NOT NULL REFERENCES instruments(symbol),
  seq                INTEGER NOT NULL,
  price              REAL NOT NULL,
  as_of              INTEGER NOT NULL,
  ingested_at        INTEGER NOT NULL,
  corrects_event_id  INTEGER REFERENCES price_events(id),
  UNIQUE (symbol, seq)
);
CREATE INDEX IF NOT EXISTS idx_price_events_symbol_seq ON price_events(symbol, seq DESC);

-- Derived from price_events, used only for the statistics window.
CREATE TABLE IF NOT EXISTS daily_returns (
  symbol   TEXT NOT NULL REFERENCES instruments(symbol),
  day      INTEGER NOT NULL,
  ret      REAL NOT NULL,
  PRIMARY KEY (symbol, day)
);

-- Computed once per symbol and shared by every user. This is the reason adding
-- a user costs zero market-data work (D-040).
CREATE TABLE IF NOT EXISTS symbol_stats (
  symbol      TEXT PRIMARY KEY REFERENCES instruments(symbol),
  beta        REAL,
  idio_vol    REAL,
  window_n    INTEGER NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  -- Greeting someone by name is data, not a string typed into the markup. There
  -- is no authentication here and the README says so plainly; this is the
  -- seeded demo user, and the default keeps the greeting grammatical otherwise.
  name              TEXT NOT NULL DEFAULT 'there',
  quiet_hours_start INTEGER NOT NULL DEFAULT 1290,
  quiet_hours_end   INTEGER NOT NULL DEFAULT 450
);

-- Designed on day one (D-042) and given its UI at D-099. Building the table up
-- front is exactly what made named lists a UI change rather than a migration,
-- and it is why read_state is keyed on the item (D-043): one symbol in two
-- lists carries two theses and therefore two independent read positions.
CREATE TABLE IF NOT EXISTS watchlists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  -- Soft, like every other removal here (D-074). Removed items keep pointing at
  -- their list, so hard-deleting the row breaks the foreign key and would take
  -- the history of every card in it with it.
  removed_at INTEGER
);

-- Keyed on watchlist, not user, so one symbol may carry different theses in
-- different lists.
CREATE TABLE IF NOT EXISTS watchlist_items (
  id            TEXT PRIMARY KEY,
  watchlist_id  TEXT NOT NULL REFERENCES watchlists(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  symbol        TEXT NOT NULL REFERENCES instruments(symbol),
  thesis_type   TEXT NOT NULL,
  thesis_params TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'WATCHING',
  version       INTEGER NOT NULL DEFAULT 1,
  removed_at    INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (watchlist_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_items_symbol ON watchlist_items(symbol);

-- Append-only. Every transition carries the evidence that caused it and a
-- human-readable reason, so the engine can never show something it cannot explain.
CREATE TABLE IF NOT EXISTS thesis_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        TEXT NOT NULL REFERENCES watchlist_items(id),
  from_state     TEXT NOT NULL,
  to_state       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  conviction     TEXT NOT NULL DEFAULT '{}',
  price_event_id INTEGER REFERENCES price_events(id),
  at             INTEGER NOT NULL,
  notified_at    INTEGER,
  superseded_by  INTEGER REFERENCES thesis_events(id)
);
CREATE INDEX IF NOT EXISTS idx_thesis_events_item ON thesis_events(item_id, id DESC);

-- Sorted index enabling a tick to range-query only the band it crossed, rather
-- than scanning every thesis on the symbol. O(log n + k) instead of O(n) (D-041).
CREATE TABLE IF NOT EXISTS threshold_index (
  item_id   TEXT PRIMARY KEY REFERENCES watchlist_items(id),
  symbol    TEXT NOT NULL,
  threshold REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BELOW', 'ABOVE'))
);
CREATE INDEX IF NOT EXISTS idx_threshold_band ON threshold_index(symbol, threshold);

-- Read position per CARD, not per symbol: the same stock in two lists carries
-- two theses and therefore two independent read positions (D-043).
-- Merging is max(), which is idempotent and order-independent.
CREATE TABLE IF NOT EXISTS read_state (
  item_id       TEXT PRIMARY KEY REFERENCES watchlist_items(id),
  last_seen_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL REFERENCES users(id),
  kind              TEXT NOT NULL CHECK (kind IN ('DIGEST', 'RETRACTION')),
  body              TEXT NOT NULL,
  channel           TEXT NOT NULL,
  status            TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  sent_at           INTEGER,
  failure_reason    TEXT,
  retracts_alert_id INTEGER REFERENCES alerts(id),
  session           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_items (
  alert_id        INTEGER NOT NULL REFERENCES alerts(id),
  thesis_event_id INTEGER NOT NULL REFERENCES thesis_events(id),
  PRIMARY KEY (alert_id, thesis_event_id)
);

CREATE TABLE IF NOT EXISTS push_subs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL,
  keys       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expired_at INTEGER
);

-- Paper orders. They record intent, conviction and timing; they move no money.
CREATE TABLE IF NOT EXISTS orders (
  id                          TEXT PRIMARY KEY,
  user_id                     TEXT NOT NULL REFERENCES users(id),
  symbol                      TEXT NOT NULL REFERENCES instruments(symbol),
  side                        TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity                    REAL,
  amount                      REAL,
  status                      TEXT NOT NULL,
  thesis_snapshot             TEXT NOT NULL DEFAULT '{}',
  conviction_snapshot         TEXT NOT NULL DEFAULT '{}',
  state_at_order              TEXT NOT NULL,
  acknowledged_low_conviction INTEGER NOT NULL DEFAULT 0,
  check_in_question           TEXT,
  check_in_answer             TEXT,
  idempotency_key             TEXT NOT NULL,
  placed_at                   INTEGER NOT NULL,
  effective_at                INTEGER,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS positions (
  user_id   TEXT NOT NULL REFERENCES users(id),
  symbol    TEXT NOT NULL REFERENCES instruments(symbol),
  quantity  REAL NOT NULL,
  avg_price REAL NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

-- Every Ask response is stored with the exact context used to build it, so any
-- answer is reproducible and auditable after the fact.
CREATE TABLE IF NOT EXISTS ask_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          TEXT NOT NULL REFERENCES users(id),
  asked_at         INTEGER NOT NULL,
  question_text    TEXT NOT NULL,
  capability       TEXT NOT NULL,
  resolved_item_id TEXT REFERENCES watchlist_items(id),
  response_text    TEXT NOT NULL,
  context          TEXT NOT NULL DEFAULT '{}'
);

-- Simulated clock. One row. Drives every scenario and makes "six hours passed"
-- demonstrable in thirty seconds.
CREATE TABLE IF NOT EXISTS sim_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  tick          INTEGER NOT NULL DEFAULT 0,
  sim_now       INTEGER NOT NULL,
  scenario      TEXT,
  scenario_tick INTEGER NOT NULL DEFAULT 0,
  -- Bumped by every reset. Alerts carry the session they were raised in, so a
  -- replayed demo does not inherit the previous run's notifications (D-114).
  session       INTEGER NOT NULL DEFAULT 0,
  -- 'sim' or 'live'. One row per database, and the two modes use two database
  -- files, so this is how code deep in the engine knows which feed it is
  -- reading without every function growing a parameter. See domain/mode.ts.
  mode          TEXT NOT NULL DEFAULT 'sim',
  -- Today's trading session, in epoch ms, as reported by the feed itself
  -- (Yahoo's currentTradingPeriod). Fetched rather than hardcoded, so weekends
  -- and the exact 9:15-3:30 window come from the exchange's own calendar. NULL
  -- in simulated mode and whenever the fetch has not succeeded, in which case
  -- the hardcoded weekday rule applies and the badge says it is assuming.
  session_start INTEGER,
  session_end   INTEGER,
  -- When the live feed last completed a pass. The throttle in feed/refresh.ts
  -- reads it so that many viewers cost one fetch cycle rather than one each.
  last_refresh_at INTEGER,
  -- Which IST day the rows in session_opens belong to. A new day cannot write
  -- them until the exchange has actually opened and reported today's first
  -- price, so this records whether that has happened yet and lets a later pass
  -- retry. See feed/refresh.ts.
  session_opens_day INTEGER
);

-- Opening price for the current session, so a card can attribute TODAY's move
-- rather than the move since some arbitrary point. Reset when a session starts.
CREATE TABLE IF NOT EXISTS session_opens (
  symbol     TEXT PRIMARY KEY REFERENCES instruments(symbol),
  open_price REAL NOT NULL
);
`;
