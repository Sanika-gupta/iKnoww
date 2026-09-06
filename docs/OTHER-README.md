# iKnoww
**Old***
*"I know" — with Groww's two w's.*

A watchlist that knows **why** you are watching, and tells you when your trigger fired for the
wrong reason.

Most watchlists tell you a price moved. This one asks whether the move was about your stock at all.
Every item carries a thesis. When it triggers, the move is split against the market: if 93% of it was
the index, the card says *"this is not your dip"* and we send you nothing.

**Live: <https://iknoww.onrender.com>**

> Hosted on a free instance, which sleeps after about fifteen minutes idle. **The first request
> after that takes roughly 30 to 50 seconds to wake.** Every request after it is fast. If you are
> about to demo it, open the link a minute beforehand.

Built for **Code, by Groww (CODE 2026)**. iKnoww is an independent hackathon entry and is not
affiliated with Groww; its colours follow Groww's published design tokens as a deliberate choice,
documented in [`docs/DESIGN.md`](docs/DESIGN.md).

---

## Run it

Requires **Node 20.11 or newer**. Nothing else — no database to install, no `.env` to create, no
migration step.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. On first run the app creates its own SQLite database, seeds twelve
instruments, generates 300 days of price history, estimates the statistics from that history, and
puts nine theses across two named watchlists so there is something to look at.

```bash
npm test        # 417 tests
npm run build   # production build
npm start       # production server
```

The app opens in **Simulated data** mode, which is self-contained and needs no network. The
**Live feed** button switches to real NSE prices, delayed about fifteen minutes; it starts with an
empty watchlist and needs an internet connection.

**There is no `.env` file and the app must never need one.** If you find a setting that has to be
configured before it runs, that is a bug.

---

## See the point in thirty seconds

The app opens on a calm watchlist where nothing is happening. That is the normal state of a
watchlist and it is deliberate, but it means the interesting behaviour needs a market event to
exist at all. So the scenario buttons are on the main screen:

| Button | What to watch for |
|---|---|
| **Market crash** | Everything turns red and **the triggers that fire are sent to review, not to action**. The dip trigger says "this is not your dip". The protective stop says "you would be selling the market, not exiting your thesis". The index fund says it tracked its benchmark. This is the whole idea |
| **Single-stock shock** | One stock moves on its own while the market sits still. This is the one that would earn a notification |
| **Six hours away** | Compressed market time, for what you come back to |
| **Bad tick, then a correction** | A wrong price arrives and moves a card. The correction supersedes it rather than overwriting it |

**Reset session** rewinds to the opening prices, so you can run a scenario again. Replays are
identical, not merely similar.

### Two lists, one stock, two answers

The demo user has two watchlists, **Long term** and **Waiting for dips**, and RELIANCE sits in both
under different theses at different distances from the price. Run the crash: it needs review in one
and correctly does nothing in the other. Same stock, two reasons for watching, two independent read
positions — which is why read state is keyed on the card rather than on the symbol.

The greeting counts across every list, not just the one on screen, because the list you are *not*
looking at is exactly the one that can quietly need you.

---

## How it works

```
Simulator ──▶ Ingestion ──▶ Event log ──┬──▶ Statistics (β, σ per symbol, daily)
 factor        idempotent    append-only │
 model         ordered,                  └──▶ Thesis engine
               corrections                    condition + conviction
                                              └──▶ state machine ──▶ cards
```

**Conviction** is the one number the product turns on. For instrument `i` against its reference:

```
r(i)  =  β(i) · r(reference)  +  ε
z     =  ε / σ(ε)          share_reference = |β·r| / (|β·r| + |ε|)
```

A stock's reference is the market index; a mutual fund's is its stated benchmark. One formula, not
two engines. Both tails route to review: too little instrument-specific movement means the trigger
was reference noise, too much means a shock the thesis never contemplated. Only the middle is
actionable.

That same number decides three things — what the card says, whether we are allowed to interrupt
you, and how much friction sits before the trade.

The full design, including 20 key architectural decisions and what was cut, is in
[`docs/DESIGN.md`](docs/DESIGN.md). The 100-word pitch is in [`PITCH.md`](PITCH.md).

---

## Six reasons to watch, two conditions in code

You never configure an alert. You say **why** you are watching, and that reason *is* the rule.

| Reason to watch | Needs a holding | Leads to |
|---|---|---|
| Buy if it falls below ₹X | no | Buy |
| Buy if it rises above ₹X | no | Buy |
| Add to my position if it falls below ₹X | **yes** | Buy |
| Book profit if it rises above ₹X | **yes** | Sell |
| Exit if it falls below ₹X | **yes** | Sell |
| Just watching — no conditions | no | nothing |

Two things about that table are the point.

**The split is the position, not the direction.** Don't own it and your reason is about entry; own
it and it is about exit or adding. So the picker offers only what can apply — and that gate is
enforced on the server, because a rule that lives only in the UI is a suggestion. In the live feed
you start with nothing, so you will see three until you place a paper buy.

**Six reasons, two conditions.** Mechanically there is only `price ≤ threshold` and
`price ≥ threshold`. A reason is a row of configuration — direction, threshold, needs-position,
action — not a code path. What the six do change is the *sentence*, which is where they earn their
place. On the same low-conviction trigger:

| Your reason | What the card says |
|---|---|
| Buy the dip | "This is not your dip." |
| Buy the breakout | "This is not your breakout. The whole market is up." |
| Add more | "The market fell, not this stock. Adding here is buying the market." |
| Book profit | "Your target hit on a market rally, not on company strength." |
| **Exit** | **"You would be selling the market, not exiting your thesis."** |

Each has a mutual-fund variant, because a fund has a benchmark and a category rather than a market
and a stock. That last line is the one the product exists for: a stop-loss firing on a market-wide
fall is how good positions get shaken out at the bottom. The card says so — and leaves the Sell
button fully working, because a stop is about capital preservation and capital falls in a crash
whatever the attribution says. We inform; we never override.

---

## What a card tells you, and what it deliberately does not

The brief asks what information to surface. The answer here is **decisions, not data**, and the
test applied to every field was *does this change what I would do?*

A card is four layers, and only two of them know your reason for watching exists:

| Layer | On the card | Keyed on |
|---|---|---|
| **Instrument** | price, day change, when the price was measured | the symbol |
| **Conviction** | % attributed to it, surprise σ, band, reference | **the symbol, once per tick** |
| **Your thesis** | the sentence, the state, the button, distance to your trigger | the item |
| **Your position** | holding, unrealised gain | user + symbol |

**Conviction is deliberately not per-thesis**, and that is a scale decision rather than a tidiness
one. It is a property of how the stock moved against its reference, so it does not care who is
watching or why. Your thesis decides whether the *condition* is met; conviction decides *what that
means*. Five million people watching RELIANCE is one regression and one z-score shared across every
crossing, not five million.

Three of those numbers exist because the card was otherwise leaving a question to the reader:

- **Distance to your trigger** — "9.8% from your ₹1,781 trigger". Answers *is this thesis live or
  dormant*, which is the whole question. It goes quiet on a card that has already fired, and it is
  keyed on the **state** rather than on a fresh price comparison: the condition is a Schmitt
  trigger, so inside its hysteresis band a bare comparison and the engine disagree, and a card must
  never say it has fired and has not fired in consecutive lines.
- **When this price was measured** — said always, not only when something is wrong. Freshness is
  type-aware, so a fourteen-hour NAV reads *"normal for a fund"* while a ten-minute quote is stale;
  until this line existed, that rule only ever spoke to complain. While the market is open a stock
  shows how far behind the exchange it is; when it is shut it names the last trade instead, because
  "1604 minutes behind the exchange" on a Saturday is true arithmetic and nonsense English.
- **Unrealised gain on a holding** — because "holding 40" with no cost basis decides nothing on the
  one card where it matters most, the protective stop firing in a crash.

**What was refused, and why it is a choice rather than an omission.** Volume, market cap, day
high/low, P/E, a 52-week bar on the card. Each is *true* and none is *actionable*, and every one of
them dilutes the single sentence that makes this card different from the watchlist you already
have. The 52-week range does appear — in the add form, where it is the anchor for a threshold you
are about to type, and where a number outside it means a thesis that can never fire.

---

## Asking it questions

**Every answer is generated deterministically from live state. No language model is called**, and
every response says so on screen. That is a position, not a shortcut: this product refuses to
fabricate conviction, refuses to fake an order and refuses to let a wrong alert stand, so generating
answers from data it can prove is the same principle applied once more. A hallucination rate of zero
is a stronger claim than "we called a model".

The two modes ask differently, because they have different universes.

**Simulated: type.** A text box answers from the twelve seeded instruments: explain a card, catch up
on what changed, turn a sentence like "watch SBIN, buy below 700" into a thesis for you to confirm,
and one question asked back at you before a weak trade. The numbers are interpolated from the live
conviction payload, so running a different scenario changes them — canned strings would not.

**Live: pick, don't type.** The universe is whatever exists on the NSE, so a parser cannot name what
you mean. Instead you pick a stock, a fund or an index from the same search the add form uses, and
then pick one of **seven questions** — there is no eighth by construction:

| Question | About |
|---|---|
| How much of today's move is the market? | the conviction split, with the beta and how many days it was estimated from |
| Is anything unusual happening to it? | the surprise score against its own history |
| Why is it flagged, and how far is it from my trigger? | only for something on the list you are looking at |
| Where does it trade, and how fresh is that? | price, freshness, and the 52-week range |
| How is the market doing? | an index: its move, and how many of your cards are moving with it |
| What did I miss? | the board, no instrument needed |
| Should I buy it? | refused, on purpose |

Six of the seven read the instrument, so asking about a stock you have not added fetches its two
years of history and estimates its beta — the same call adding it makes — and a judge can therefore
probe **any** NSE stock without putting it on a list. The seventh reads nothing, deliberately: being
*offered* for an instrument and *reading* one are different things, so **the refusal to give advice
still answers with the feed completely down.** The one answer that must never depend on a third
party does not.

These are judgement questions only: volume, market cap, day range and P/E are absent for the reason
the card refuses them. An index can be asked about but never watched: it has no reference of its
own, so the app says what it did today and, for anything other than the three references it already
uses, states plainly that there is nothing here to measure it against.

Either way it will not tell you what to buy. Ask and it says so, and says what it can do instead.

---

## Honest limitations

Volunteered, because each one is defensible when raised first and damaging when discovered.

- **The market data is simulated.** Every screen says so. It was chosen deliberately: a three
  percent crash has to happen on demand, and the statistics need clean history at start-up.
  Crucially, **the engine never reads the simulator's parameters** — it estimates each beta by
  regression from generated history exactly as it would from a real feed. A test walks
  `src/lib/engine` and fails the build on any import of the generator, and another asserts the
  estimates converge on the true values. If it read its own answer key the maths would be circular.
- **A single-factor model cannot separate a sector move from a company move.** If every bank falls
  together, we call it bank-specific. Sector as a second factor is the fix and it is scoped.
- **Orders are paper orders.** They record intent, thesis and conviction. They move no money, and
  every order screen says so.
- **SQLite allows one writer at a time.** That is the trigger for moving to Postgres, and the schema
  is already Postgres-compatible, so it is a connection string rather than a rewrite.
- **The scenario tick loop is stepped from the browser**, not by a timer on the server. That keeps
  the simulation deterministic and avoids a background interval that would die or double-run on
  ephemeral hosting.
- **The deployed instance has no persistent disk**, because the free tier does not offer one. It
  seeds itself on an empty boot, so a cold start gives a clean, correct, fully working app rather
  than a broken one. In simulated mode every byte is generated, so there is no user state worth
  keeping. **In the live feed there is: a watchlist you build there is yours alone and is gone when
  the instance sleeps.** The three reference indices are refetched on the next boot; your cards are
  not. That one is a real limitation rather than a design choice, and paying for a disk is the only
  fix.
- **Exchange holidays are not known to the app.** Live trading hours are read from the feed's own
  trading period, so weekends and the exact 9:15 to 3:30 session are correct without being
  hardcoded, and a Saturday comes out closed because the period still points at Friday. The *next*
  open is computed as the next weekday, so on the eve of a market holiday the badge names a day the
  exchange is shut. The badge says whether it read the hours or assumed them, rather than implying
  it knows either way.
- **Typing a thesis is a simulated-mode feature.** "watch SBIN, buy below 700" parses against twelve
  seeded names. In the live feed the universe is the whole exchange, so there is no text box: you
  pick an instrument and a question instead, and a thesis is added through the form. That is a
  choice rather than a gap — a parser that guessed at a symbol it did not know would be the
  wrong-symbol-on-an-order mistake this product exists to refuse.
- **The live stock feed is an unofficial endpoint.** Yahoo Finance's chart API needs no key and
  carries no guarantee, and it began rate-limiting requests without a browser user-agent partway
  through this build. It can stop answering at any time. That is why simulated mode is the default,
  why nothing in live mode can touch the simulated database, and why a live failure shows one
  sentence and leaves the Simulated button one click away. Mutual fund NAVs come from mfapi.in,
  which serves AMFI's official daily file.

---

## Live feed

A second mode, beside the simulator, running the **unchanged** engine on real NSE prices. Conviction,
the state machine, the alert policy, paper orders and the Ask panel are the same code in both modes;
only where the prices come from differs.

| | |
|---|---|
| Stocks and indices | Yahoo Finance chart API. Unofficial, no key, **about 15 minutes behind the exchange**, measured from the feed's own timestamps rather than assumed |
| Mutual funds | mfapi.in, serving AMFI's official daily NAV file |
| Trading hours | Read from the exchange's own trading period, alongside the quotes. Nothing about 9:15 or 3:30 is hardcoded |
| Data | A separate database file. Nothing done in live mode can touch the simulated one |
| Refreshing | **Once a minute** while the tab is open, with an **Auto refresh** toggle that stops the timer and a Refresh button that always fetches. The server serves stored prices to any automatic pass that follows one less than 55 seconds old, so **ten people watching still costs one fetch a minute, not ten**. The gap between 55 and 60 is deliberate: at exactly a minute a tick landing a fraction early would be skipped and the real cadence would quietly become two minutes |
| Picking something | The search result carries its **last traded price and 52-week range**, because the form is about to ask you for a threshold and a number outside the last year's range is a thesis that cannot fire. The simulated tab shows the last price too, but no range: the simulator generates a return path, not a year of prices, and reconstructing one to fill the field would be inventing a market fact |

**What does not work in live mode, and why.**

| | Simulated | Live | Why |
|---|---|---|---|
| Scenario buttons | yes | **hidden** | Nothing can be made to happen on demand on a real feed |
| Reset | yes | **hidden** | It rewinds to a simulated session open, which is meaningless here |
| Anything moving out of hours | yes | **frozen** | Real markets close. Weekends and evenings show the last quote and no card changes state |
| Time compression | yes | no | Six hours in thirty seconds is a property of a simulator |
| Correction and retraction | yes | machinery present, never exercised | Yahoo does not issue corrections |
| Beta convergence proof | yes | not applicable | There is no ground truth on real data, which is exactly why the simulator exists |
| Watchlists, theses, orders, read state, alerts | yes | **yes** | Same tables, same code |
| Ask | typed, twelve seeded names | **picked**: any NSE stock, fund or index, seven questions | A parser cannot name the whole exchange; a picker can. Same templates, same refusals |

**When the feed fails**, and it is a free unofficial endpoint so it will, the board keeps rendering
the last prices it was given and the panel says what happened in a sentence. Nothing is ever blanked,
and Simulated data is one click away and needs no network.

**That table is the argument for having both.** The live feed shows the engine runs on real prices;
the simulator is the only way to show what it does on a day something actually happens.

Adding an instrument fetches two years of its history, estimates a beta from it by the same
regression the simulator's history goes through, and puts a real card on the board. A fund whose
benchmark we do not know is measured against the Nifty 500 and the card says the benchmark is
assumed, because a single-factor model against the wrong reference produces a plausible wrong number.

## Tooling

AI tools were used to build this, which the competition FAQ explicitly permits. What they did not
decide is in `docs/DESIGN.md`: every architectural choice, the alternative rejected, and why.
