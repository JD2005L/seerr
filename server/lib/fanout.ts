import { MediaStatus, MediaType } from '@server/constants/media';
import datasource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import type { MediaRequestBody } from '@server/interfaces/api/requestInterfaces';
import { Permission } from '@server/lib/permissions';

export function normalizeOwner(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function canManageFanout(user?: User): boolean {
  return !!user?.hasPermission(
    [Permission.ADMIN, Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
    { type: 'or' }
  );
}

export class FanoutError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function parseMediaType(value: unknown): MediaType {
  if (value === 'movie') return MediaType.MOVIE;
  if (value === 'tv' || value === 'show') return MediaType.TV;
  throw new FanoutError(400, 'mediaType must be movie or tv.');
}

export function parseMediaId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new FanoutError(400, 'Invalid media ID.');
  return id;
}

export function currentOwner(user?: User): string {
  return user
    ? normalizeOwner(user.username || user.email || String(user.id))
    : '';
}

export async function resolveOwner(
  user: User | undefined,
  requested?: string
): Promise<string> {
  const self = currentOwner(user);
  if (!self) throw new FanoutError(401, 'You must be logged in.');
  if (!requested || normalizeOwner(requested) === self) return self;
  if (!canManageFanout(user))
    throw new FanoutError(
      403,
      'You do not have permission to manage another library.'
    );
  const target = normalizeOwner(requested);
  const users = await getRepository(User).find();
  if (!users.some((u) => currentOwner(u) === target))
    throw new FanoutError(404, 'Fan-out owner not found.');
  return target;
}

// Existing live SQLite schema and the legacy UI ID migration are intentional.
export async function ensureFanoutTable(): Promise<void> {
  await datasource.query(`create table if not exists media_fanout_intent
    (id integer primary key autoincrement, requestId integer not null, mediaId integer,
    mediaType text not null, app text not null, externalServiceId integer,
    tmdbId integer, tvdbId integer, owner text not null, source text not null,
    status text not null default 'pending', lastError text, fulfilledAt datetime,
    createdAt datetime default CURRENT_TIMESTAMP, updatedAt datetime default CURRENT_TIMESTAMP,
    unique(requestId, owner))`);
  await datasource.query(`update or ignore media_fanout_intent set requestId = requestId + 100000000
    where source = 'seerr-ui' and requestId > 0 and requestId < 100000000`);
  await datasource.query(`delete from media_fanout_intent
    where source = 'seerr-ui' and requestId > 0 and requestId < 100000000`);
}

async function mediaFor(
  type: MediaType,
  tmdbId: number | null,
  tvdbId: number | null
) {
  const repo = getRepository(Media);
  if (tmdbId) {
    const media = await repo.findOne({ where: { mediaType: type, tmdbId } });
    if (media) return media;
  }
  return tvdbId ? repo.findOne({ where: { mediaType: type, tvdbId } }) : null;
}

type FanoutRow = {
  id: number;
  owner: string;
  status: string;
  lastError: string | null;
};

async function context(
  type: MediaType,
  tmdbId: number | null,
  tvdbId: number | null
) {
  if (!tmdbId && !tvdbId)
    throw new FanoutError(400, 'tmdbId or tvdbId is required.');
  await ensureFanoutTable();
  const media = await mediaFor(type, tmdbId, tvdbId);
  return {
    media,
    tmdbId: tmdbId ?? media?.tmdbId ?? null,
    tvdbId: tvdbId ?? media?.tvdbId ?? null,
  };
}

async function rowsFor(
  type: MediaType,
  ids: { tmdbId: number | null; tvdbId: number | null },
  owner?: string
): Promise<FanoutRow[]> {
  return datasource.query(
    `select id, owner, status, lastError from media_fanout_intent
    where mediaType = ? and ((? is not null and tmdbId = ?) or (? is not null and tvdbId = ?))
    ${owner ? 'and owner = ?' : ''} order by updatedAt asc, id asc`,
    [
      type,
      ids.tmdbId,
      ids.tmdbId,
      ids.tvdbId,
      ids.tvdbId,
      ...(owner ? [owner] : []),
    ]
  );
}

export async function fanoutStatus(
  user: User | undefined,
  owner: string | undefined,
  type: MediaType,
  tmdbId: number | null,
  tvdbId: number | null
) {
  const resolved = await resolveOwner(user, owner);
  const ids = await context(type, tmdbId, tvdbId);
  const rows = await rowsFor(type, ids, resolved);
  const latest = rows.at(-1);
  return {
    owner: resolved,
    status: latest?.status ?? 'missing',
    lastError: latest?.lastError ?? null,
    globallyAvailable: ids.media?.status === MediaStatus.AVAILABLE,
    mediaId: ids.media?.id ?? null,
    removable:
      latest?.status === 'fulfilled' || latest?.status === 'remove_pending',
  };
}

export async function fanoutOwners(
  user: User | undefined,
  type?: MediaType,
  tmdbId?: number | null,
  tvdbId?: number | null
) {
  if (!canManageFanout(user))
    throw new FanoutError(
      403,
      'You do not have permission to list fan-out owners.'
    );
  const users = await getRepository(User).find();
  const owners = users
    .map((u) => ({
      id: u.id,
      owner: currentOwner(u),
      displayName: u.displayName || u.username || u.email || String(u.id),
    }))
    .filter((u) => u.owner);
  if (!type || (!tmdbId && !tvdbId)) return owners;
  const ids = await context(type, tmdbId ?? null, tvdbId ?? null);
  const rows = await rowsFor(type, ids);
  const byOwner = new Map(rows.map((row) => [row.owner, row]));
  return owners.map((u) => ({
    ...u,
    status: byOwner.get(u.owner)?.status ?? 'missing',
    lastError: byOwner.get(u.owner)?.lastError ?? null,
  }));
}

export async function toggleFanout(
  user: User | undefined,
  requested: string | undefined,
  type: MediaType,
  tmdbId: number | null,
  tvdbId: number | null
) {
  const owner = await resolveOwner(user, requested);
  const ids = await context(type, tmdbId, tvdbId);
  const rows = await rowsFor(type, ids, owner);
  const latest = rows.at(-1)?.status;
  const status =
    latest === 'remove_pending'
      ? 'fulfilled'
      : latest === 'fulfilled'
        ? 'remove_pending'
        : 'pending';
  const requestId = ids.media?.id
    ? 100000000 + ids.media.id
    : -(ids.tmdbId ?? ids.tvdbId ?? 0);
  if (rows.length) {
    await datasource.query(
      `update media_fanout_intent set status = ?, lastError = NULL,
      mediaId = coalesce(mediaId, ?), externalServiceId = coalesce(externalServiceId, ?),
      updatedAt = CURRENT_TIMESTAMP where id in (${rows.map((r) => Number(r.id)).join(',')})`,
      [status, ids.media?.id ?? null, ids.media?.externalServiceId ?? null]
    );
  } else {
    await datasource.query(
      `insert into media_fanout_intent
      (requestId,mediaId,mediaType,app,externalServiceId,tmdbId,tvdbId,owner,source,status,lastError,updatedAt)
      values(?,?,?,?,?,?,?,?,?,?,NULL,CURRENT_TIMESTAMP)
      on conflict(requestId, owner) do update set mediaId=excluded.mediaId, mediaType=excluded.mediaType,
      app=excluded.app, externalServiceId=excluded.externalServiceId, tmdbId=excluded.tmdbId,
      tvdbId=excluded.tvdbId, source=excluded.source, status=excluded.status,
      lastError=NULL, updatedAt=CURRENT_TIMESTAMP`,
      [
        requestId,
        ids.media?.id ?? null,
        type,
        type === MediaType.TV ? 'sonarr' : 'radarr',
        ids.media?.externalServiceId ?? null,
        ids.tmdbId,
        ids.tvdbId,
        owner,
        'seerr-ui',
        status,
      ]
    );
  }
  return {
    owner,
    status,
    mediaId: ids.media?.id ?? null,
    requestId,
    action:
      status === 'remove_pending'
        ? 'remove'
        : status === 'fulfilled'
          ? 'cancel-remove'
          : 'add',
  };
}

export async function destinationFor(userId: number, type: MediaType) {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new FanoutError(400, 'Invalid userId.');
  const user = await getRepository(User).findOne({ where: { id: userId } });
  if (!user) throw new FanoutError(404, 'User not found.');
  const rules = await getRepository(OverrideRule).find({
    order: { id: 'ASC' },
  });
  const rule = rules.find(
    (r) =>
      (type === MediaType.TV ? r.sonarrServiceId : r.radarrServiceId) != null &&
      r.users?.split(',').some((id) => Number(id.trim()) === userId) &&
      !r.genre?.trim() &&
      !r.language?.trim() &&
      !r.keywords?.trim()
  );
  if (!rule) return null;
  return {
    serverId:
      type === MediaType.TV ? rule.sonarrServiceId : rule.radarrServiceId,
    profileId: rule.profileId ?? null,
    rootFolder: rule.rootFolder || null,
    tags: (rule.tags ?? '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v > 0),
  };
}

// The selected Request As user is authoritative; do not trust posted Arr fields.
export async function applyDestination(body: MediaRequestBody) {
  if (!body.userId) return body;
  const destination = await destinationFor(
    body.userId,
    parseMediaType(body.mediaType)
  );
  if (!destination) return body;
  return {
    ...body,
    serverId: destination.serverId ?? body.serverId,
    profileId: body.profileId ?? destination.profileId ?? undefined,
    rootFolder: destination.rootFolder ?? body.rootFolder,
    tags: destination.tags,
  };
}
