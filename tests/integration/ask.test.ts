import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../src/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '../../src/lib/db/seed';
import { ask, buildContext, ScriptedResponder, DISCLOSURE } from '../../src/lib/ask/service';
import { parseThesis, resolveSymbol } from '../../src/lib/ask/parser';
import { startScenario, tick } from '../../src/lib/sim/ticker';
import { evaluateAll } from '../../src/lib/engine/states';

const USER = DEFAULT_USER_ID;
const LIST = DEFAULT_WATCHLIST_ID;

function crash(db: Database.Database): void {
  startScenario(db, 'market-crash');
  for (let i = 0; i < 12; i++) {
    tick(db);
    evaluateAll(db);
  }
}

const UNIVERSE = [
  { symbol: 'HDFCBANK', name: 'HDFC Bank' },
  { symbol: 'ICICIBANK', name: 'ICICI Bank' },
  { symbol: 'TCS', name: 'Tata Consultancy Services' },
  { symbol: 'DIVISLAB', name: 'Divis Laboratories' },
  { symbol: 'UTI_NIFTY50', name: 'UTI Nifty 50 Index Fund' },
];

describe('the thesis parser is real code, not a lookup table', () => {
  it.each([
    ['watch HDFC Bank, add more below 1500', 'HDFCBANK', 'ADD_MORE', 1500],
    ['buy TCS below 3800', 'TCS', 'DIP_BUY', 3800],
    ['buy divislab above 6500', 'DIVISLAB', 'BREAKOUT_BUY', 6500],
    ['book profit on tcs above 4,200', 'TCS', 'BOOK_PROFIT', 4200],
    ['exit hdfc bank below 1,450', 'HDFCBANK', 'PROTECT', 1450],
    ['stop loss on TCS under 3500', 'TCS', 'PROTECT', 3500],
  ] as const)('parses %s', (input, symbol, type, threshold) => {
    const r = parseThesis(input, UNIVERSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.thesis.symbol).toBe(symbol);
    expect(r.thesis.thesisType).toBe(type);
    expect(r.thesis.threshold).toBe(threshold);
  });

  it('understands Indian number shorthand', () => {
    const r = parseThesis('buy tcs below 3.8k', UNIVERSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.thesis.threshold).toBe(3800);
  });

  it('reads a direction word over the template default', () => {
    // "book profit below" is contradictory; treating it as a protective exit is
    // the honest reading, and silently flipping it to a target above would put
    // the wrong thesis on a real card.
    const r = parseThesis('book profit on tcs below 3000', UNIVERSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.thesis.thesisType).toBe('PROTECT');
  });

  it('restates what it understood, for confirmation', () => {
    const r = parseThesis('watch HDFC Bank, add more below 1500', UNIVERSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.thesis.restated).toContain('HDFCBANK');
    expect(r.thesis.restated).toContain('₹1,500');
  });
});

describe('the parser asks rather than guessing', () => {
  it('refuses an ambiguous symbol and offers the candidates', () => {
    // A wrong symbol on a real order is unacceptable and the cost of asking is
    // one tap.
    const r = parseThesis('buy bank below 1500', [
      { symbol: 'HDFCBANK', name: 'HDFC Bank' },
      { symbol: 'ICICIBANK', name: 'ICICI Bank' },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.reason).toBe('AMBIGUOUS_SYMBOL');
  });

  it('says what it did understand when the instrument is missing', () => {
    const r = parseThesis('buy something below 500', UNIVERSE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.reason).toBe('NO_SYMBOL');
    expect(r.failure.understood).toContain('₹500');
  });

  it('asks for the level when only the intent is clear', () => {
    const r = parseThesis('buy the dip in TCS', UNIVERSE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.reason).toBe('NO_THRESHOLD');
  });

  it('resolves a symbol from a partial name', () => {
    expect(resolveSymbol('what about tata consultancy', UNIVERSE)).toEqual({ symbol: 'TCS' });
  });
});

describe('the three guardrails', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb(true);
    crash(db);
  });

  it('refuses to give advice, and says what it can do instead', () => {
    const r = ask(db, LIST, USER, 'should I buy TCS?');
    expect(r.capability).toBe('REFUSED_ADVICE');
    expect(r.answer).toMatch(/will not tell you what to buy or sell/i);
    expect(r.answer).toMatch(/what I can do|What I can do/);
  });

  it.each([
    'is it a good time to buy INFY',
    'what should I sell',
    'do you recommend TCS',
  ])('refuses "%s" too', (q) => {
    expect(ask(db, LIST, USER, q).capability).toBe('REFUSED_ADVICE');
  });

  it('never states a number the card does not have', () => {
    // Every figure in a response must appear in the context it was given, or be
    // a rounding or a percentage of one. This is the property that makes a
    // hallucination rate of zero a real claim rather than a slogan.
    const context = buildContext(db, LIST, 'why is INFY flagged?');
    const response = new ScriptedResponder().respond(context);

    const allowed = new Set<number>();
    const admit = (v: number) => {
      if (!Number.isFinite(v)) return;
      allowed.add(v);
      allowed.add(Number(v.toFixed(0)));
      allowed.add(Number(v.toFixed(1)));
      allowed.add(Number(v.toFixed(2)));
    };
    const walk = (node: unknown): void => {
      if (typeof node === 'number') {
        admit(node);
        // The forms a card legitimately renders: a percentage, its complement,
        // and a signed percentage move.
        admit(node * 100);
        admit((1 - node) * 100);
        admit(Math.abs(node * 100));
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        Object.values(node).forEach(walk);
      }
    };
    walk(context);
    // Counts of things the answer may legitimately state about itself.
    for (let n = 0; n <= context.cards.length; n++) allowed.add(n);

    // Strip thousands separators, or "₹1,514.74" is read as two numbers and the
    // check fails on an artefact of its own regex.
    const plain = response.answer.replace(/(\d),(?=\d{3})/g, '$1');
    for (const raw of plain.match(/\d+(?:\.\d+)?/g) ?? []) {
      const n = Number(raw);
      expect(allowed.has(n), `${n} should come from the context`).toBe(true);
    }
  });

  it('labels every response, without exception', () => {
    for (const q of ['why is INFY flagged?', 'should I buy?', 'what did I miss?', 'asdfgh']) {
      expect(ask(db, LIST, USER, q).disclosure).toBe(DISCLOSURE);
    }
  });
});

describe('explaining a card', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb(true);
    crash(db);
  });

  it('narrates the thesis, the split, and what would change it', () => {
    const r = ask(db, LIST, USER, 'why is INFY flagged?');
    expect(r.capability).toBe('EXPLAIN');
    expect(r.answer).toContain('Your thesis on INFY');
    expect(r.answer).toMatch(/% of this move is the market/);
    expect(r.answer).toMatch(/review rather than act/);
  });

  it('gives numbers that match the card, and change with the scenario', () => {
    // Canned strings would not do this. Run a different scenario and the
    // percentage genuinely changes, because it is read from live state.
    const crashed = ask(db, LIST, USER, 'why is INFY flagged?').answer;

    const other = createTestDb(true);
    startScenario(other, 'single-stock-shock');
    for (let i = 0; i < 8; i++) {
      tick(other);
      evaluateAll(other);
    }
    const quiet = ask(other, LIST, USER, 'why is INFY flagged?').answer;
    expect(crashed).not.toBe(quiet);
  });

  it('says the history is insufficient rather than quoting a percentage', () => {
    // The no-fabricated-numbers rule holds inside the assistant too.
    db.prepare("DELETE FROM symbol_stats WHERE symbol = 'INFY'").run();
    const r = ask(db, LIST, USER, 'why is INFY flagged?');
    expect(r.answer).toMatch(/not enough history/i);
    expect(r.answer).not.toMatch(/\d+% of this move/);
  });

  it('says so plainly when asked about something not on the watchlist', () => {
    const r = ask(db, LIST, USER, 'why is SBIN moving?');
    expect(r.answer).toContain('not on your watchlist');
  });
});

describe('catching up', () => {
  it('reads out what changed, without ranking it', () => {
    const db = createTestDb(true);
    crash(db);
    const r = ask(db, LIST, USER, 'what did I miss?');
    expect(r.capability).toBe('CATCH_UP');
    expect(r.answer).toMatch(/cards? changed since you last looked/);
    expect(r.itemIds.length).toBeGreaterThan(0);
  });

  it('says nothing changed, as a real answer', () => {
    const db = createTestDb(true);
    const r = ask(db, LIST, USER, 'what did I miss?');
    expect(r.answer).toMatch(/Nothing has changed/);
    expect(r.answer).toMatch(/real answer rather than an empty screen/);
  });
});

describe('turning a sentence into a thesis', () => {
  it('proposes without saving', () => {
    const db = createTestDb(true);
    const before = db.prepare('SELECT COUNT(*) AS n FROM watchlist_items').get() as { n: number };
    const r = ask(db, LIST, USER, 'watch SBIN, buy below 700');
    expect(r.capability).toBe('PARSE_THESIS');
    expect(r.proposal).toMatchObject({ symbol: 'SBIN', thesisType: 'DIP_BUY', threshold: 700 });
    const after = db.prepare('SELECT COUNT(*) AS n FROM watchlist_items').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('asks for the missing piece rather than inventing one', () => {
    const db = createTestDb(true);
    const r = ask(db, LIST, USER, 'watch SBIN');
    expect(r.capability).toBe('PARSE_THESIS');
    expect(r.proposal).toBeUndefined();
    expect(r.answer).toMatch(/what you want to do about it|price to trigger/i);
  });
});

describe('the edges are honest', () => {
  it('refuses what it has no data for, and names what it can do', () => {
    const db = createTestDb(true);
    const r = ask(db, LIST, USER, 'what is the news on Reliance earnings');
    expect(r.capability).toBe('UNSUPPORTED');
    expect(r.answer).toMatch(/no news feed/);
    expect(r.answer).toMatch(/I can explain any card/);
  });

  it('logs every answer with the context that produced it', () => {
    // Reproducible and auditable after the fact, which is what makes the
    // no-fabrication claim checkable rather than just asserted.
    const db = createTestDb(true);
    ask(db, LIST, USER, 'why is INFY flagged?');
    const row = db
      .prepare('SELECT capability, context, response_text AS text FROM ask_log ORDER BY id DESC LIMIT 1')
      .get() as { capability: string; context: string; text: string };
    expect(row.capability).toBe('EXPLAIN');
    expect(row.text.length).toBeGreaterThan(0);
    expect(JSON.parse(row.context).cards.length).toBeGreaterThan(0);
  });
});
