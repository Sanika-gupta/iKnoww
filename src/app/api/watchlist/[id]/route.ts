import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { editThesis, removeItem } from '@/lib/watchlist/items';
import type { ThesisType } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Editing takes the version the client last saw. A mismatch is a 409 carrying
 * the server's value, so two tabs cannot silently overwrite each other.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const db = getDb(modeFrom(request));

  let body: { thesisType?: string; threshold?: number; version?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }
  if (!body.thesisType) return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });

  const result = editThesis(db, {
    itemId: id,
    thesisType: body.thesisType as ThesisType,
    params: body.threshold === undefined ? {} : { threshold: Number(body.threshold) },
    version: body.version,
  });

  if (!result.ok) {
    const status =
      result.error === 'NOT_FOUND' ? 404 : result.error === 'VERSION_CONFLICT' ? 409 : 422;
    return NextResponse.json(
      { error: result.error, currentVersion: result.currentVersion ?? null },
      { status },
    );
  }
  return NextResponse.json({ item: result.item });
}

/** Soft remove. Orders and history survive; alerting stops immediately. */
export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const result = removeItem(getDb(modeFrom(request)), id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'NOT_FOUND' ? 404 : 409 });
  }
  return NextResponse.json({ item: result.item });
}
