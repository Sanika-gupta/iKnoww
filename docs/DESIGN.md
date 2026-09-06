# iKnoww — design

How this system works, and why it is built the way it is. Every significant choice below
names the alternative it beat and the cost it accepted; where a claim is checkable, the
test that checks it is named.

**What this document is not.** It is not the build plan. Schedules, hour budgets, cut
rules and submission logistics were real and lived in a working document outside this
repository; none of that is design and none of it is here. What survives is the reasoning.

**How to read it.** The first three sections are the argument: the problem, the shape of
the answer, and the technology chosen to build it. Everything after is detail, and can be
read in any order.

---

## Contents

| | |
|---|---|
| **The problem** | why a price alert fires for the wrong reason, and the position taken on it |
| **What the system does** | the loop, end to end |
| **Architecture** | components, the lifecycle of a price, and how two data modes share one engine |
| **Technology choices** | eleven decisions, each with its rejected alternative and its accepted cost |
| **Scope** | two instrument classes, and what is deliberately absent |
| **Domain design** | theses, the state machine, conviction, the card, read state, the Ask panel |
| **Alerting** | why conviction decides whether the product may interrupt you |
| **Orders** | paper orders, and why each one remembers its reason |
| **The simulator** | generation, and the integrity rule that keeps the maths honest |
| **Data model** | the schema, and why it is append-only |
| **Correctness** | every hazard the system is designed against |
| **Scale** | the fixed-cost argument, measured rather than asserted |
| **What was refused** | eighteen things removed, each with its reason |
| **Limitations** | volunteered, not discovered |
| **Appendix: alternatives considered** | the designs that were scored and rejected |
| **Appendix: key decisions** | critical architectural and design choices |

---

## The problem, and the position this takes on it

A price alert is a rule, and rules fire on the letter rather than the spirit. "Buy the dip below
₹3,800" fires identically whether the stock drifted down with the entire market or dropped on a fraud
allegation. A watchlist that says ACTIONABLE in both cases is not merely unhelpful. It is actively
wrong at the moment it matters most, and it fails Groww's *Responsible* commandment.

### The fix: every trigger carries a conviction

Conviction is how much of the move belongs to the instrument itself rather than to its reference.

**Diluted trigger.** Your condition is met but the move is mostly the reference.

```
TCS  ₹3,742  ▼1.6%                          [simulated data]
Your thesis: Buy the dip below ₹3,800
⚠ NEEDS REVIEW — this is not your dip
  82% market · 18% stock · Nifty ▼1.4%
  [ Review ]   [ Buy anyway ]
```

**Unexplained move.** A large instrument-specific move that no thesis anticipated.

```
DIVISLAB  ₹6,120  ▲0.3%                     [simulated data]
⚡ UNEXPLAINED — no thesis covers this
  Flat on screen, but +4.1σ against its own
  normal. Market flat. Something is happening.
  [ Look into it ]  [ Add a thesis ]
```

**Confounded trigger.** The condition is met *and* there is an extreme idiosyncratic move. The thesis
assumed a drift; this is a shock. The card blocks and asks for review.

### Conviction decides three things, not one

This is the spine of the whole product. One number, computed once, governs:

1. **What the card says.** Actionable, needs review, or unexplained.
2. **Whether we are allowed to interrupt you.** **Alerting**. Low conviction never sends a notification.
3. **How much friction sits in front of the action.** **Orders**. Acting past low conviction requires
   an explicit acknowledgement.

Everything else in this plan is machinery in service of that one number being trustworthy.

### Why this beats the alternatives

The brief says "do not build the obvious watchlist". The obvious ones filter on price. The
sophisticated ones summarise with a language model, which every team will do and which cannot be
trusted with money. This one takes a position: **meaning is relative to intent, intent must be checked
against attribution, and attention must be earned before it is spent.**

---

## What the system does

You add a stock or a fund and say **why** you are watching it: buy below ₹3,800, exit below ₹1,500,
or just watching. That sentence is the whole of the configuration — there is no alert screen, because
the reason *is* the rule.

Prices arrive. When one crosses your number, the system does the thing that separates it from a price
alert: it works out how much of that move belongs to the instrument rather than to the market it
moves with. That single number then decides three separate things — what the card says, whether the
product is allowed to interrupt you, and how much friction sits in front of the trade.

The loop closes on an action. An `ACTIONABLE` state that leads nowhere is a dead end, so every card
carries the one action its reason leads to, and **every order is stamped with the thesis and the
conviction showing at the moment it was placed.** A trade remembers why it was made. No broker does
this, it costs one column, and it is the closing line of the demo.

End to end:

```
        ┌──────────────────────────┐
        │  INSTRUMENT PICKER       │
        │  stocks and mutual funds │
        └────────────┬─────────────┘
                     │ pick instrument
                     ▼
        ┌──────────────────────────┐        ┌─────────────────────┐
        │  ADD TO WATCHLIST        │        │  REMOVE FROM        │
        │  pick a thesis:          │        │  WATCHLIST          │
        │  no position:            │        │                     │
        │   • Buy below ₹X         │        │  soft delete,       │
        │   • Buy above ₹X         │        │  orders retained    │
        │  holding it:             │        │                     │
        │   • Add more below ₹X    │        └──────────▲──────────┘
        │   • Book profit above ₹X │                   │
        │   • Exit below ₹X        │                   │
        │  always:                 │                   │
        │   • Just watching        │                   │
        └────────────┬─────────────┘                   │
                     │ state = WATCHING               │
                     ▼                                │
   ╔══════════════════════════════════════════╗       │
   ║           THE WATCHLIST CARD              ║───────┘
   ║ price/NAV · freshness · state · reason    ║
   ║ · unread · position                       ║
   ╚═══════════════════┬══════════════════════╝
                       │ each tick: evaluate condition,
                       │ then compute conviction
                       ▼
        ┌──────────────────────────────────────────┐
        │            CONVICTION GATE                │
        └──┬──────────────┬──────────────┬──────────┘
           │ HIGH         │ LOW          │ EXTREME, or
           │              │              │ |z|≥2.5 with no
           │              │              │ condition met
           ▼              ▼              ▼
    ┌───────────┐  ┌──────────────┐  ┌──────────────┐
    │ACTIONABLE │  │ NEEDS_REVIEW │  │ NEEDS_REVIEW │
    │           │  │  (diluted)   │  │ (confounded) │
    │           │  │ "not your    │  │      or      │
    │           │  │  dip"        │  │ UNEXPLAINED  │
    └─────┬─────┘  └──────┬───────┘  └──────┬───────┘
          │               │                  │
          │        ┌──────▼──────┐           │
          │        │ SILENT.     │           │
          │        │ No alert.   │           │
          │        │ Card only.  │           │
          │        └──────┬──────┘           │
          │               │                  │
          ├───────────────┼──────────────────┤
          │               │                  │
          ▼               │                  ▼
  ┌────────────────┐      │        ┌────────────────┐
  │ ALERT PIPELINE │◀─────┼────────│ ALERT PIPELINE │
  ├────────────────┤      │        └────────────────┘
  │ coalesce 60s   │      │
  │ cooldown 30m   │      │
  │ hysteresis     │      │
  │ quiet hours    │      │
  │ market hours   │      │
  └───────┬────────┘      │
          ▼               │
  ┌────────────────┐      │
  │ ALERT LOG      │      │   persisted BEFORE send
  └───────┬────────┘      │
          ▼               │
  ┌────────────────┐      │
  │ In-app │ Push  │      │   marks notified, NOT read
  └───────┬────────┘      │
          │ tapped        │
          ▼               ▼
   ╔══════════════════════════════╗
   ║   USER OPENS THE CARD        ║  ← marks read (max-merge)
   ╚══════════════┬═══════════════╝
                  │
                  ▼
        ┌──────────────────┐
        │  ORDER TICKET    │  ← from ACTIONABLE directly;
        │  paper order     │    from NEEDS_REVIEW only after
        └────────┬─────────┘    an explicit acknowledgement
                 ▼
      ┌──────────────────────┐
      │  TIMING CHECK        │
      ├──────────────────────┤
      │ stock, market open   │──▶ FILLED
      │ stock, closed        │──▶ QUEUED_NEXT_OPEN
      │ fund, before 3:00pm  │──▶ FILLED at today's NAV
      │ fund, after 3:00pm   │──▶ PENDING_NEXT_NAV
      └──────────┬───────────┘
                 │ stamped with thesis + conviction
                 ▼
      ┌──────────────────────┐
      │  POSITION UPDATED    │
      │  thesis → FULFILLED  │
      │  (stops alerting)    │
      └──────────┬───────────┘
                 ▼
      ┌──────────────────────┐
      │ Card shows position  │
      │ and "why you acted"  │
      │ [ Re-arm thesis ]    │
      └──────────────────────┘
```

### The paths through it

Four flows, each with the rule that only shows up at its edges.

#### Add to watchlist

1. Pick from the instrument grid. Stocks and funds, type shown on every entry.
2. Pick a thesis template, or accept `JUST_WATCHING`. **Only templates valid for your holding are
   offered:** `ADD_MORE`, `BOOK_PROFIT` and `PROTECT` appear only where a position exists, so the list
   is never a menu of things that cannot apply.
3. Item created at `WATCHING`, `version = 1`, read state seeded at the current sequence so the user is
   not immediately shown a backlog they never asked for.
4. A duplicate add is rejected by the unique constraint and offers to edit the existing thesis.
5. Buying an instrument you hold no position in unlocks the three position templates on that card.

#### Remove from watchlist

1. Remove is a **soft delete**. Thesis events, orders and alert history remain.
2. Orders and positions survive removal. You cannot un-place a trade by removing a card.
3. Removal stops all future alerts for that item immediately.
4. Re-adding restores the item and offers its previous thesis.

#### Buy

1. Reachable from `ACTIONABLE` and from `NEEDS_REVIEW`. Never hidden, only gated.
2. **The thesis determines the button.** A `DIP_BUY`, `BREAKOUT_BUY` or `ADD_MORE` card offers Buy. A
   `BOOK_PROFIT` or `PROTECT` card offers Sell. Cards do not show a generic pair of both.
3. From `NEEDS_REVIEW`, a confirm step names the reason: "82% of this move is the market. Buy anyway?"
   Confirming sets `acknowledged_low_conviction`.
3. Ticket takes quantity for a stock, rupee amount for a fund.
4. Timing check assigns the status and the confirmation states which NAV or open applies.
5. Order records thesis and conviction snapshots. Thesis moves to `FULFILLED` and stops alerting.

#### Sell

1. Visible only with a paper position.
2. Quantity or amount capped at the position, validated server-side, not only in the UI.
3. Same timing rules. Fund redemptions after cutoff are `PENDING_NEXT_NAV`.
4. A sell against an `INVALIDATED` thesis is the expected path and the card says so.
5. Selling to zero closes the position and the card returns to a plain watchlist card.

---

## Architecture

```
┌───────────────────────────────────────────────────────┐
│  Simulator      factor-model ticks for stocks,        │
│                 daily NAV for funds, scenario runner   │
└───────────────┬───────────────────────────────────────┘
                │ price / NAV events
┌───────────────▼───────────────────────────────────────┐
│  Ingestion      idempotent on (symbol, seq),           │
│                 type-aware freshness gate, corrections │
└───────────────┬───────────────────────────────────────┘
┌───────────────▼───────────────────────────────────────┐
│  Event log      price_events, thesis_events, orders,   │
│                 alerts                                  │
└───────┬───────────────────────────┬────────────────────┘
        │                           │
┌───────▼─────────┐      ┌──────────▼───────────────────┐
│ Stats job       │      │ Thesis engine                │
│ β, σ_ε per      │─────▶│ conditions + conviction      │
│ symbol, shared  │      │ → state transitions          │
└─────────────────┘      └──────────┬───────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
        ┌───────────────────────┐      ┌────────────────────────┐
        │  Order service        │      │  Alert pipeline        │
        │  timing, positions,   │      │  policy → coalesce →   │
        │  conviction stamping  │      │  cooldown → log → send │
        └───────────┬───────────┘      └───────────┬────────────┘
                    │                              │
        ┌───────────▼──────────────────────────────▼────────────┐
        │  Ask service      ResponseContext ← live state         │
        │                   ScriptedResponder (ships)            │
        │                   ModelResponder    (interface only)   │
        │                   thesis parser (real, deterministic)  │
        └───────────┬────────────────────────────────────────────┘
                    │                              │
                    │                              │
                    │                              ▼
                    │                       ┌────────────┐
                    │                       │  In-app    │
                    │                       │  digest    │
                    │                       └────────────┘
┌───────────────────▼───────────────────────────────────┐
│  Read model    per-user digest, unread, positions,     │
│                alert reconciliation                     │
└───────────────────┬────────────────────────────────────┘
                    │ SSE
┌───────────────────▼────────────────────────────────────┐
│  Next.js UI    cards, contradiction, ticket, diff       │
└─────────────────────────────────────────────────────────┘
```

### What happens when a price arrives

The hot path, in order. Each step is a place a naive implementation gets something wrong,
and the reason for each is given in the sections below.

1. **Idempotency.** `UNIQUE(symbol, seq)` means a duplicate delivery is a no-op rather than
   a second event. Ticks arrive more than once; the database refuses the second.
2. **Ordering.** Anything below the symbol's high-water mark is discarded. An out-of-order
   tick cannot move a state backwards by accident.
3. **Freshness, per instrument type.** A quote older than the stock window blocks state
   changes; the price still renders, because hiding the last known price helps nobody. A
   fourteen-hour NAV is *normal* and is not gated. This distinction is the difference
   between a trustworthy fund card and one that cries wolf all day.
4. **The crossed band.** Thresholds live in a sorted index. The tick range-queries only the
   band between the previous price and the new one, so the cost is the theses that actually
   crossed rather than the theses that exist. This is the whole scale argument and it is
   measured, not asserted.
5. **Conviction, once.** The regression lookup and the surprise score are computed **once for
   the symbol**, not once per thesis, and shared across every crossing. Conviction is a
   property of how the instrument moved against its reference; it does not depend on who is
   watching or why.
6. **Transition.** Each crossed thesis is evaluated against its condition and the conviction
   band, and any state change is appended as an event carrying the triggering price event,
   the conviction payload and a human-readable reason string. Nothing can appear on screen
   that the system cannot explain, because the explanation is written at the same moment as
   the state.
7. **Alert policy, last.** Only then does anything ask whether this earns an interruption.
   The policy is a consumer of the state machine, never a second rule engine.

### Two modes, one engine

A second mode beside the simulator, selected by a button, running the unchanged engine on real NSE prices from two keyless APIs.

| | |
|---|---|
| Stocks and indices | Yahoo Finance chart API. Unofficial, no key, about 15 minutes delayed |
| Mutual funds | mfapi.in, serving AMFI's official daily NAV file |
| Trading hours | Read from the exchange's own trading period. Weekends and holidays fall out of it |
| Isolation | A separate database file per mode. Nothing done in live mode can touch the simulated one |
| Verified | Adding Reliance from a search estimates beta 0.896 from 250 real daily returns |
| Simulated mode | Untouched. All 303 pre-existing tests pass unchanged |

**Three limitations with no fix in code**: a live watchlist does not survive a restart of the free instance; exchange holidays are not known, so the next-open label names the next weekday; and the stock feed is an unofficial endpoint that can stop answering.

---

## Technology choices

The wrong answer is "it's what I know". The right answer names the alternative, the reason, and the cost you accepted.

#### Quick reference

| Decision | Chose | Over | The short reason |
|---|---|---|---|
| Language | TypeScript, front and back | Python backend + React front | One language means the types are shared. Our maths is ten lines, so Python earns nothing |
| Framework | Next.js App Router | Express API + Vite React app | One repo, one process, one deploy. Fewer moving parts for one person |
| Database | SQLite, WAL mode | Postgres in Docker, or MongoDB | Zero setup, nothing to start at demo time. Our data is relational, so a document store would fight us |
| Data access | Raw SQL | Prisma or another ORM | About fifteen queries, all simple. An ORM costs more setup than it saves typing |
| Live updates | Server-Sent Events | WebSockets, or polling | Data flows one way only. Browsers reconnect SSE automatically and replay what was missed |
| State storage | Append-only event log | Updating a `state` column | You cannot undo a mutable column. Corrections and alert retractions need history |
| Notifications | In-app only | Web Push, Firebase, email, SMS | Web Push was cut once the tick loop became browser-driven: with the tab closed nothing advances |
| Market data | Simulated | yfinance, NSE, a broker API | We can cause a crash on demand, and we get clean history instantly |
| The maths | Single-factor regression | Multi-factor, or machine learning | We must explain every number we show. A model that cannot explain itself is unusable here |
| Device sync | Max of a sequence number | Last-write-wins, or a CRDT library | Our value only moves forward, so `max` is already conflict-free. No library needed |
| Styling | Plain CSS modules | Tailwind, MUI, shadcn | Six screens, and the cards are custom. A component library would be fought, not used |

---

#### The seven worth the detail

**TypeScript end to end, rather than a Python service for the maths.**

> The usual reason to reach for Python is NumPy and pandas. But our entire calculation is
> covariance divided by variance over a sixty-item array, which is about ten lines in any language.
> Running a second language and a second runtime to host ten lines is a bad trade. With one language I
> define the shape of a price event, a conviction score and an order once, and both the server and the
> browser use the same definition. As one developer, that removed a whole category of bug.

**Honest limitation:** if the model grew to multi-factor regression or anything machine-learned, Python
would win and we would move that piece into a service.

---

**SQLite, rather than Postgres in a container.**

> It's the right database for this problem, not a compromise. There's nothing to install
> and nothing to start, so the demo can't die because a container didn't come up. It's a real
> relational database with transactions and foreign keys, and in write-ahead-logging mode it handles
> concurrent readers fine. I wrote the schema in SQL that Postgres also accepts, so moving is a
> connection string change, not a rewrite.

**Why not MongoDB.** Our data is deeply relational. Events point at watchlist items, which point at
instruments. Joins are the whole point, and a document store would have us hand-rolling them.

**Honest limitation:** SQLite allows one writer at a time. At real scale you move to Postgres. That is
a planned migration with a known trigger, not a surprise waiting to happen.

---

**Server-Sent Events, rather than WebSockets or polling.**

> Because our data only travels one direction, from server to browser. WebSockets are
> built for two-way conversation, and paying for that means a library, a handshake and writing my own
> reconnection logic. SSE is plain HTTP. The browser reconnects on its own, and it sends back the ID of
> the last message it received, so the server can replay exactly what was missed. I already store a
> sequence number for every user, so recovering from a dropped connection came almost free.

**Why not polling.** At a thirty-second poll you either miss the moment a card flips or you hammer the
server. The entire demo is a card changing state while you watch.

**Honest limitation:** over HTTP/1.1 a browser allows six connections per domain. Irrelevant here, and
HTTP/2 removes the limit.

---

**An append-only event log, rather than a mutable `state` column.**

> Because prices get corrected, and you cannot undo a column you overwrote. If a bad
> tick pushes a card to 'act now' and we later learn the price was wrong, updating a column leaves no
> way back, since the old value is gone. With an append-only log I replay that item from a checkpoint
> and the state genuinely rolls back. It's also the only reason we can retract a notification we
> already sent, which I think is the most trustworthy thing in the product.

**Honest limitation:** more storage and more code than a single column. We keep a materialised state
column alongside as a cache, so reads stay fast and the log is the source of truth.

---

**Simulated market data, as a choice rather than a shortcut.**

> It's simulated, it says so on every screen, and it was a deliberate choice rather than
> a shortcut. Real data gives me whatever the market happened to do that morning, which might be
> nothing at all, and I need a three percent crash on demand to show what this product is for. It also
> gives me ninety days of clean history the moment the app starts, which the statistics need.

**The part that matters:** "I never let the engine read the simulator's own settings.
It estimates each stock's market sensitivity by regression from the generated price history, exactly as
it would from a real feed. If it read the answer key the maths would be circular and meaningless. There
is a test asserting the estimated values converge on the true ones, and that test is the proof the
estimation is real."

---

**A single-factor regression, rather than anything learned.**

> Because this product's whole job is explaining itself. I have to be able to say 'eighty-two
> percent of this move was the market' and show exactly how I got there. A neural net can't do that, and
> a number a user can't interrogate is worse than no number when it's their money. I also have no
> training data and no labels for what a 'meaningful' move even is.

**Why not multi-factor.** Adding a sector factor means a mapping table and a second regression for a
small gain in one displayed percentage. It is a stretch goal, not a core one.

**Honest limitation:** a single market factor cannot separate a
sector-wide move from a company-specific one. If all banks fall together, our model calls it
bank-specific. Sector as a second factor is the fix and it is already scoped.

---

**A max-merged sequence number, rather than timestamps or a CRDT library.**

> The trick is that the value can only ever move forward. I store the sequence number of
> the last update you've seen for each stock, and merging two devices is just taking the larger of the
> two numbers. That means duplicate messages, out-of-order arrivals and two devices writing at once all
> produce the same answer. There's no locking and no last-writer-wins race, because taking a maximum
> doesn't care about order.

**The theory:** it is a grow-only register, the simplest conflict-free replicated data
type there is. We get the property without importing a CRDT library, because the data already has the
right shape.

**Why not timestamps.** Two devices disagree about the time. Clock skew means a stale write can beat a
fresh one. Sequence numbers come from the server, so there is no clock to argue about.

**Honest limitation:** this only works because reading is one-way. If we ever let users mark something
*unread*, the merge would break and we would need something stronger.

---

## Scope

No derivatives, bonds, commodities, ETFs, IPOs or crypto. Two classes is exactly enough to force the
design to be general; a third would be padding.

The two classes are **not** the same problem wearing different labels, and pretending otherwise would
put a real correctness bug in the product.

| | Stock | Mutual fund |
|---|---|---|
| Price signal | Live quote, continuous | NAV, published once daily after close |
| Reference for conviction | Market index, beta-scaled | The fund's stated **benchmark** |
| A large residual means | Something is happening to this company | The manager diverged from the benchmark |
| Normal data age | Seconds. Ten minutes is stale | Hours. Yesterday evening is perfectly fresh |
| Order unit | Quantity of shares | Rupee amount for buy, units or amount for redeem |
| Order timing | Market hours, else queued to next open | NAV cutoff 3:00 pm IST, else next NAV |
| Alert cadence | Can fire intraday | At most once daily, after NAV publication |

### One mechanism, generalised rather than duplicated

Rather than two engines, **every instrument has a reference, and conviction is always the residual
against that reference.** A stock's reference is the market index scaled by its beta; a fund's is its
benchmark, one to one.

Same formula, same state machine, same card, same alert policy. Only reference resolution differs,
which is one function and one column.

It also produces a fund card no app shows today:

```
PARAG PARIKH FLEXI CAP  NAV ₹71.40  ▼2.1%   [simulated data]
Your thesis: Buy below ₹70
✓ WATCHING — the fund did nothing wrong
  Benchmark ▼2.3%. The fund beat it by 0.2%.
  This is a category-wide fall, not a fund problem.
  NAV as of yesterday 9:00 pm IST · normal
```

### Out of scope, stated so it is a choice rather than an omission

Real order execution and real money movement. Real market data. Authentication beyond a user id.
Native mobile apps. SMS and email channels. Derivatives and every other instrument class. SIP creation.
Portfolio analytics beyond the positions paper orders create.

**Orders are paper orders.** They record intent, conviction and timing. They do not move money, and
every order screen says so.

---

## Domain design

The parts of the model a user can feel, and the reasoning behind each. The through-line is that
complexity was allowed only where it changes what someone would do: working out how much of a move
belongs to an instrument, and remembering what a person has already seen.

### Six reasons to watch, two conditions in code

Five templates plus a default. The earlier two-template list had a real hole: we shipped a sell button
with no thesis that led to it. The action surface had two sides and the thesis surface had one.

**Theses split by whether you hold the instrument**, which is what makes the list prescriptive rather
than arbitrary. If you do not own it, your thesis is about entry. If you own it, it is about exit or
adding.

| Template | User declares | Parameter | Needs position | Leads to |
|---|---|---|---|---|
| `DIP_BUY` | "Buy if it falls below ₹X" | `threshold` | No | Buy |
| `BREAKOUT_BUY` | "Buy if it rises above ₹X" | `threshold` | No | Buy |
| `ADD_MORE` | "Add to my position if it falls below ₹X" | `threshold` | **Yes** | Buy |
| `BOOK_PROFIT` | "Book profit if it rises above ₹X" | `threshold` | **Yes** | Sell |
| `PROTECT` | "Exit if it falls below ₹X" | `threshold` | **Yes** | Sell |
| `JUST_WATCHING` | Default. No conditions | none | No | Nothing |

`JUST_WATCHING` is not filler. It is the state in which `UNEXPLAINED` still fires, so the surprise
detector works for users who never declare anything. Value is never gated behind onboarding.

**The engine did not grow.** Mechanically there are only two conditions, `price <= threshold` and
`price >= threshold`. A template is a row of configuration:
`{direction, threshold, requires_position, action}`. Five templates are five rows and five pieces of
copy, not five code paths.

### Why the sell side is where conviction earns the most

Adding exits did not merely fill a gap. It handed the conviction check its strongest case.

| Template | What a low-conviction trigger says |
|---|---|
| `DIP_BUY` | "This is not your dip. 82% market" |
| `BREAKOUT_BUY` | "This is not your breakout. The whole market is up" |
| `ADD_MORE` | "The market fell, not this fund. Adding here is buying the market" |
| `BOOK_PROFIT` | "Your target hit on a market rally, not on company strength" |
| **`PROTECT`** | **"Your exit triggered, but 85% of this is the market. You would be selling the market, not exiting your thesis"** |

That last line is the most valuable sentence in the product. Panic-selling into a market-wide dip is
the single most destructive retail behaviour there is, and a stop-loss firing on a market move is
precisely how good positions get shaken out at the bottom.

**An honesty constraint on that copy.** A protective stop is about capital preservation, and capital falls in a market crash regardless of attribution. So we inform, we never override. The card states what is actually happening, keeps the sell button fully available, and adds no friction beyond the acknowledgement every low-conviction action already carries.

### The state machine

One machine, six states, shared by both instrument classes.

| State | Meaning | Alerts? |
|---|---|---|
| `WATCHING` | Conditions not met. The quiet default | No |
| `ACTIONABLE` | Condition met **and** conviction high. Act | **Yes** |
| `NEEDS_REVIEW` | Condition met but conviction low or confounded | **Only if confounded** |
| `UNEXPLAINED` | Large idiosyncratic move no condition caught | **Yes** |
| `FULFILLED` | The user acted on this thesis. It stops firing | No |

```
WATCHING ──condition met, conviction HIGH────────▶ ACTIONABLE
WATCHING ──condition met, conviction LOW─────────▶ NEEDS_REVIEW   (diluted)
WATCHING ──condition met, conviction EXTREME─────▶ NEEDS_REVIEW   (confounded)
WATCHING ──|z| ≥ 2.5, no condition met───────────▶ UNEXPLAINED

NEEDS_REVIEW ──user acknowledges─────────────────▶ ACTIONABLE
NEEDS_REVIEW ──conviction recovers on new tick───▶ ACTIONABLE
UNEXPLAINED  ──user acknowledges─────────────────▶ WATCHING
ACTIONABLE   ──condition no longer met───────────▶ WATCHING
ACTIONABLE / NEEDS_REVIEW ──order placed─────────▶ FULFILLED
FULFILLED    ──user re-arms the thesis───────────▶ WATCHING
any          ──user edits thesis─────────────────▶ WATCHING  (version bumped)
```

Every transition is an appended event carrying the triggering price event, the conviction payload and
a human-readable reason string, rendered directly so the engine can never show something it cannot
explain.

### The conviction model

For instrument `i` at time `t`, against reference return `r_ref`:

```
r_i,t  =  β_i · r_ref,t  +  ε_i,t
```

| Quantity | Computation |
|---|---|
| Reference | Market index for a stock, stated benchmark for a fund |
| `β_i` | `Cov(r_i, r_ref) / Var(r_ref)` over a rolling 60-observation window. Pinned to 1.0 for funds |
| `ε` residual | `r_i,t − β_i · r_ref,t` |
| `σ_ε` | Standard deviation of residuals over the window |
| **Surprise `z`** | `ε / σ_ε` |
| `share_reference` | `\|β·r_ref\| / (\|β·r_ref\| + \|ε\|)`, rendered as a percentage |

| `\|z\|` | Band | Card | Alert |
|---|---|---|---|
| < 1.0 | LOW | `NEEDS_REVIEW`, diluted | **Silent** |
| 1.0 to 2.5 | HIGH | `ACTIONABLE` | Alert |
| ≥ 2.5 | EXTREME | `NEEDS_REVIEW`, confounded | Alert |
| n/a | `UNKNOWN` | Card says so | **Silent** |

**Both tails route to review.** Too little instrument-specific movement means the trigger is reference
noise. Too much means something the thesis never contemplated. Only the middle is clean.

### What a card surfaces, and what it refuses

The brief asks what information to surface. The answer here is **decisions, not data**, and
the test applied to every field was *does this change what I would do?*

A card is four layers, and only two of them know your reason for watching exists:

| Layer | On the card | Keyed on |
|---|---|---|
| **Instrument** | price, day change, when the price was measured | the symbol |
| **Conviction** | % attributed to it, surprise σ, band, reference | **the symbol, once per tick** |
| **Your thesis** | the sentence, the state, the button, distance to your trigger | the item |
| **Your position** | holding, unrealised gain | user + symbol |

**What was refused, and why it is a choice rather than an omission.** Volume, market cap, day
high and low, P/E, a 52-week bar on the card. Each is *true* and none is *actionable*, and
every one of them dilutes the single sentence that makes this card different from the
watchlist you already have.

### Read state, and why a timestamp is not enough

Read state is `item_id → last_seen_seq`, one position per watchlist card, **not** one last-visit
timestamp per user. Keying on the item rather than the symbol matters because the same stock can sit in
two lists carrying two different theses, and therefore two independent read positions.

**The silent swallow.** You glance at the top two cards of twelve and close the app. A timestamp cursor
marks all twelve seen. The ten you never looked at vanish forever, and the app tells you nothing
changed. The defect is in the read model, so no event log fixes it.

Rules:

- Marking read is `last_seen_seq = max(last_seen_seq, incoming_seq)`. Max-merge is idempotent and
  order-independent, so two devices, retries and duplicate deliveries are handled by the **data type**.
- A card is marked seen only when **opened or expanded**, never by list rendering.
- Unread state lives on existing cards. No second screen.

### The market card

A single card pinned above the watchlist showing the market's own move, and each fund's benchmark
alongside it.

It exists to answer the sharpest challenge this design invites: *"a market-wide crash IS meaningful,
and your product hides it."* We do not hide it. **The market's move is the most prominent thing on the
screen.** What we refuse to do is repeat that one fact twelve times, once per stock, as if it were
twelve separate discoveries.

```
NIFTY 50   24,180  ▼1.4%          [simulated data]
Broad decline. 11 of your 12 items
are moving with the market.
```

### The Ask panel

A typed question box on the watchlist. You ask about your own watchlist and it answers from the
structured state we already hold.

#### Three guardrails

1. **It never gives investment advice.** It will not answer "should I buy?". That is SEBI-regulated
   territory.
2. **It never becomes a second definition of "meaningful".** It reads conviction, theses, events and
   the read cursor. It never ranks, scores or decides what matters.
3. **It never states a number it did not receive.** Every figure in every answer is interpolated from
   the live conviction payload, not composed.

---

## Alerting

Conviction gates interruption. A low-conviction trigger updates the card and stays silent. If we are not sure the move is about your instrument, we are not entitled to your attention.

**Every alert is a digest** with a global per-user 30-minute cooldown, 60-second coalescing and hysteresis. Collapses dedup and batching into one mechanism and caps notification volume by design.

**Alerts are retracted when the underlying price is corrected**, and delivery marks `notified` rather than `read`.

---

## Orders

Orders are paper orders. They record intent, conviction and timing. They do not move money.

Every order is stamped with:
- The thesis that led to it
- The conviction at placement
- The timing status (filled, pending, queued)

A trade remembers why it was made. No broker does this, it costs one column, and it is the closing line of the demo.

---

## The simulator

Factor-model ticks for stocks, daily NAV for funds, scenario runner.

**The integrity rule:** the engine never reads the simulator's parameters. It estimates each stock's market sensitivity by regression from the generated price history, exactly as it would from a real feed. If it read the answer key the maths would be circular and meaningless.

There is a test asserting the estimated values converge on the true ones. That test is the proof the estimation is real.

---

## Data model

Event-sourced. Every state change is an appended event. The event log is the source of truth.

Why append-only:
- Prices get corrected. You cannot undo a mutable column.
- Alert retraction needs history.
- Replay from checkpoint gives genuine rollback.

Materialised state column alongside as a cache. Reads stay fast, log is truth.

---

## Correctness

Every hazard the system is designed against:

- **Duplicate delivery** — `UNIQUE(symbol, seq)` makes it a no-op
- **Out-of-order ticks** — high-water mark discards stale data
- **Type-confused freshness** — 14-hour NAV is normal; 10-minute quote is stale
- **Jittering thresholds** — Schmitt trigger with hysteresis
- **Circular estimation** — test fails if engine imports simulator parameters
- **Silent swallow** — read state keyed on item, marked only on open
- **Device disagreement** — max-merge is conflict-free by construction

---

## Scale

The fixed-cost argument, measured rather than asserted.

**Statistics are computed for the entire instrument universe unconditionally**, not on demand per user. About 3,500 regressions daily regardless of who watches what, making the analytical layer a fixed cost independent of user count and watchlist size.

**Threshold crossing index.** Thesis thresholds held in a sorted index per symbol; a tick range-queries the band between old and new price, so cost is O(log N + K) rather than O(theses on symbol).

**Measured in `scale.test.ts`:** 5,000 theses on one symbol across ₹3,040 to ₹4,560:
- 0.1% move evaluates **13**
- 1% move evaluates **126**  
- 3% crash evaluates **376**
- Move crossing nothing evaluates **nothing**

`EXPLAIN QUERY PLAN` reports `SEARCH threshold_index USING INDEX idx_threshold_band`. Test fails if that word ever becomes `SCAN`.

---

## What was refused

Eighteen things removed, each with its reason:

1. **Multi-factor models** — single factor is explainable; multi-factor gains little
2. **Machine learning** — cannot explain its numbers; unusable for money decisions
3. **Volume, market cap, P/E on card** — true but not actionable; dilutes the core message
4. **52-week bar on card** — appears in add form where it anchors threshold input
5. **Multiple alert channels** — in-app only; others cut when tick loop became browser-driven
6. **Web Push** — tab closed = no ticks = nothing to push
7. **Generic Buy/Sell pair** — thesis determines the one button that makes sense
8. **Alert configuration UI** — your thesis is the alert rule
9. **Search in simulated mode** — fixed picker demonstrates identical flows at no risk
10. **Hard cap on watchlist size** — replaced by soft nudge and rate limits
11. **Authentication** — stated omission; adds ceremony without adding security in demo
12. **Real order execution** — paper orders record intent; moving money is out of scope
13. **Native mobile apps** — web-first; app shares backend
14. **SMS and email alerts** — in-app digest sufficient
15. **Derivatives, bonds, commodities, ETFs** — two classes force generality; third is padding
16. **SIP creation** — out of scope
17. **Portfolio analytics beyond positions** — positions created by paper orders only
18. **Language model** — deterministic templates; model adapter documented but unbuilt

---

## Limitations

Volunteered, not discovered:

1. **SQLite allows one writer at a time.** At real scale, move to Postgres.
2. **Single-factor model cannot separate sector moves from company moves.** Sector as second factor is the fix.
3. **Read state only works one-way.** If users could mark unread, merge would break.
4. **Live watchlists don't survive instance restart.** Seed-on-empty-boot makes ephemeral filesystem correct.
5. **Exchange holidays not known.** Next-open label names next weekday.
6. **Stock feed is unofficial endpoint.** Can stop answering; simulated mode is default.
7. **Thesis parser requires instrument already added (live mode).** Cannot resolve symbols the app hasn't seen.

---

## Appendix: alternatives considered

Three designs were scored before building:

**Option A: Generic watchlist with LLM summarization**
- Score: 6.5
- Rejected: Cannot be trusted with money. Hallucinated numbers are the problem we argue against.

**Option B: Price alerts with market filter**
- Score: 7.2
- Rejected: Filters are binary. No conviction gradient, no "needs review" state.

**Option A': Thesis Watch with conviction check** ← **Selected**
- Score: 9.3
- One definition of "meaningful", one primary screen, conviction decides three things not one.

---

## Appendix: key decisions

Critical architectural and design choices, following the pattern: problem → options → decision [rationale].

### 1. Beta estimation approach

**Problem:** How to compute market sensitivity for conviction scoring.

**Options:**
- Read beta from simulator parameters (instant, no computation)
- Estimate from generated price history via regression
- Use published beta values from financial APIs

**Decision:** Estimate from generated price history via regression.

**Why:** Reading simulator parameters would make the math circular and meaningless. The engine must work exactly as it would on real data. A test asserts estimated values converge on true ones, proving the estimation is real. Published betas would create external dependency and not work in simulated mode.

---

### 2. Statistics computation scope

**Problem:** When to compute regression statistics for instruments.

**Options:**
- On-demand per user when they add a watchlist item
- Pre-compute for watched instruments only
- Pre-compute for entire instrument universe

**Decision:** Pre-compute for entire instrument universe unconditionally.

**Why:** Makes analytics a fixed daily cost (~3,500 regressions) independent of user count or watchlist size. Scales from ten users to ten million with same computation. Alternative would make hot stocks a bottleneck.

---

### 3. Threshold crossing detection

**Problem:** How to find which theses crossed on a price update.

**Options:**
- Scan all theses for the symbol on every tick
- Maintain sorted index, range-query the crossed band
- Periodic batch processing of all theses

**Decision:** Sorted index with range query between old and new price.

**Why:** Cost becomes O(log N + K) where K is theses actually crossed, not O(N) of all theses. Measured: 5,000 theses, 0.1% move evaluates 13. Scale property is testable: EXPLAIN QUERY PLAN must show INDEX SEARCH not SCAN.

---

### 4. Event storage pattern

**Problem:** How to store state changes and price updates.

**Options:**
- Update mutable state column directly
- Append-only event log with materialized cache
- Hybrid: events for prices, mutable for state

**Decision:** Append-only event log with materialized state cache.

**Why:** Prices get corrected. Cannot undo overwritten column. Correction needs to replay from checkpoint, requiring history. Enables alert retraction - the most trustworthy feature in the product. Cost: more storage, more code. Gain: genuine rollback and retractable notifications.

---

### 5. Conviction's role

**Problem:** What should conviction determine.

**Options:**
- Only what the card displays
- Card display + whether to alert
- Card + alerts + action friction (three things)

**Decision:** Conviction decides three things: card state, alerting, and action friction.

**Why:** One number, computed once per symbol (not per thesis), governs the entire user experience. Low conviction = needs review state + silent + acknowledgment required. High = actionable + alert + direct action. Confounded/unexplained = review + alert. Prevents product from interrupting on weak signals.

---

### 6. Instrument generalization

**Problem:** Stocks and funds have different characteristics. Build separate engines?

**Options:**
- Duplicate engine for each type
- Single engine with type-specific branches
- Single engine with "reference" abstraction

**Decision:** Every instrument has a reference; conviction is residual against reference.

**Why:** Stock reference = market index (beta-scaled). Fund reference = stated benchmark (1:1). Same formula, same state machine, same card, same alert policy. Only reference resolution differs (one function, one column). Passes stopping rule: changes input to definition, not the definition itself.

---

### 7. Freshness handling

**Problem:** Stock quotes refresh continuously, fund NAVs once daily. Single staleness rule?

**Options:**
- Same staleness threshold for both
- Type-aware: different rules per instrument
- No staleness gate, always use latest

**Decision:** Type-aware freshness. 10-minute stock quote is stale; 14-hour fund NAV is normal.

**Why:** A fund card saying stale all day is crying wolf. Normal fund data age is hours (published after close). Stock data age should be seconds. One gate with type-dependent threshold prevents false urgency. Never cry wolf on a fund.

---

### 8. Read state granularity

**Problem:** Track what user has seen.

**Options:**
- Single timestamp per user (last visit)
- Sequence number per symbol
- Sequence number per item (watchlist entry)

**Decision:** Sequence number per item with max-merge.

**Why:** Same symbol can appear in two lists with two theses = two independent read positions. Timestamp has "silent swallow" bug: glance at top 2 of 12 cards, all 12 marked seen, 10 never-seen changes vanish. Max-merge is idempotent and conflict-free by construction: two devices, retries, out-of-order delivery all produce same answer. No locking, no last-write-wins race.

---

### 9. Thesis templates

**Problem:** How many reasons to watch should the system support.

**Options:**
- Generic "price crosses threshold"
- Two templates (buy dip, protect)
- Six templates split by position holding

**Decision:** Five templates + default, split by position: DIP_BUY, BREAKOUT_BUY, ADD_MORE, BOOK_PROFIT, PROTECT, JUST_WATCHING.

**Why:** Original two-template list shipped sell button with no thesis leading to it - action surface had two sides, thesis surface had one. Position split makes list prescriptive not arbitrary. Templates requiring position only offered when position exists. Engine stays simple: mechanically only two conditions (price <= / >=), templates are configuration rows not code paths.

---

### 10. Alert retraction

**Problem:** Price correction invalidates earlier alert.

**Options:**
- Leave incorrect alert standing
- Silently suppress duplicate
- Explicitly retract with notification

**Decision:** Retract alert when underlying price corrected.

**Why:** Append-only log enables replay from checkpoint. Can identify alerts triggered by corrected price. Send explicit retraction: "9:40 AM alert about TCS was based on price since corrected." Never quietly drop - that spends attention without acknowledgment. Retraction is separate from digest count so product doesn't congratulate itself for mistake.

---

### 11. State machine design

**Problem:** How many states does a thesis need.

**Options:**
- Three states: watching, actionable, fulfilled
- Six states including weakening, expired, invalidated
- Five states (cut invalidated, merged into needs_review)

**Decision:** Five states: WATCHING, ACTIONABLE, NEEDS_REVIEW, UNEXPLAINED, FULFILLED.

**Why:** INVALIDATED cut and merged into NEEDS_REVIEW confounded - same meaning, same alert behavior, fewer states. WEAKENING cut - added transition without adding decision. FULFILLED exists because without it, acting on thesis leaves it firing forever. Both conviction tails route to review: too little movement = reference noise, too much = thesis never contemplated it.

---

### 12. Simulation tick control

**Problem:** How to advance simulation time.

**Options:**
- Server-side timer interval
- Browser-driven step on user action
- Hybrid: server runs, browser polls

**Decision:** Browser steps the tick loop.

**Why:** Judge should watch cards changing, not find them already changed. Stays deterministic. No background interval to die or double-run on ephemeral hosting. Consequence: tab closed = nothing advances = nothing to push, which is why Web Push was cut. Cost: scenarios aren't autonomous. Gain: reproducible demos, no hosting timer issues.

---

### 13. Hysteresis placement

**Problem:** Price resting on threshold jitters across it every tick.

**Options:**
- Debounce only the alert notification
- Add hysteresis to the condition itself
- Accept jitter, fire/unfire repeatedly

**Decision:** Hysteresis in condition (Schmitt trigger). Armed at threshold, disarmed quarter-percent past it.

**Why:** Debouncing only notification leaves card flickering between states and fills event log with noise transitions. Condition-level hysteresis means eight jittering ticks produce one state change. Card and alert policy agree by construction. Distance display keys on state not fresh comparison, so card can't say "fired" and "not fired" in consecutive lines.

---

### 14. Multiple watchlists

**Problem:** Users want to group instruments differently.

**Options:**
- Single list only, schema deferred
- Schema now (watchlists table), UI later
- Full multi-list feature immediately

**Decision:** Schema and UI shipped together (originally planned as schema-only).

**Why:** Watchlists table and UNIQUE(watchlist_id, symbol) built day one. Read state already keyed on item (not symbol) so one symbol could sit in two lists under two theses. Design had promised "split this list" feature, impossible with only one list. Shipping UI turned schema decision into delivered feature. Same symbol in two lists = two theses, two read positions, two buttons.

---

### 15. Ask panel implementation

**Problem:** How to answer user questions about watchlist.

**Options:**
- Language model call per question
- Scripted templates filled from context
- Hybrid: model phrasing, API data

**Decision:** Deterministic templates filled from ResponseContext. Model adapter documented but unbuilt.

**Why:** Language model hallucinating number about money is what product argues against. Zero hallucination rate is stronger claim than "usually accurate." Every response is template filled from live conviction payload, thesis state, event log. No number can appear that wasn't received from API or computed. Guardrails: never gives investment advice (SEBI), never becomes second definition of "meaningful", never states number it didn't receive. Model may phrase later, but constraint documented.

---

### 16. Live feed architecture

**Problem:** Enable real market data alongside simulator.

**Options:**
- Replace simulator entirely
- Runtime switch, shared database
- Runtime switch, separate databases per mode

**Decision:** Separate database file per mode, selected by search param.

**Why:** Engine unchanged - conviction, state machine, alerts, orders run on real prices. Two databases means live cannot corrupt simulated, and simulated tests pass untouched (303 tests identical). Mode switch is search param not body field because six handlers read no body - rule with six exceptions would risk wrong-database reads. Simulated stays default. Live limitations stated: watchlists don't survive restart, no holiday calendar, unofficial feed can fail.

---

### 17. The pitch structure

**Problem:** 100-word product pitch in submission form.

**Options:**
- Chronological narrative of build
- Feature list with technical terms
- Three sections answering brief's three asks
- Single paragraph in plain English

**Decision:** Single paragraph, plain English, brief's three asks in order.

**Why:** Brief asks for "what you built, how you designed it, thinking behind key choices." Opening with specific complaint (not category contrast), naming measurable claim (93% market share shown), countable outcome (zero alerts). Technical words translated: "regression from history" → "stock's link to market comes from price history"; "append-only events" → "wrong price undone, alert taken back". Name in pitch. No scenario instructions. Engineering depth in five interrogable decisions. Model admitted as phrasing layer under stated constraint.

---

### 18. Timing and clock handling

**Problem:** Demo runs in simulated time, judges open it in real time.

**Options:**
- All rules use wall clock
- All rules use simulated clock
- Hybrid: display real, logic simulated

**Decision:** Every time-dependent rule reads simulated clock.

**Why:** Order service was using real time - judge opening app in evening told market closed while simulated session at mid-morning. Alert policy same issue: compressed 6-hour scenario finishes in one real minute = inside one cooldown = policy never exercised. Session clock above index shows simulated time, Open/Closed badge uses exact predicate alert policy uses (tested minute-by-minute across whole day). IST by arithmetic (+5:30 offset) not Intl, since India has no DST. Badge and silence can never disagree.

---

### 19. Card information hierarchy

**Problem:** What data belongs on a watchlist card.

**Options:**
- Everything available (volume, P/E, 52-week, market cap)
- Minimal (price and state only)
- Decisions not data (changes what user would do)

**Decision:** Four layers: instrument, conviction, thesis, position. Three key numbers: distance to trigger, when measured, unrealized gain.

**Why:** Test: does this change what I would do? Volume/market cap/P/E are true but not actionable - dilute the core message. Distance to trigger answers "is this live or dormant", keyed on state not fresh comparison (Schmitt trigger). When measured shown always not only when stale - reassures 14-hour NAV is normal. Unrealized gain because "holding 40" with no cost basis is inert on protective stop in crash. Refused 52-week bar on card (appears in add form where it anchors threshold).

---

### 20. Conviction computation scope

**Problem:** When to compute conviction for a price update.

**Options:**
- Once per thesis that crossed
- Once per symbol, shared across all crossings
- Batch process periodically

**Decision:** Conviction computed once per symbol, shared across every crossing.

**Why:** Conviction is property of how instrument moved against reference. Does not depend on who is watching or why. Regression lookup and surprise score computed once, reused for all theses on that symbol. Separates symbol-level analytics from thesis-level decisions. Scales with instruments not with user thesis count.

---

