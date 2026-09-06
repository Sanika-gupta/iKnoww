import { getDb } from '@/lib/db';
import { modeFrom, type FeedMode } from '@/lib/domain/mode';

export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events, not WebSockets.
 *
 * Data only travels one way here, server to browser. WebSockets buy
 * bidirectionality we do not need and cost a library, a handshake and our own
 * reconnection logic. SSE is plain HTTP: the browser reconnects on its own and
 * tells us the last event id it received, so the server can replay exactly what
 * was missed. We already store a sequence per card, so recovering from a dropped
 * connection came almost free.
 *
 * What this earns, concretely: a second device stays consistent without polling,
 * which is the one behaviour the tick loop being browser-driven could not
 * deliver on its own (D-085).
 *
 * The payload is a version key rather than the board itself. Pushing the whole
 * board down every stream would mean building it once per connected client per
 * change; telling clients "something moved" lets each fetch the one view it
 * actually needs, and keeps this endpoint cheap enough to hold open.
 */

const POLL_MS = 700;
const HEARTBEAT_MS = 20_000;

/**
 * Cheap fingerprint of everything a watchlist screen renders.
 *
 * `sim_now` is in the key, which it did not need to be while the only clock
 * moved with a price. A live refresh outside market hours writes a new time and
 * no new price, and without the clock in here no connected client would ever be
 * told the badge had changed.
 */
function versionKey(mode: FeedMode): string {
  const db = getDb(mode);
  const row = db
    .prepare(
      `SELECT
         (SELECT COALESCE(MAX(id), 0) FROM thesis_events) AS events,
         (SELECT COALESCE(MAX(id), 0) FROM alerts) AS alerts,
         (SELECT COALESCE(MAX(id), 0) FROM price_events) AS prices,
         (SELECT COALESCE(SUM(last_seen_seq), 0) FROM read_state) AS read,
         (SELECT COUNT(*) FROM watchlist_items WHERE removed_at IS NULL) AS items,
         (SELECT COALESCE(MAX(sim_now), 0) FROM sim_state) AS clock`,
    )
    .get() as Record<string, number>;
  return `${row.events}.${row.alerts}.${row.prices}.${row.read}.${row.items}.${row.clock}`;
}

export async function GET(request: Request) {
  // Read before the stream opens. The poll below runs in a closure that
  // outlives this function, and `request.url` must not be reached from there.
  const mode = modeFrom(request);
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let last = '';
      let closed = false;

      const send = (event: string, data: unknown, id?: string) => {
        if (closed) return;
        try {
          const idLine = id === undefined ? '' : `id: ${id}\n`;
          controller.enqueue(encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const stop = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away. Nothing to do.
        }
      };

      last = versionKey(mode);
      send('sync', { key: last });

      timer = setInterval(() => {
        if (closed) return;
        try {
          const key = versionKey(mode);
          if (key !== last) {
            last = key;
            send('changed', { key }, key);
          }
        } catch {
          stop();
        }
      }, POLL_MS);

      // Proxies and load balancers drop idle connections. A comment frame keeps
      // it alive without looking like an event to the client.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          stop();
        }
      }, HEARTBEAT_MS);

      request.signal.addEventListener('abort', stop);
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers by default, which would hold events until the buffer fills
      // and make a live stream look broken.
      'x-accel-buffering': 'no',
    },
  });
}
