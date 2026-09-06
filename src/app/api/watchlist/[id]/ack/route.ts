import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { acknowledge } from '@/lib/engine/states';

export const dynamic = 'force-dynamic';

/**
 * The user has read the conviction and decided anyway.
 *
 * From review this makes the card actionable; from an unexplained move it means
 * "noted". Either way it is the user speaking, and the event says so rather than
 * pretending the market changed.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = acknowledge(getDb(modeFrom(request)), id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === 'NOT_FOUND' ? 404 : 409 },
    );
  }
  return NextResponse.json({ transition: result.transition });
}
