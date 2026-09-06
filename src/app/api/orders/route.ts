import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { modeFrom } from '@/lib/domain/mode';
import { DEFAULT_USER_ID } from '@/lib/db/seed';
import { placeOrder, listOrders, type OrderError } from '@/lib/orders/service';
import { simNow } from '@/lib/sim/ticker';

export const dynamic = 'force-dynamic';

const STATUS: Record<OrderError, number> = {
  ITEM_NOT_FOUND: 404,
  ITEM_REMOVED: 409,
  NO_POSITION: 409,
  INSUFFICIENT_QUANTITY: 409,
  INVALID_QUANTITY: 422,
  INVALID_AMOUNT: 422,
  ACTION_NOT_AVAILABLE: 409,
  // Not an error so much as the product working: the user has to see the
  // conviction and say they want to proceed anyway.
  ACKNOWLEDGEMENT_REQUIRED: 428,
};

export async function GET(request: Request) {
  return NextResponse.json({
    orders: listOrders(getDb(modeFrom(request)), DEFAULT_USER_ID),
  });
}

export async function POST(request: Request) {
  let body: {
    itemId?: string;
    side?: 'BUY' | 'SELL';
    quantity?: number;
    amount?: number;
    acknowledgedLowConviction?: boolean;
    checkInQuestion?: string;
    checkInAnswer?: string;
    idempotencyKey?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  if (!body.itemId || !body.side || !body.idempotencyKey) {
    return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
  }

  const db = getDb(modeFrom(request));
  const result = placeOrder(db, {
    userId: DEFAULT_USER_ID,
    itemId: body.itemId,
    side: body.side,
    quantity: body.quantity,
    amount: body.amount,
    acknowledgedLowConviction: body.acknowledgedLowConviction,
    checkInQuestion: body.checkInQuestion,
    checkInAnswer: body.checkInAnswer,
    idempotencyKey: body.idempotencyKey,
    // The SIMULATED clock, not the wall clock. Everything else in the pipeline
    // runs on simulated time, and using real time here meant a judge opening the
    // app in the evening got "market closed" on every order while the simulated
    // session was mid-morning (D-088).
    now: simNow(db),
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, detail: result.detail ?? null },
      { status: STATUS[result.error] ?? 400 },
    );
  }

  return NextResponse.json(
    { order: result.order, replayed: result.replayed },
    { status: result.replayed ? 200 : 201 },
  );
}
