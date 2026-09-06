import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { markRead } from '@/lib/watchlist/read';

export const dynamic = 'force-dynamic';

/**
 * Marks a card seen up to the sequence the client actually rendered.
 *
 * The client sends what it saw rather than the server assuming "everything up
 * to now", which is what stops a second device with a staler view from
 * swallowing events it never showed anyone. The merge is `max`, so a duplicate
 * post, an out-of-order post and two devices posting at once all converge.
 *
 * This is called when a card is OPENED, never when the list renders. Glancing at
 * the top of a list is not reading it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  let body: { seq?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }
  if (typeof body.seq !== 'number' || !Number.isFinite(body.seq)) {
    return NextResponse.json({ error: 'MISSING_SEQ' }, { status: 400 });
  }

  const db = getDb(modeFrom(request));
  const exists = db.prepare('SELECT 1 FROM watchlist_items WHERE id = ?').get(id);
  if (!exists) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

  return NextResponse.json(markRead(db, id, body.seq));
}
