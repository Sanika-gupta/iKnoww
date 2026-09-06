'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { BoardView, CardView, InstrumentView } from '@/lib/api/board';
import type { FeedMode } from '@/lib/domain/mode';
import { ENTRY_CHOICES } from '@/lib/domain/types';
import { questionsFor, type QuestionId } from '@/lib/ask/questions';

/**
 * The whole screen.
 *
 * The payload types come straight from the server module that builds them, so
 * there is exactly one definition of what a card is. That is the concrete
 * benefit of one language end to end, and it is worth more here than any
 * framework would have been.
 */

/** One row from the live instrument search. Mirrors `SearchHit` on the server. */
interface SearchResult {
  vendorId: string;
  symbol: string;
  name: string;
  /** INDEX only ever comes from the Ask panel's picker (D-134). */
  type: 'STOCK' | 'FUND' | 'INDEX';
}

type SearchKind = SearchResult['type'];

/**
 * The theses that apply to something you do not yet hold.
 *
 * The server filters templates by position, and it still does: these are only
 * the entry-side ones, which are exactly the templates valid for an instrument
 * that has just been searched for and therefore cannot be held. The three
 * position templates appear on the card once a paper order fills, through the
 * same server-side gate as always (D-075).
 */


interface AskAnswer {
  capability: string;
  answer: string;
  disclosure: string;
  itemIds: string[];
  proposal?: { symbol: string; thesisType: string; threshold?: number; restated: string };
}

const TICK_MS = 260;

/**
 * The greeting counts across EVERY list, not just the one on screen.
 *
 * That is the whole reason multiple lists need a summary at all: the list you
 * are not looking at is exactly the one that can quietly need you. The tab bar
 * says which; this says whether.
 */
function greetingLine(board: BoardView): string {
  const total = board.watchlists.reduce((n, w) => n + w.attentionCount, 0);
  if (total === 0) return 'Nothing needs you right now.';
  const here = board.attentionCount;
  const elsewhere = total - here;
  if (elsewhere <= 0) return `${here} ${here === 1 ? 'card needs' : 'cards need'} a look.`;
  if (here === 0) {
    return `${elsewhere} in another list ${elsewhere === 1 ? 'needs' : 'need'} a look.`;
  }
  return `${here} here, ${elsewhere} in another list.`;
}

function explainListError(code: string): string {
  switch (code) {
    case 'EMPTY_NAME':
      return 'A list needs a name.';
    case 'NAME_TOO_LONG':
      return 'That name is too long for a tab. Keep it under 40 characters.';
    case 'DUPLICATE_NAME':
      return 'You already have a list with that name.';
    case 'LAST_WATCHLIST':
      return 'This is your only list, so there is nowhere for your theses to go.';
    case 'TOO_MANY_WATCHLISTS':
      return 'That is as many lists as we keep. Remove one first.';
    default:
      return 'That did not work.';
  }
}

function pct(x: number | null, dp = 2): string {
  if (x === null) return '—';
  const v = x * 100;
  const rounded = Number(v.toFixed(dp));
  if (rounded === 0) return `0.${'0'.repeat(dp)}%`;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(dp)}%`;
}

function money(x: number): string {
  return `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dirClass(x: number | null): string {
  if (x === null || Math.abs(x) < 0.00005) return 'flat';
  return x > 0 ? 'up' : 'down';
}

export default function Board({
  initial,
  initialInstruments,
  mode,
}: {
  initial: BoardView;
  initialInstruments: InstrumentView[];
  mode: FeedMode;
}) {
  const live = mode === 'live';
  const [board, setBoard] = useState<BoardView>(initial);
  // Both payloads are rendered on the server, so the first paint is the real
  // watchlist rather than a spinner, and there is no fetch-on-mount at all.
  const [instruments, setInstruments] = useState<InstrumentView[]>(initialInstruments);
  const [busy, setBusy] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [symbol, setSymbol] = useState('');
  const [thesisType, setThesisType] = useState('');
  const [threshold, setThreshold] = useState('');

  /**
   * What the live feed last told us. Null in simulated mode, and null in live
   * mode until the first refresh answers, which is why the tooltip falls back
   * to "about 15 minutes" rather than printing a number it has not measured.
   */
  const [feedDelayMinutes, setFeedDelayMinutes] = useState<number | null>(null);
  const [feedNote, setFeedNote] = useState<string | null>(null);

  /**
   * Whether the live feed refreshes itself.
   *
   * On by default, because a live board that does not update is not live. It
   * can be turned off, and the manual button stays available either way, which
   * is the escape hatch if the feed ever does start rate-limiting us: stop the
   * timer, press refresh when you want a price.
   *
   * Component state, deliberately not remembered between visits. There is no
   * browser storage anywhere in this app, which is what makes it work
   * identically in an incognito window, and one toggle is not worth giving
   * that up for.
   */
  const [autoRefresh, setAutoRefresh] = useState(true);
  /*
   * The price the threshold is being typed against, and the range it has to be
   * plausible within. In simulated mode both come from the instrument list; in
   * live mode the instrument does not exist yet, so it is one call per pick.
   */
  const [liveAnchor, setLiveAnchor] = useState<{
    for: string;
    price: number | null;
    high52: number | null;
    low52: number | null;
  } | null>(null);

  /**
   * Live mode's instrument search.
   *
   * The type is picked BEFORE the query, and that is a requirement rather than
   * a nicety: stocks and funds come from two different APIs, and the type
   * decides the reference, the staleness limit, which thesis templates apply
   * and the order unit. A merged search would have to guess it from the result
   * shape, and a fund landing as a stock reads as stale all day (D-025).
   */

  const [editing, setEditing] = useState<'new' | 'rename' | null>(null);
  const [listName, setListName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * Which list is on screen, mirrored into a ref.
   *
   * Every fetch below needs it, and reading it from a ref rather than closing
   * over it keeps `refresh` and `loadInstruments` stable. Without that, changing
   * lists would tear down and rebuild the SSE subscription, which is the same
   * reasoning as `busyRef` further down.
   */
  const activeIdRef = useRef(initial.watchlistId);

  /**
   * The mode, in a ref for exactly the reason the list id is in one: every
   * fetch needs it, and closing over it would make `refresh` change identity,
   * which would tear down and rebuild the SSE subscription.
   *
   * Every request carries it as a search param. Five of the handlers read no
   * body at all, and a rule with five exceptions is how a request ends up
   * silently reading the wrong database.
   */
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const api = useCallback((path: string) => {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}mode=${modeRef.current}`;
  }, []);

  const {
    type: searchType,
    setType: setSearchType,
    query,
    setQuery,
    results,
    setResults,
    searching,
    picked,
    setPicked,
  } = useInstrumentSearch(live, api, (msg) => setError(msg));

  const loadInstruments = useCallback(async (listId?: string) => {
    const id = listId ?? activeIdRef.current;
    const res = await fetch(api(`/api/instruments?watchlist=${encodeURIComponent(id)}`));
    const data = (await res.json()) as { instruments: InstrumentView[] };
    setInstruments(data.instruments);
  }, [api]);

  const refresh = useCallback(async (listId?: string) => {
    const id = listId ?? activeIdRef.current;
    const res = await fetch(api(`/api/board?watchlist=${encodeURIComponent(id)}`));
    const next = (await res.json()) as BoardView;
    // The server resolves a stale id back to a real list, so trust its answer
    // rather than what we asked for.
    activeIdRef.current = next.watchlistId;
    setBoard(next);
  }, [api]);

  /**
   * Live updates over Server-Sent Events.
   *
   * The stream carries a version key rather than the board, so each client
   * fetches the one view it needs instead of the server building a board per
   * connection. This is what keeps a second device consistent: run a scenario in
   * one tab and the other follows without polling.
   */
  // Mirrored into a ref so the stream subscription can read the latest value
  // without resubscribing every time it changes.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy, api]);

  useEffect(() => {
    const source = new EventSource(api('/api/stream'));
    source.addEventListener('changed', () => {
      // While this tab is driving a scenario it already has the freshest board
      // from each tick response; refetching would only fight with it.
      if (!busyRef.current) void refresh();
    });
    return () => source.close();
  }, [refresh, api]);

  /**
   * One pass of the live feed. The counterpart to a simulated tick, and driven
   * from here for the same reason (D-085): no server timer to die or double-run.
   *
   * A failure is reported in the panel and nowhere else. The board keeps the
   * last prices it had, the simulated mode is one click away, and nothing about
   * the failure is allowed to blank a card.
   */
  const refreshFeed = useCallback(
    async (force = false) => {
      setBusy(true);
      setError(null);
      try {
        const id = activeIdRef.current;
        const res = await fetch(
          api(`/api/feed/refresh?watchlist=${encodeURIComponent(id)}${force ? '&force=1' : ''}`),
          { method: 'POST' },
        );
        if (!res.ok) {
          setFeedNote(explainFeedError('UNREACHABLE'));
          return;
        }
        const body = (await res.json()) as BoardView & {
          feed?: {
            skipped: boolean;
            maxDelayMs: number;
            failed: Array<{ symbol: string; reason: string }>;
            updated: unknown[];
          };
          feedError?: { kind: string };
        };
        // The board comes back even when the fetch failed, built from the last
        // stored prices. A card is never blanked by a feed problem.
        activeIdRef.current = body.watchlistId;
        setBoard(body);

        if (body.feedError) {
          setFeedNote(explainFeedError(body.feedError.kind));
          return;
        }
        if (body.feed && !body.feed.skipped) {
          // The delay is measured from the feed's own timestamps rather than
          // assumed, so the number on screen is the lag actually observed.
          setFeedDelayMinutes(Math.round(body.feed.maxDelayMs / 60000));
          const failed = body.feed.failed;
          setFeedNote(
            failed.length === 0
              ? null
              : `Could not reach ${failed.length} of ${
                  failed.length + body.feed.updated.length
                } instruments (${failed.map((f) => f.symbol).join(', ')}). ` +
                'Those cards keep their last price; everything else is current.',
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  /**
   * The live feed refreshes itself while the tab is open, once a minute.
   *
   * Once a minute rather than every few seconds because the quotes are fifteen
   * minutes old: polling faster would spend somebody else's rate limit to learn
   * nothing. Nothing runs when the tab is closed, and nothing runs at all in
   * simulated mode.
   */
  useEffect(() => {
    if (!live) return;
    // The first pass is scheduled rather than called inline: a fetch started
    // synchronously inside an effect sets state during the same render pass and
    // cascades. A timeout of zero puts it on the next tick, which is early
    // enough that a judge does not see an empty board.
    //
    // It does not force. The server throttles automatic passes so that however
    // many tabs are open, they cost one fetch cycle between them.
    const first = setTimeout(() => void refreshFeed(), 0);
    return () => clearTimeout(first);
  }, [live, refreshFeed, api]);

  /**
   * The repeating pass, and the toggle that stops it.
   *
   * Separate from the arrival pass above on purpose: entering live mode should
   * always populate the board, while the TIMER is the thing "auto refresh"
   * names and the thing worth being able to stop. Keeping them in one effect is
   * how the toggle ended up controlling nothing but its own label -- it was not
   * in the guard and not in the dependencies, so the interval never saw it.
   */
  useEffect(() => {
    if (!live || !autoRefresh) return;
    const repeat = setInterval(() => void refreshFeed(), 60_000);
    return () => clearInterval(repeat);
  }, [live, autoRefresh, refreshFeed]);

  /**
   * The anchor for a searched instrument.
   *
   * One call, and only once someone has picked something -- not on every
   * keystroke of the search, which would put a request behind each letter typed
   * against an endpoint that rate-limits.
   *
   * It never blocks and it never fails loudly: if the feed will not answer, the
   * line simply is not there, because a price shown to help you choose a number
   * must not be able to stop you choosing one (D-126).
   */
  useEffect(() => {
    // No clearing here: a stale anchor is already ignored, because rendering
    // requires it to name the symbol currently picked. Clearing it in the effect
    // body would be a synchronous setState and a wasted render.
    if (!live || !picked) return;
    let live_ = true;
    void (async () => {
      try {
        const res = await fetch(
          api(`/api/feed/quote?type=${picked.type}&vendorId=${encodeURIComponent(picked.vendorId)}`),
        );
        const body = (await res.json()) as {
          quote: { price: number; high52: number | null; low52: number | null } | null;
        };
        if (!live_) return;
        setLiveAnchor({
          for: picked.symbol,
          price: body.quote?.price ?? null,
          high52: body.quote?.high52 ?? null,
          low52: body.quote?.low52 ?? null,
        });
      } catch {
        if (live_) setLiveAnchor({ for: picked.symbol, price: null, high52: null, low52: null });
      }
    })();
    return () => {
      live_ = false;
    };
  }, [live, picked, api]);

  /**
   * Opening a card marks it seen, up to the sequence this client rendered.
   *
   * Never on render. Glancing at a list of twelve is not reading ten of them,
   * and the whole read model exists because a last-visit timestamp gets that
   * wrong in a way no event log can fix.
   */
  const [openId, setOpenId] = useState<string | null>(null);

  const toggleCard = useCallback(
    async (card: CardView) => {
      const opening = openId !== card.id;
      setOpenId(opening ? card.id : null);
      if (!opening) return;
      await fetch(api(`/api/watchlist/${card.id}/read`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq: card.latestSeq }),
      });
      await refresh();
    },
    [openId, refresh, api],
  );

  const sim = useCallback(async (body: Record<string, unknown>): Promise<BoardView | null> => {
    const res = await fetch(api('/api/sim'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A scenario moves every list; we get back the one being looked at.
      body: JSON.stringify({ ...body, watchlistId: activeIdRef.current }),
    });
    if (!res.ok) return null;
    return (await res.json()) as BoardView;
  }, [api]);

  /**
   * Runs a scenario one tick at a time from the browser.
   *
   * Stepping rather than jumping to the end is the entire point: the moment
   * worth seeing is a card CHANGING, not a card that has already changed.
   */
  const runScenario = useCallback(
    async (id: string, ticks: number) => {
      setBusy(true);
      setError(null);
      try {
        const started = await sim({ action: 'start', scenario: id });
        if (started) setBoard(started);
        for (let i = 0; i < ticks; i++) {
          const next = await sim({ action: 'tick' });
          if (next) setBoard(next);
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
      } finally {
        setBusy(false);
      }
    },
    [sim],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      const next = await sim({ action: 'reset' });
      if (next) setBoard(next);
    } finally {
      setBusy(false);
    }
  }, [sim]);

  const acknowledge = useCallback(
    async (id: string) => {
      await fetch(api(`/api/watchlist/${id}/ack`), { method: 'POST' });
      await refresh();
    },
    [refresh, api],
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(api(`/api/watchlist/${id}`), { method: 'DELETE' });
      await Promise.all([refresh(), loadInstruments()]);
    },
    [refresh, loadInstruments, api],
  );

  /**
   * Places a paper order.
   *
   * The idempotency key is generated once per ticket, so a double-tapped
   * confirm returns the original order instead of placing a second trade.
   */
  const [ticketFor, setTicketFor] = useState<string | null>(null);

  const placeOrder = useCallback(
    async (body: Record<string, unknown>): Promise<string | null> => {
      const res = await fetch(api('/api/orders'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error: string; detail: string | null };
        return err.detail ?? err.error;
      }
      setTicketFor(null);
      await Promise.all([refresh(), loadInstruments()]);
      return null;
    },
    [refresh, loadInstruments, api],
  );

  /** The Ask panel. Answers come from live state; nothing here calls a model. */
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  /*
   * In the live feed you pick rather than type (D-133): its own search state,
   * separate from the add form's, so choosing something to ask about never
   * fills in something to add.
   */
  const askPick = useInstrumentSearch(live, api, (msg) =>
    setAnswer({ capability: 'UNSUPPORTED', answer: msg, disclosure: '', itemIds: [] }),
  );

  const submitCanned = useCallback(
    async (questionId: QuestionId) => {
      setAsking(true);
      try {
        const subject = askPick.picked;
        const res = await fetch(api('/api/ask'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            questionId,
            subject: subject ?? undefined,
            watchlistId: activeIdRef.current,
          }),
        });
        if (res.ok) {
          setAnswer((await res.json()) as AskAnswer);
        } else {
          // Say what happened rather than clearing the panel. A refused request
          // used to wipe the previous answer and put nothing in its place, which
          // reads exactly like the feature being broken (D-135).
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setAnswer({
            capability: 'UNSUPPORTED',
            answer: explainError(body.error ?? 'UNKNOWN'),
            disclosure: '',
            itemIds: [],
          });
        }
      } finally {
        setAsking(false);
      }
    },
    [api, askPick.picked],
  );

  const submitQuestion = useCallback(
    async (text: string) => {
      if (text.trim() === '') return;
      setAsking(true);
      try {
        const res = await fetch(api('/api/ask'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: text, watchlistId: activeIdRef.current }),
        });
        setAnswer(res.ok ? ((await res.json()) as AskAnswer) : null);
      } finally {
        setAsking(false);
      }
    },
    [api],
  );

  /** A proposed thesis is only ever saved when the user confirms it. */
  const confirmProposal = useCallback(async () => {
    if (!answer?.proposal) return;
    const res = await fetch(api('/api/watchlist'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        symbol: answer.proposal.symbol,
        thesisType: answer.proposal.thesisType,
        threshold: answer.proposal.threshold,
        watchlistId: activeIdRef.current,
      }),
    });
    if (res.ok) {
      setAnswer(null);
      setQuestion('');
      await Promise.all([refresh(), loadInstruments()]);
    } else {
      const err = (await res.json()) as { error: string };
      setAnswer({ ...answer, answer: explainError(err.error), proposal: undefined });
    }
  }, [answer, refresh, loadInstruments, api]);

  const switchList = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      setError(null);
      setEditing(null);
      setConfirmDelete(false);
      setBusy(true);
      try {
        // Both in one go: "already watched" is per list, so the picker changes
        // with the tab.
        await Promise.all([refresh(id), loadInstruments(id)]);
      } finally {
        setBusy(false);
      }
    },
    [refresh, loadInstruments],
  );

  const saveList = useCallback(async () => {
    const name = listName.trim();
    if (name === '') return;
    setError(null);
    const isNew = editing === 'new';
    const res = await fetch(api(isNew ? '/api/watchlists' : `/api/watchlists/${activeIdRef.current}`), {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error: string };
      setError(explainListError(body.error));
      return;
    }
    const body = (await res.json()) as { watchlist: { id: string } };
    setEditing(null);
    setListName('');
    // A brand new list is the one you meant to open.
    await switchList(isNew ? body.watchlist.id : activeIdRef.current);
    if (!isNew) await refresh();
  }, [editing, listName, switchList, refresh, api]);

  const removeList = useCallback(async () => {
    setError(null);
    const res = await fetch(api(`/api/watchlists/${activeIdRef.current}`), { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json()) as { error: string };
      setError(explainListError(body.error));
      setConfirmDelete(false);
      return;
    }
    const body = (await res.json()) as { watchlists: Array<{ id: string }> };
    setConfirmDelete(false);
    // The list we were on is gone, so land on whichever one is now first.
    activeIdRef.current = body.watchlists[0]?.id ?? activeIdRef.current;
    await Promise.all([refresh(activeIdRef.current), loadInstruments(activeIdRef.current)]);
  }, [refresh, loadInstruments, api]);

  const activeList = board.watchlists.find((w) => w.id === board.watchlistId);
  const selected = instruments.find((i) => i.symbol === symbol);
  /*
   * A symbol found by search is not in `instruments` until it has been added,
   * so `selected` is undefined for exactly the case live mode exists to serve.
   * Falling back to the entry set is what puts the price box on screen: it used
   * to be gated on a template flag that only the known-instrument path carried,
   * so picking "buy if it rises above" on a searched symbol offered nowhere to
   * type the price and then refused the add for not having one (D-125).
   */
  const offered = selected?.templates ?? (live && picked ? ENTRY_CHOICES : []);
  const selectedTemplate = offered.find((t) => t.type === thesisType);

  /*
   * The anchor under the picker.
   *
   * Simulated mode reads it off the instrument list, which already had the
   * price a row away; live mode has it from the pick. The 52-week range exists
   * only in live, and deliberately: the simulator generates a return path, not
   * a year of prices, so there is no series to take a maximum of. Rather than
   * reconstruct one to fill the same slot, the field is absent, which is the
   * same rule the rest of the app follows about numbers it was not given.
   */
  /*
   * The suggested questions, drawn from the board rather than typed in.
   *
   * They named INFY, SBIN and TCS, which are seeded simulated instruments. In
   * live mode you start empty and add whatever you like, so every suggestion
   * asked about something that was not there and came back "not on your
   * watchlist" -- the panel looking broken while working perfectly (D-131).
   *
   * Simulated mode keeps the written four: its instruments are fixed, the
   * questions are part of the rehearsed demo, and one of them exists to show
   * the refusal.
   */
  const askChips = ['why is INFY flagged?', 'what did I miss?', 'watch SBIN, buy below 700', 'should I buy TCS?'];

  // Which of the seven questions apply to what has been picked, and whether
  // the picked thing is on the list being looked at (D-133).
  const askWatched = askPick.picked !== null && board.cards.some((c) => c.symbol === askPick.picked?.symbol);
  const askQuestions = questionsFor(askPick.picked?.type ?? null, askWatched);

  const anchored = live ? (picked && liveAnchor?.for === picked.symbol ? liveAnchor : null) : null;
  const anchorPrice = live ? (anchored?.price ?? null) : (selected?.price ?? null);
  const high52 = anchored?.high52 ?? null;
  const low52 = anchored?.low52 ?? null;
  const wanted = threshold === '' ? null : Number(threshold);
  const outsideRange =
    wanted !== null &&
    Number.isFinite(wanted) &&
    high52 !== null &&
    low52 !== null &&
    (wanted > high52 || wanted < low52);

  const add = useCallback(async () => {
    setError(null);
    const res = await fetch(api('/api/watchlist'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        symbol,
        thesisType,
        threshold: threshold === '' ? undefined : Number(threshold),
        watchlistId: activeIdRef.current,
        // Live mode only, and only meaningful for a symbol the app has never
        // seen: the vendor id it takes to fetch it and the name to store.
        vendorId: picked?.vendorId,
        name: picked?.name,
        instrumentType: picked?.type,
      }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error: string };
      setError(explainError(body.error));
      return;
    }
    setSymbol('');
    setThesisType('');
    setThreshold('');
    setPicked(null);
    setQuery('');
    setResults([]);
    await Promise.all([refresh(), loadInstruments()]);
  }, [symbol, thesisType, threshold, picked, refresh, loadInstruments, api, setPicked, setQuery, setResults]);

  const attention = board.cards.filter((c) => c.state !== 'WATCHING');

  return (
    <div className="wrap">
      <header className="topbar">
        <div>
          <h1 className="brand">
            <Mark />
            <span>
              iKno<span className="brand-ww">ww</span>
            </span>
          </h1>
          <p className="tagline">
            Knows why you are watching, and tells you when a trigger fired for the wrong reason.
          </p>
        </div>
        <ModeSwitch mode={mode} delayMinutes={feedDelayMinutes} />
      </header>

      <section className="greet">
        <h2 className="greet-hi">Hi {board.user.name}</h2>
        <p className="greet-sub">{greetingLine(board)}</p>
      </section>

      <nav className="tabs" aria-label="Your watchlists">
        {board.watchlists.map((w) => (
          <button
            key={w.id}
            className={`tab${w.id === board.watchlistId ? ' on' : ''}`}
            disabled={busy}
            aria-current={w.id === board.watchlistId ? 'page' : undefined}
            onClick={() => void switchList(w.id)}
          >
            {w.name}
            <span className="tab-n">{w.itemCount}</span>
            {w.attentionCount > 0 && (
              <span
                className="tab-dot"
                title={`${w.attentionCount} need${w.attentionCount === 1 ? 's' : ''} a look`}
              />
            )}
          </button>
        ))}
        <button
          className="tab tab-new"
          disabled={busy || editing !== null}
          onClick={() => {
            setEditing('new');
            setListName('');
            setConfirmDelete(false);
          }}
        >
          + New list
        </button>
      </nav>

      {editing !== null && (
        <div className="list-editor">
          <input
            autoFocus
            type="text"
            maxLength={40}
            value={listName}
            placeholder={editing === 'new' ? 'Name this list' : 'Rename this list'}
            onChange={(e) => setListName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveList();
              if (e.key === 'Escape') setEditing(null);
            }}
          />
          <button className="primary" disabled={listName.trim() === ''} onClick={() => void saveList()}>
            Save
          </button>
          <button className="ghost" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      )}

      {editing === null && activeList && (
        <div className="list-actions">
          <button
            className="ghost"
            onClick={() => {
              setEditing('rename');
              setListName(activeList.name);
            }}
          >
            Rename
          </button>
          {confirmDelete ? (
            <>
              <span className="list-warn">
                Remove &ldquo;{activeList.name}&rdquo; and its {activeList.itemCount}{' '}
                {activeList.itemCount === 1 ? 'card' : 'cards'}? Orders and history are kept.
              </span>
              <button className="ghost danger" onClick={() => void removeList()}>
                Remove
              </button>
              <button className="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              className="ghost"
              disabled={board.watchlists.length <= 1}
              title={
                board.watchlists.length <= 1
                  ? 'Your only list. Your theses need somewhere to live.'
                  : undefined
              }
              onClick={() => setConfirmDelete(true)}
            >
              Delete list
            </button>
          )}
        </div>
      )}

      <section className="market">
        <div className="market-clock">
          <span className="clock-when">{board.market.clock.label}</span>
          <span className={`session ${board.market.clock.isOpen ? 'open' : 'shut'}`}>
            <span className="session-dot" />
            {board.market.clock.session}
          </span>
          {live && (
            <span
              className="hours-source"
              title={
                board.market.clock.hoursSource === 'feed'
                  ? 'Trading hours read from the exchange itself, alongside the quotes. Exchange holidays are not known, so the next open is the next weekday.'
                  : 'Trading hours could not be read from the feed, so the usual 9:15 to 3:30 weekday session is assumed.'
              }
            >
              {board.market.clock.hoursSource === 'feed' ? 'exchange hours' : 'assumed hours'}
            </span>
          )}
        </div>
        <div className="market-top">
          <span className="market-name">{board.market.name}</span>
          <span className="market-price">
            {board.market.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </span>
          <span className={`chg ${dirClass(board.market.changePct)}`}>
            {pct(board.market.changePct)}
          </span>
        </div>
        <p className="market-head">{board.market.headline}</p>
      </section>

      {live ? (
        <LivePanel
          delayMinutes={feedDelayMinutes}
          onRefresh={() => void refreshFeed(true)}
          busy={busy}
          note={feedNote}
          autoRefresh={autoRefresh}
          onToggleAuto={() => setAutoRefresh((on) => !on)}
        />
      ) : (
      <section className="panel sim-panel">
        <p className="panel-title">
          <span className="sim-tag">Simulator</span>
          Move the market
        </p>
        <div className="scenario-row">
          {board.scenarios.map((s) => (
            <button
              key={s.id}
              disabled={busy}
              onMouseEnter={() => setHovered(s.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => void runScenario(s.id, s.lengthTicks)}
            >
              {s.label}
            </button>
          ))}
          <span className="spacer" />
          {busy ? (
            <span className="running">
              <span className="dot" /> running
            </span>
          ) : (
            <button className="ghost" onClick={() => void reset()}>
              Reset session
            </button>
          )}
        </div>
        <p className="scenario-blurb">
          {board.scenarios.find((s) => s.id === hovered)?.blurb ??
            'Not part of the product. Prices here are generated, so a market event can be produced on demand \u2014 which is the only way to show what this watchlist does on a day something actually happens. On a real feed this panel would not exist.'}
        </p>
      </section>
      )}

      <div aria-live="polite" aria-atomic="false">
        {board.alerts.length > 0 && (
          <AlertBanner alerts={board.alerts} unreadChanges={board.changes.length} />
        )}
      </div>

      <div className="section-head">
        <p className="section-title">
          {activeList?.name ?? 'Your watchlist'} · {board.cards.length}{' '}
          {board.cards.length === 1 ? 'item' : 'items'}
        </p>
        <p className="section-title" style={{ color: 'var(--ink-3)', fontWeight: 500 }}>
          {attention.length === 0 ? 'nothing needs you' : `${attention.length} need${attention.length === 1 ? 's' : ''} a look`}
        </p>
      </div>

      <div className="cards">
        {board.cards.length === 0 && (
          <div className="card">
            <div className="quiet">
              <strong>Nothing on your watchlist yet</strong>
              Add something below and tell it why you are watching.
            </div>
          </div>
        )}
        {board.cards.map((c) => (
          <Card
            key={c.id}
            card={c}
            open={openId === c.id}
            ticketOpen={ticketFor === c.id}
            onOpenTicket={() => setTicketFor(ticketFor === c.id ? null : c.id)}
            onPlaceOrder={placeOrder}
            onToggle={toggleCard}
            onAck={acknowledge}
            onRemove={remove}
          />
        ))}
      </div>

      {board.cards.length > 0 && attention.length === 0 && (
        <div className="quiet">
          <strong>Nothing changed that you need to act on.</strong>
          That is a result, not an empty screen.
        </div>
      )}

      <section className="panel" style={{ marginTop: 22 }}>
        <p className="panel-title">{live ? 'Ask about a stock, a fund or an index' : 'Ask about your watchlist'}</p>
        {live ? (
          /*
           * Pick, don't type (D-133). The picker is the same search the add form
           * uses, with an Index segment the add form does not have (D-134), and
           * the questions are the seven the server will answer -- read from the
           * same list it validates against, so the two cannot disagree.
           */
          <>
            <TypeToggle
              type={askPick.type}
              allowIndex
              onType={(t) => {
                askPick.setType(t);
                askPick.setResults([]);
                askPick.setPicked(null);
                setAnswer(null);
              }}
            />
            <div className="add-grid">
              <InstrumentSearch
                type={askPick.type}
                query={askPick.query}
                onQuery={askPick.setQuery}
                results={askPick.results}
                searching={askPick.searching}
                picked={askPick.picked}
                onPick={(hit) => {
                  askPick.setPicked(hit);
                  setAnswer(null);
                }}
                anchor={null}
              />
            </div>
            <div className="chips" role="group" aria-label="Questions">
              {askQuestions.map((q) => (
                <button
                  key={q.id}
                  className="chip"
                  disabled={asking || (q.kinds.length > 0 && askPick.picked === null)}
                  onClick={() => void submitCanned(q.id)}
                >
                  {q.text}
                </button>
              ))}
            </div>
            {askPick.picked === null && (
              <p className="search-note">Pick something above to ask about it. “What did I miss?” needs nothing picked.</p>
            )}
          </>
        ) : (
          <>
            <div className="add-grid">
              <input
                className="ask-input"
                type="text"
                placeholder="why is INFY flagged?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitQuestion(question);
                }}
              />
              <button className="primary" disabled={asking || question.trim() === ''} onClick={() => void submitQuestion(question)}>
                Ask
              </button>
            </div>
            <div className="chips">
              {askChips.map((q) => (
                <button
                  key={q}
                  className="chip"
                  onClick={() => {
                    setQuestion(q);
                    void submitQuestion(q);
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </>
        )}
        <div aria-live="polite">
        {answer && (
          <div className="answer">
            <p className="answer-text">{answer.answer}</p>
            {answer.proposal && (
              <div className="card-actions">
                <span className="spacer" />
                <button className="ghost" onClick={() => setAnswer(null)}>
                  Cancel
                </button>
                <button className="primary" onClick={() => void confirmProposal()}>
                  Add this thesis
                </button>
              </div>
            )}
            <p className="answer-disclosure">{answer.disclosure}</p>
          </div>
        )}
        </div>
      </section>

      <section className="panel">
        <p className="panel-title">Watch something new</p>
        {live && (
          <TypeToggle
            type={searchType}
            onType={(t) => {
              setSearchType(t);
              setResults([]);
              setPicked(null);
              setSymbol('');
            }}
          />
        )}
        <div className="add-grid">
          {live ? (
            <InstrumentSearch
              type={searchType}
              query={query}
              onQuery={setQuery}
              results={results}
              searching={searching}
              picked={picked}
              onPick={(hit) => {
                setPicked(hit);
                setSymbol(hit.symbol);
                setThesisType('');
                setThreshold('');
              }}
              anchor={
                <PriceAnchor
                  price={anchorPrice}
                  high52={high52}
                  low52={low52}
                  outside={outsideRange}
                  wanted={wanted}
                />
              }
            />
          ) : (
            <div className="pick">
          <select
            value={symbol}
            onChange={(e) => {
              setSymbol(e.target.value);
              setThesisType('');
              setThreshold('');
            }}
          >
            <option value="">Pick an instrument…</option>
            <optgroup label="Stocks">
              {instruments
                .filter((i) => i.instrumentType === 'STOCK' && !i.watched)
                .map((i) => (
                  <option key={i.symbol} value={i.symbol}>
                    {i.symbol} — {i.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Mutual funds">
              {instruments
                .filter((i) => i.instrumentType === 'FUND' && !i.watched)
                .map((i) => (
                  <option key={i.symbol} value={i.symbol}>
                    {i.name}
                  </option>
                ))}
            </optgroup>
          </select>
              <PriceAnchor
                  price={anchorPrice}
                  high52={high52}
                  low52={low52}
                  outside={outsideRange}
                  wanted={wanted}
                />
            </div>
          )}

          <select
            value={thesisType}
            disabled={!symbol}
            onChange={(e) => setThesisType(e.target.value)}
          >
            <option value="">Why are you watching?</option>
            {offered.map((t) => (
              <option key={t.type} value={t.type}>
                {t.prompt}
              </option>
            ))}
          </select>

          {/*
            * The slot is always here; only the box inside it comes and goes.
            *
            * Rendering the input conditionally meant that choosing a thesis
            * CREATED a control between the select and the button, so Add jumped
            * a hundred and thirty pixels to the right, out from under the
            * pointer that had just been on it. Reserving the width costs an
            * empty gap before a thesis is chosen and buys a button that never
            * moves (D-129).
            */}
          <div className="price-slot">
            {selectedTemplate?.requiresThreshold && (
              <input
                type="number"
                placeholder="Price"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            )}
          </div>

          <button
            className="primary"
            disabled={!symbol || !thesisType || (selectedTemplate?.requiresThreshold === true && threshold === '')}
            onClick={() => void add()}
          >
            Add
          </button>
        </div>
        {error && <p className="err">{error}</p>}
        <p className="scenario-blurb">
          {live
            ? 'Searched against the live feed. Adding something new fetches two years of its history, which takes a second. Theses that need a holding appear on the card once you own it, and a fund is measured against the Nifty 500 unless it is one of the three we know the benchmark for.'
            : 'Theses that need a holding only appear for things you already own.'}
        </p>
      </section>

      {board.orders.length > 0 && <OrderHistory orders={board.orders} />}

      <footer className="foot">
        <p>
          {live ? (
            <>
              Prices and NAVs are real and delayed: stocks from Yahoo Finance&apos;s unofficial chart
              API, mutual fund NAVs from mfapi.in, which serves AMFI&apos;s official daily file.
              Betas are estimated by regression from two years of that history, by exactly the code
              that runs on the simulator. Orders are paper orders and move no money, and a watchlist
              built here is lost when this instance restarts.
            </>
          ) : (
            <>
              Prices, NAVs and history are simulated so a market event can be produced on demand.
              Betas are estimated by regression from that generated history, never read from the
              generator. Orders are paper orders and move no money.
            </>
          )}
        </p>
        <p className="foot-attrib">
          Built for <strong>Code, by Groww</strong> &middot; CODE 2026. Colours follow Groww&apos;s
          published design tokens. iKnoww is an independent hackathon entry and is not affiliated
          with Groww.
        </p>
      </footer>
    </div>
  );
}

/*
 * The mark is the attribution split itself: one bar, whose faint lower part is
 * the share of the move that belonged to the reference and whose solid upper
 * part is what was actually about your holding. It is the only picture the
 * product needs.
 */
/**
 * The two-mode switch, and the tooltip that has to carry the honest caveats.
 *
 * It is a link rather than a button because the mode lives in the URL: the
 * server then renders the right board on the first paint instead of flashing
 * the simulated one, and a judge can bookmark or share either mode.
 *
 * The tooltip text is repeated inside the live panel on purpose. `title` never
 * reaches a touch screen, and a caveat only a mouse can read is not disclosed.
 */
/**
 * The observed feed lag, in words.
 *
 * Measured rather than assumed, so on a Saturday afternoon it honestly reads
 * "yesterday" rather than the fifteen minutes it would be mid-session. Printing
 * "1414 min" would be equally true and useless.
 */
function describeDelay(minutes: number | null): string {
  if (minutes === null) return 'about 15 minutes';
  if (minutes < 1) return 'seconds';
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Live mode's instrument picker: a type toggle, then a search box.
 *
 * The toggle comes first because the two types go to two different APIs and
 * because `instrument_type` decides the reference, the staleness limit, the
 * templates and the order unit. Guessing it from a result would be the kind of
 * quiet wrongness this product exists to refuse.
 */
/**
 * The price a threshold is being typed against.
 *
 * It sits directly under the instrument's name and above the box that asks for
 * the number, because that is the order the decision is made in. It was first
 * placed under the whole row, which put it below the Add button -- beneath the
 * action it exists to inform, where it is read after the choice instead of
 * before it (D-128).
 */
function PriceAnchor({
  price,
  high52,
  low52,
  outside,
  wanted,
}: {
  price: number | null;
  high52: number | null;
  low52: number | null;
  outside: boolean;
  wanted: number | null;
}) {
  if (price === null) return null;
  return (
    <p className="anchor">
      Trading at {money(price)}
      {high52 !== null && low52 !== null && (
        <>
          {' · '}52-week {money(low52)} – {money(high52)}
        </>
      )}
      {outside && wanted !== null && (
        /*
         * Stated, never advised. A threshold outside the last year's range is a
         * thesis that cannot fire, which is a fact about the number rather than
         * an opinion about the trade -- the line the conviction copy holds
         * (D-045).
         */
        <span className="anchor-note">
          {' · '}
          {money(wanted)} is outside that range
        </span>
      )}
    </p>
  );
}

/**
 * What you are looking for, on its own line above the controls.
 *
 * It used to sit at the top of the search column, which made that column two
 * rows taller than everything beside it -- and since the row was centred, the
 * thesis select and the Add button drifted downwards as the column grew a
 * result, a name and a price. Above the row, every control top-aligns and
 * nothing moves (D-129).
 */
function TypeToggle({
  type,
  onType,
  allowIndex = false,
}: {
  type: SearchKind;
  onType: (t: SearchKind) => void;
  /** Only the Ask panel may pick an index (D-134); the add form never can. */
  allowIndex?: boolean;
}) {
  return (
    <div className="type-toggle" role="group" aria-label="What are you looking for?">
      <button
        className={type === 'STOCK' ? 'type-on' : 'type-off'}
        aria-pressed={type === 'STOCK'}
        onClick={() => onType('STOCK')}
      >
        Stock
      </button>
      <button
        className={type === 'FUND' ? 'type-on' : 'type-off'}
        aria-pressed={type === 'FUND'}
        onClick={() => onType('FUND')}
      >
        Mutual fund
      </button>
      {allowIndex && (
        <button
          className={type === 'INDEX' ? 'type-on' : 'type-off'}
          aria-pressed={type === 'INDEX'}
          onClick={() => onType('INDEX')}
        >
          Index
        </button>
      )}
    </div>
  );
}

/**
 * The debounced live search, as a hook, because two panels need it.
 *
 * 300ms after the typing stops rather than per keystroke. The feed is an
 * unofficial endpoint that rate-limits, and spending someone else's quota one
 * character at a time is how it starts refusing us. One implementation rather
 * than two, for the reason D-125 recorded: a parallel copy drifts, and drift
 * in a search is a result one panel finds and the other does not.
 */
function useInstrumentSearch(
  live: boolean,
  api: (path: string) => string,
  onFail: (message: string) => void,
) {
  const [type, setType] = useState<SearchKind>('STOCK');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<SearchResult | null>(null);
  // Kept in a ref and synced in an effect, so that an inline callback from the
  // caller does not restart the debounce on every render.
  const failRef = useRef(onFail);
  useEffect(() => {
    failRef.current = onFail;
  }, [onFail]);

  useEffect(() => {
    if (!live) return;
    const q = query.trim();
    // Clearing is scheduled like the search itself rather than done inline: a
    // setState in the synchronous body of an effect cascades a render.
    const timer = setTimeout(() => {
      if (q.length < 2) {
        setResults([]);
        return;
      }
      void (async () => {
        setSearching(true);
        try {
          const res = await fetch(api(`/api/feed/search?type=${type}&q=${encodeURIComponent(q)}`));
          setResults(res.ok ? ((await res.json()) as { results: SearchResult[] }).results : []);
          if (!res.ok) {
            failRef.current('Could not search just now. The price feed is unofficial and rate-limits.');
          }
        } finally {
          setSearching(false);
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [live, query, type, api]);

  /*
   * Typing after a pick clears it. Without this the results list stayed hidden
   * behind the picked line for ever, so a second pick was impossible without
   * switching the type toggle back and forth -- and picking repeatedly is the
   * whole premise of the Ask panel (D-135).
   */
  const changeQuery = (q: string) => {
    setQuery(q);
    setPicked(null);
  };

  return {
    type,
    setType,
    query,
    setQuery: changeQuery,
    results,
    setResults,
    searching,
    picked,
    setPicked,
  };
}

function InstrumentSearch({
  type,
  query,
  onQuery,
  results,
  searching,
  picked,
  onPick,
  anchor,
}: {
  type: SearchKind;
  query: string;
  onQuery: (q: string) => void;
  results: SearchResult[];
  searching: boolean;
  picked: SearchResult | null;
  onPick: (hit: SearchResult) => void;
  /** The price line, rendered under the name it describes (D-128). */
  anchor: React.ReactNode;
}) {
  const placeholder =
    type === 'STOCK' ? 'Search NSE stocks…' : type === 'FUND' ? 'Search mutual funds…' : 'Search NSE indices…';
  return (
    <div className="search">
      <input
        type="search"
        value={query}
        placeholder={placeholder}
        onChange={(e) => onQuery(e.target.value)}
        aria-label="Search instruments"
      />

      {picked ? (
        <>
          <p className="search-picked">
            {picked.type === 'INDEX' ? picked.name : `${picked.symbol} · ${picked.name}`}
          </p>
          {anchor}
        </>
      ) : searching ? (
        <p className="search-note">Searching…</p>
      ) : query.trim().length >= 2 && results.length === 0 ? (
        <p className="search-note">Nothing on the NSE matches that.</p>
      ) : (
        <ul className="search-results">
          {results.map((r) => (
            <li key={r.symbol}>
              <button onClick={() => onPick(r)}>
                <span className="search-sym">
                  {r.type === 'FUND' ? 'Fund' : r.type === 'INDEX' ? 'Index' : r.symbol}
                </span>
                <span className="search-name">{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ModeSwitch({ mode, delayMinutes }: { mode: FeedMode; delayMinutes: number | null }) {
  const liveTip =
    `Live feed — last quote ${describeDelay(delayMinutes)} old; ` +
    'about 15 minutes behind the exchange while it is trading. ' +
    'Stocks and indices: Yahoo Finance chart API (unofficial, no key). ' +
    'Mutual funds: mfapi.in, serving AMFI’s official daily NAV file. ' +
    'The Simulator and Reset are unavailable here, because nothing can be made ' +
    'to happen on demand on a real feed. Watchlists here are separate from the ' +
    'simulated ones and are lost when the free instance restarts.';

  return (
    <div className="mode-switch" role="group" aria-label="Data source">
      <Link
        className={mode === 'sim' ? 'mode-on' : 'mode-off'}
        href="/?mode=sim"
        aria-current={mode === 'sim' ? 'true' : undefined}
        title="Simulated data. Self-contained, needs no network, and every market event can be produced on demand."
      >
        Simulated data
      </Link>
      <Link
        className={mode === 'live' ? 'mode-on' : 'mode-off'}
        href="/?mode=live"
        aria-current={mode === 'live' ? 'true' : undefined}
        title={liveTip}
      >
        Live feed
      </Link>
    </div>
  );
}

/**
 * Live mode's counterpart to the Simulator panel, in the same instrumentation
 * register, saying what live mode cannot do rather than hiding it.
 */
/**
 * What went wrong with the feed, in a sentence a person can act on.
 *
 * Each one names the cause, says what the board is showing instead, and points
 * at the thing that still works. A live failure must never read as the app
 * being broken, because the app is not: it is showing the last prices it was
 * given, and Simulated data is one click away.
 */
function explainFeedError(kind: string): string {
  switch (kind) {
    case 'RATE_LIMIT':
      return 'The price feed is rate-limiting us, so these are the last prices it gave us. It is a free, unofficial endpoint with no guarantee. Turn off auto-refresh and try the button again in a minute, or switch to Simulated data, which never touches the network.';
    case 'NETWORK':
    case 'UNREACHABLE':
      return 'Could not reach the price feed. These are the last prices it gave us, and nothing on the board has been lost. Try Refresh again, or switch to Simulated data, which works offline.';
    case 'HTTP':
      return 'The price feed answered with an error, so these are the last prices it gave us. Try Refresh again in a moment, or switch to Simulated data.';
    case 'SHAPE':
      return 'The price feed sent something we could not read, so these are the last prices it gave us. That is what an unofficial endpoint with no stability guarantee looks like when it changes. Simulated data is unaffected.';
    default:
      return 'Something went wrong reaching the price feed. These are the last prices it gave us, and Simulated data still works.';
  }
}

function LivePanel({
  delayMinutes,
  onRefresh,
  busy,
  note,
  autoRefresh,
  onToggleAuto,
}: {
  delayMinutes: number | null;
  onRefresh: () => void;
  busy: boolean;
  note: string | null;
  autoRefresh: boolean;
  onToggleAuto: () => void;
}) {
  return (
    <section className="panel live-panel">
      <p className="panel-title">
        <span className="live-tag">Live feed</span>
        {`Real NSE prices · last quote ${describeDelay(delayMinutes)} old`}
      </p>
      <div className="scenario-row">
        <button disabled={busy} onClick={onRefresh}>
          {busy ? 'Fetching…' : 'Refresh prices'}
        </button>
        <button
          className="ghost"
          aria-pressed={autoRefresh}
          onClick={onToggleAuto}
          title={
            autoRefresh
              ? 'Refreshing every minute while this tab is open. Turn it off to fetch only when you press the button.'
              : 'Not refreshing on its own. Press Refresh prices when you want a new quote.'
          }
        >
          Auto refresh: {autoRefresh ? 'on' : 'off'}
        </button>
        <span className="spacer" />
      </div>
      <p className="scenario-blurb">
        {note ??
          'Stocks and indices come from Yahoo Finance’s chart API and mutual fund NAVs from mfapi.in, which serves AMFI’s official daily file. Neither needs a key, and neither carries any guarantee. The Simulator and Reset are gone here because nothing can be made to happen on demand on a real feed — which is exactly why the simulated mode exists. Anything you add here is kept only on this instance and is lost when it restarts.'}
      </p>
    </section>
  );
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="var(--accent)" />
      <rect x="9" y="5" width="6" height="14" rx="3" fill="#fff" opacity="0.38" />
      <rect x="9" y="5" width="6" height="7" rx="3" fill="#fff" />
    </svg>
  );
}

function AlertBanner({
  alerts,
  unreadChanges,
}: {
  alerts: BoardView['alerts'];
  unreadChanges: number;
}) {
  // Retractions are alerts too, but they are an apology rather than news, so
  // they are counted and rendered separately. Folding one into "2 alerts sent"
  // would be the product quietly congratulating itself for a mistake.
  const digests = alerts.filter((a) => a.kind === 'DIGEST');
  const retracted = alerts.filter((a) => a.kind === 'RETRACTION');
  const withdrawn = new Set(retracted.map((r) => r.retractsAlertId));
  const sent = digests.filter((a) => a.status === 'SENT');
  const held = digests.filter((a) => a.status === 'HELD_QUIET_HOURS');
  const latest = sent.find((a) => !withdrawn.has(a.id));

  return (
    <section className="alerts">
      <p className="panel-title">
        {sent.length === 0
          ? 'Nothing was worth interrupting you for'
          : `${sent.length} ${sent.length === 1 ? 'alert' : 'alerts'} sent`}
        {held.length > 0 && ` · ${held.length} held until the market opens`}
        {retracted.length > 0 && ` · ${retracted.length} withdrawn`}
      </p>
      {retracted.length > 0 && (
        <ul className="retractions">
          {retracted.map((r) => (
            <li key={r.id}>{r.title}</li>
          ))}
        </ul>
      )}
      {latest ? (
        <ul className="alert-list">
          {latest.items.map((i) => (
            <li key={i.itemId}>{i.headline}</li>
          ))}
        </ul>
      ) : (
        <p className="alert-none">
          Cards changed, but a trigger that fires because the whole market moved is not
          something we are entitled to interrupt you for.
        </p>
      )}
      {unreadChanges > 0 && (
        <p className="alert-foot">
          {unreadChanges} {unreadChanges === 1 ? 'change' : 'changes'} you have not opened yet.
          Being notified is not the same as having read it.
        </p>
      )}
    </section>
  );
}

function Card({
  card,
  open,
  ticketOpen,
  onOpenTicket,
  onPlaceOrder,
  onToggle,
  onAck,
  onRemove,
}: {
  card: CardView;
  open: boolean;
  ticketOpen: boolean;
  onOpenTicket: () => void;
  onPlaceOrder: (body: Record<string, unknown>) => Promise<string | null>;
  onToggle: (card: CardView) => Promise<void>;
  onAck: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const reviewing = card.state === 'NEEDS_REVIEW' || card.state === 'UNEXPLAINED';
  const canTrade =
    card.action !== 'NONE' &&
    (card.state === 'ACTIONABLE' || card.state === 'NEEDS_REVIEW') &&
    (card.action === 'BUY' || card.positionQuantity > 0);
  return (
    <article className={`card ${card.state}`}>
      <div className="card-top" onClick={() => void onToggle(card)} role="button" tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') void onToggle(card);
        }}
        style={{ cursor: 'pointer' }}
      >
        <span className="sym">{card.symbol}</span>
        {card.unread > 0 && (
          <>
            <span className="unread" aria-hidden="true" />
            <span className="sr-only">
              {card.unread} unread {card.unread === 1 ? 'change' : 'changes'}
            </span>
          </>
        )}
        <span className="nm">{card.name}</span>
        <span className="px">{money(card.price)}</span>
        <span className={`chg ${dirClass(card.changePct)}`}>{pct(card.changePct)}</span>
      </div>

      <p className="thesis">
        <span className={`badge ${card.state}`}>{card.state.replace('_', ' ')}</span>{' '}
        <span className="badge type">{card.instrumentType === 'FUND' ? 'Fund' : 'Stock'}</span>{' '}
        <strong>{card.thesisLine}</strong>
        {card.positionQuantity > 0 && ` · holding ${card.positionQuantity}`}
        {card.unrealised !== null && (
          <span className={`pnl ${dirClass(card.unrealised.pct)}`}>
            {' · '}
            {card.unrealised.amount >= 0 ? '+' : '−'}
            {money(Math.abs(card.unrealised.amount))} ({pct(card.unrealised.pct)})
          </span>
        )}
      </p>

      <p className="says">{card.line}</p>

      {/*
        * How far the thesis still is from firing, and when the price was taken.
        *
        * The first was left to the reader to work out from a price and a
        * sentence; the second only ever spoke when something was wrong, so the
        * reassurance that a fourteen-hour NAV is normal was invisible (D-130).
        */}
      <p className="card-meta">
        {card.triggerDistance !== null && card.threshold !== null && (
          <span className="to-trigger">
            {/* Unsigned: a distance has no direction, and pct() would print a
                leading plus that reads as a gain. */}
            {(card.triggerDistance * 100).toFixed(1)}% from your {money(card.threshold)} trigger
          </span>
        )}
        {card.triggerDistance !== null && card.threshold !== null && ' · '}
        {card.asOfLine}
      </p>

      {/*
        * An assumed benchmark, said on the card rather than only in the README.
        *
        * mfapi does not carry a scheme's stated benchmark, so a fund added from
        * a live search is measured against the Nifty 500. That is the least
        * wrong stand-in for a diversified equity fund and genuinely wrong for a
        * sector or debt one. A single-factor model against the wrong reference
        * produces a PLAUSIBLE number, which is worse than an obviously broken
        * one, so it is labelled where the number itself appears.
        *
        * Only the runtime-added funds, which carry the MF_ prefix. The three
        * seeded funds have their real benchmarks.
        */}
      {card.instrumentType === 'FUND' && card.symbol.startsWith('MF_') && (
        <p className="assumed-note">
          Measured against the Nifty 500, which is an assumed benchmark. The feed does not publish
          this scheme&apos;s stated one.
        </p>
      )}

      {open && (
        <div className="detail">
          <dl className="detail-grid">
            <div>
              <dt>Reference</dt>
              <dd>{card.referenceSymbol ?? '—'}</dd>
            </div>
            <div>
              <dt>Attributed to it</dt>
              <dd>{card.shareReference === null ? '—' : `${Math.round(card.shareReference * 100)}%`}</dd>
            </div>
            <div>
              <dt>Surprise</dt>
              <dd>{card.z === null ? '—' : `${card.z.toFixed(2)}σ`}</dd>
            </div>
            <div>
              <dt>Conviction</dt>
              <dd>{card.band}</dd>
            </div>
          </dl>
          <p className="detail-title">History</p>
          <ul className="history">
            {card.history.map((h) => (
              <li key={h.seq}>
                <span className="history-state">
                  {h.fromState} → {h.toState}
                </span>
                {h.notifiedAt !== null && <span className="history-flag">notified</span>}
                <span className="history-reason">{h.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {ticketOpen && <OrderTicket card={card} onPlaceOrder={onPlaceOrder} />}

      <div className="card-actions">
        {card.stale && <span className="stale">Price is stale · not acting on it</span>}
        {card.state === 'FULFILLED' && (
          <span className="stale" style={{ color: 'var(--ink-3)' }}>
            Acted on · this thesis has stopped firing
          </span>
        )}
        <span className="spacer" />
        {card.state === 'UNEXPLAINED' && <button onClick={() => void onAck(card.id)}>Got it</button>}
        {canTrade && (
          <button className={card.state === 'ACTIONABLE' ? 'primary' : ''} onClick={onOpenTicket}>
            {ticketOpen
              ? 'Cancel'
              : card.state === 'NEEDS_REVIEW'
                ? card.action === 'SELL'
                  ? 'Sell anyway'
                  : 'Buy anyway'
                : card.action === 'SELL'
                  ? 'Sell'
                  : 'Buy'}
          </button>
        )}
        {reviewing && card.state === 'NEEDS_REVIEW' && (
          <button className="ghost" onClick={() => void onAck(card.id)}>
            I have read this
          </button>
        )}
        <button className="ghost" onClick={() => void onRemove(card.id)}>
          Remove
        </button>
      </div>
    </article>
  );
}

/**
 * The order ticket.
 *
 * On a weak signal this is where the friction lives: an acknowledgement naming
 * the reason, and one question drawn from the thesis whose answer is stored on
 * the order. A warning is something to dismiss; a question is something to
 * answer.
 */
function OrderTicket({
  card,
  onPlaceOrder,
}: {
  card: CardView;
  onPlaceOrder: (body: Record<string, unknown>) => Promise<string | null>;
}) {
  const byAmount = card.buysBy === 'AMOUNT' && card.action === 'BUY';
  const [value, setValue] = useState(byAmount ? '5000' : '10');
  const [answer, setAnswer] = useState('');
  const [acked, setAcked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => `ord_${Math.random().toString(36).slice(2)}`);

  const needsAck = card.state === 'NEEDS_REVIEW';
  const n = Number(value);
  const valid = Number.isFinite(n) && n > 0 && (!needsAck || acked);

  return (
    <div className="ticket">
      <p className="ticket-title">
        Paper {card.action === 'SELL' ? 'sell' : 'buy'} · {card.symbol}
        <span className="ticket-tag">no money moves</span>
      </p>

      {needsAck && card.checkIn && (
        <div className="checkin">
          <p className="checkin-q">{card.checkIn.question}</p>
          <input
            type="text"
            placeholder="In your own words (optional)"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </div>
      )}

      <div className="add-grid">
        <label className="ticket-label">
          {byAmount ? 'Amount (₹)' : 'Quantity'}
          <input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {card.action === 'SELL' && (
          <span className="ticket-hint">holding {card.positionQuantity}</span>
        )}
      </div>

      {needsAck && (
        <label className="ack">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
          <span>{card.line}</span>
        </label>
      )}

      <div className="card-actions">
        <span className="spacer" />
        <button
          className="primary"
          disabled={!valid}
          onClick={async () => {
            const err = await onPlaceOrder({
              itemId: card.id,
              side: card.action,
              quantity: byAmount ? undefined : n,
              amount: byAmount ? n : undefined,
              acknowledgedLowConviction: acked,
              checkInQuestion: card.checkIn?.question,
              checkInAnswer: answer === '' ? undefined : answer,
              idempotencyKey: key,
            });
            setError(err);
          }}
        >
          Place paper order
        </button>
      </div>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

/** Every order carries the thesis and the conviction showing when it was placed. */
function OrderHistory({ orders }: { orders: BoardView['orders'] }) {
  return (
    <section className="panel" style={{ marginTop: 22 }}>
      <p className="panel-title">Order history · your trade remembers why you made it</p>
      <ul className="orders">
        {orders.map((o) => {
          const share = o.convictionSnapshot.shareReference as number | null;
          return (
            <li key={o.id}>
              <div className="order-top">
                <span className="sym">{o.symbol}</span>
                <span className={`badge ${o.side === 'SELL' ? 'NEEDS_REVIEW' : 'ACTIONABLE'}`}>
                  {o.side}
                </span>
                <span className="order-qty">
                  {o.quantity === null ? '' : `${Number(o.quantity).toFixed(2)} units`}
                  {o.amount === null ? '' : ` · ₹${Math.round(o.amount).toLocaleString('en-IN')}`}
                </span>
                <span className="spacer" />
                <span className="badge type">{o.status.replace(/_/g, ' ')}</span>
              </div>
              <p className="order-why">
                <strong>{o.thesisSnapshot.line}</strong>
                {share !== null && ` · ${Math.round(share * 100)}% of the move was the reference`}
                {o.acknowledgedLowConviction && ' · you acted past a weak signal'}
              </p>
              {o.checkInAnswer && <p className="order-answer">“{o.checkInAnswer}”</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function explainError(code: string): string {
  switch (code) {
    case 'ONLY_IN_LIVE_MODE':
      return 'That question belongs to the live feed. Simulated data has its own Ask box.';
    case 'UNKNOWN_QUESTION':
      return 'I do not have that question. Pick one of the ones listed.';
    case 'MISSING_SUBJECT':
      return 'Pick a stock, a fund or an index first, and then ask.';
    case 'QUESTION_NOT_FOR_SUBJECT':
      return 'That question does not apply to what you picked.';
    case 'INDEX_NOT_WATCHABLE':
      return 'An index cannot be watched as a card: it has no reference of its own, so there would be nothing to measure it against. Ask about it instead.';
    case 'DUPLICATE':
      return 'That is already on your watchlist. Edit the thesis instead.';
    case 'NOT_WATCHABLE':
      return 'An index is the yardstick, not a holding. Its move is on the card above.';
    case 'POSITION_REQUIRED':
      return 'That thesis is about a holding you do not have yet.';
    case 'THRESHOLD_REQUIRED':
      return 'This thesis needs a price.';
    case 'INVALID_THRESHOLD':
      return 'That price does not look right.';
    case 'UNKNOWN_SYMBOL':
      return 'We do not have that instrument. Pick one from the search results.';
    case 'FEED_UNAVAILABLE':
      // The add is the one action that must reach the network, because a new
      // instrument needs two years of history before its card can say anything.
      // Nothing was half-added: the instrument is rolled back on a failed
      // fetch, so trying again is safe.
      return 'Could not fetch that instrument’s history just now, so it was not added. The price feed is free and unofficial, and this happens. Try again in a moment, or use Simulated data, which needs no network.';
    case 'RATE_LIMIT':
      return 'The price feed is rate-limiting us, so that instrument was not added. Wait a minute and try again.';
    default:
      return `Could not add that (${code}).`;
  }
}
