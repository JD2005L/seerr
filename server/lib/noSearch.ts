// Show requests Seerr hands to Sonarr without searching.
//
// Levac TV asks for a show an episode at a time (James, 2026-11-07: "only download the first
// episode, and then have a button to download next episode"). Seerr requests whole seasons and,
// with automatic search on, has Sonarr search the whole series at once, which grabs season
// packs. A request made with `skipSearch` still goes to Sonarr, just without that search: the
// Media Pipeline then has Sonarr watch only the episodes asked for and searches for those.
// Every other request keeps automatic search.
//
// The flag lives on the entity while it's being created (the auto-approved path sends it to
// Sonarr inside the same save) and in a small table for an approval later on (Levac TV approves
// Kids' requests right after making them). A side table instead of a column keeps upstream
// migrations untouched, like media_fanout_intent.
import datasource from '@server/datasource';

let ensured = false;

// PostgreSQL wants $1, $2...; SQLite takes ?.
function sql(text: string): string {
  let n = 0;
  return datasource.options.type === 'postgres'
    ? text.replace(/\?/g, () => `$${++n}`)
    : text;
}

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await datasource.query(
    `create table if not exists media_request_nosearch
    (requestId integer primary key, createdAt timestamp default CURRENT_TIMESTAMP)`
  );
  ensured = true;
}

export async function rememberNoSearch(requestId: number): Promise<void> {
  if (!Number.isSafeInteger(requestId) || requestId <= 0) return;
  await ensureTable();
  await datasource.query(
    sql(
      'insert into media_request_nosearch (requestId) values (?) on conflict (requestId) do nothing'
    ),
    [requestId]
  );
}

export async function skipsSearch(entity: {
  id?: number;
  skipSearch?: boolean;
}): Promise<boolean> {
  if (entity.skipSearch === true) return true;
  if (!entity.id) return false;
  await ensureTable();
  const rows: unknown[] = await datasource.query(
    sql('select requestId from media_request_nosearch where requestId = ?'),
    [entity.id]
  );
  return rows.length > 0;
}
