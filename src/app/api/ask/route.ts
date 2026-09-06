import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import { resolveWatchlist } from '@/lib/watchlist/lists';
import { ask } from '@/lib/ask/service';
import { askCanned, QUESTIONS, type AskSubject, type QuestionId } from '@/lib/ask/canned';

export const dynamic = 'force-dynamic';

interface Body {
  question?: string;
  watchlistId?: string;
  /** The live feed's picked question (D-133). Present instead of `question`. */
  questionId?: string;
  subject?: AskSubject;
}

const SUBJECT_KINDS = new Set(['STOCK', 'FUND', 'INDEX']);

function validSubject(s: unknown): s is AskSubject {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.vendorId === 'string' &&
    o.vendorId.length > 0 &&
    typeof o.symbol === 'string' &&
    o.symbol.length > 0 &&
    typeof o.name === 'string' &&
    typeof o.type === 'string' &&
    SUBJECT_KINDS.has(o.type)
  );
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  const mode = modeFrom(request);
  const db = getDb(mode);

  /*
   * The answer has to be about the list you are looking at. Pinned to the first
   * list, "why is RELIANCE flagged?" asked from "Waiting for dips" would answer
   * about the long-term card of the same stock, which is a different thesis in
   * a different state. A confidently wrong answer is worse than a refusal, and
   * this whole product is an argument for that.
   */
  const active = resolveWatchlist(db, DEFAULT_USER_ID, body.watchlistId);
  if (!active) return NextResponse.json({ error: 'NO_WATCHLIST' }, { status: 404 });

  if (body.questionId !== undefined) {
    /*
     * Picked questions are the live feed's Ask (D-133). Refused in simulated
     * mode rather than quietly answered: the simulated panel is the typed one,
     * its chips and parser are part of the rehearsed demo, and a second entry
     * point into it would be a second thing to keep honest.
     */
    if (mode !== 'live') {
      return NextResponse.json({ error: 'ONLY_IN_LIVE_MODE' }, { status: 403 });
    }
    const question = QUESTIONS.find((q) => q.id === body.questionId);
    if (!question) return NextResponse.json({ error: 'UNKNOWN_QUESTION' }, { status: 400 });
    if (question.kinds.length > 0) {
      if (!validSubject(body.subject)) {
        return NextResponse.json({ error: 'MISSING_SUBJECT' }, { status: 400 });
      }
      if (!question.kinds.includes(body.subject.type)) {
        return NextResponse.json({ error: 'QUESTION_NOT_FOR_SUBJECT' }, { status: 400 });
      }
    }
    return NextResponse.json(
      await askCanned(db, active.id, DEFAULT_USER_ID, {
        questionId: question.id as QuestionId,
        subject: validSubject(body.subject) ? body.subject : undefined,
      }),
    );
  }

  if (!body.question || body.question.trim().length === 0) {
    return NextResponse.json({ error: 'MISSING_QUESTION' }, { status: 400 });
  }
  if (body.question.length > 500) {
    return NextResponse.json({ error: 'QUESTION_TOO_LONG' }, { status: 413 });
  }
  return NextResponse.json(ask(db, active.id, DEFAULT_USER_ID, body.question.trim()));
}
