import { getDb } from '@/lib/db';
import { DEFAULT_USER_ID, DEFAULT_WATCHLIST_ID } from '@/lib/db/seed';
import { buildBoard, buildInstruments } from '@/lib/api/board';
import { resolveWatchlist } from '@/lib/watchlist/lists';
import { isFeedMode, type FeedMode } from '@/lib/domain/mode';
import Board from './Board';

export const dynamic = 'force-dynamic';

/**
 * Rendered on the server with the board already built, so the first paint is
 * the real watchlist rather than a spinner. The client takes over from there.
 *
 * `?mode=live` selects the live feed. It is a URL parameter rather than
 * component state so that the mode survives a reload and can be linked to,
 * and so the server renders the right board on the first paint instead of
 * flashing the simulated one first.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.mode) ? params.mode[0] : params.mode;
  const mode: FeedMode = isFeedMode(raw) ? raw : 'sim';

  const db = getDb(mode);
  const active = resolveWatchlist(db, DEFAULT_USER_ID)?.id ?? DEFAULT_WATCHLIST_ID;
  /*
   * `key={mode}` remounts the board when the mode changes, and it is load-bearing.
   *
   * Both modes are the same App Router segment, so navigating between them
   * reuses the component instance and `useState(initial)` keeps whatever the
   * previous mode had rendered. Switching from live back to simulated left real
   * NSE prices on screen underneath the "Simulated data" label and a footer
   * saying the prices were generated -- the app misdescribing its own data,
   * which is the one thing it may never do. The SSE subscription stayed pinned
   * to the old mode for the same reason.
   */
  return (
    <Board
      key={mode}
      mode={mode}
      initial={buildBoard(db, active)}
      initialInstruments={buildInstruments(db, DEFAULT_USER_ID, active)}
    />
  );
}
