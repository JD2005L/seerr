// Levac fork: what a person can see is what's in the Plex libraries they have.
//
// Every person has their own Plex library pair (Movies-<Name>, TV-<Name>, folders
// /mnt/media/Library/<name>/...) and sees others' through Plex sharing. Seerr's
// Discover page used to show every library's recently added titles and every
// person's requests to everyone; for anyone who doesn't manage requests both
// are narrowed here to the libraries shared with them on Plex plus their own.
// A title that is somewhere else can still be added: on an available title the
// fan-out ("Add to My Library") links the existing files into theirs.
import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import {
  canManageFanout,
  currentOwner,
  normalizeOwner,
} from '@server/lib/fanout';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

export interface LibrarySection {
  key: string;
  owner: string;
}

/** One title in one section: what Plex says it is and when it arrived there. */
export interface LibraryEntry {
  section: string;
  type: MediaType;
  tmdbId?: number;
  tvdbId?: number;
  addedAt: number;
}

export interface LibraryIndex {
  sections: LibrarySection[];
  entries: LibraryEntry[];
}

/** Sections a person may see, and whose libraries those are. */
export interface LibraryAccess {
  sections: Set<string>;
  owners: Set<string>;
}

/** Shared sections per plex.tv user id; 'all' when every library is shared. */
export type SharedSections = Map<number, Set<string> | 'all'>;

const INDEX_SECONDS = 120;
const SHARED_SECONDS = 600;
const STALE_SECONDS = 24 * 3600;

/** "/mnt/media/Library/Kulpreet/Movies" or "/library/kulpreet/Movies" -> "kulpreet". */
export function ownerFromPath(path: string | null | undefined): string | null {
  const match = /\/library\/([^/]+)/i.exec((path ?? '').replace(/\\/g, '/'));
  return match ? normalizeOwner(match[1]) || null : null;
}

interface SharedServersXml {
  MediaContainer?: {
    SharedServer?: {
      $: { userID?: string; allLibraries?: string };
      Section?: { $: { key?: string; shared?: string } }[];
    }[];
  };
}

/** plex.tv /api/servers/<machine>/shared_servers, parsed by xml2js. */
export function sharedSectionsFrom(xml: SharedServersXml): SharedSections {
  const out: SharedSections = new Map();
  for (const server of xml.MediaContainer?.SharedServer ?? []) {
    const id = Number(server.$.userID);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (server.$.allLibraries === '1') {
      out.set(id, 'all');
      continue;
    }
    const keys = (server.Section ?? [])
      .filter((s) => s.$.shared === '1' && s.$.key)
      .map((s) => String(s.$.key));
    out.set(id, new Set(keys));
  }
  return out;
}

/**
 * null = sees everything (manages requests, or the server owner, user 1).
 * Otherwise the sections Plex shares with them plus their own library's.
 */
export function accessFor(
  user: User | undefined,
  index: LibraryIndex,
  shared: SharedSections | null
): LibraryAccess | null {
  if (user && (user.id === 1 || canManageFanout(user))) return null;
  const sections = new Set<string>();
  const self = currentOwner(user);
  for (const s of index.sections)
    if (self && s.owner === self) sections.add(s.key);
  const granted = user?.plexId ? shared?.get(user.plexId) : undefined;
  if (granted === 'all') for (const s of index.sections) sections.add(s.key);
  else if (granted) for (const key of granted) sections.add(key);
  const owners = new Set<string>();
  for (const s of index.sections) if (sections.has(s.key)) owners.add(s.owner);
  if (self) owners.add(self);
  return { sections, owners };
}

export function titleKeys(e: {
  type: MediaType;
  tmdbId?: number | null;
  tvdbId?: number | null;
}) {
  const keys: string[] = [];
  if (e.tmdbId) keys.push(`${e.type}:tmdb:${e.tmdbId}`);
  if (e.type === MediaType.TV && e.tvdbId)
    keys.push(`${e.type}:tvdb:${e.tvdbId}`);
  return keys;
}

/** Every title key (see titleKeys) for the titles in the sections a person can see. */
export function accessibleTitleKeys(
  index: LibraryIndex,
  access: LibraryAccess
): string[] {
  const keys = new Set<string>();
  for (const e of index.entries) {
    if (!access.sections.has(e.section)) continue;
    for (const k of titleKeys(e)) keys.add(k);
  }
  return [...keys];
}

/**
 * Titles in the person's sections, newest arrival first. A title in several of
 * them counts from its newest copy, so one added to their library shows up as
 * new even when another library they see had it before.
 */
export function rankRecentlyAdded(
  index: LibraryIndex,
  access: LibraryAccess,
  media: Media[]
): Media[] {
  const byKey = new Map<string, Media>();
  for (const m of media)
    for (const k of titleKeys({
      type: m.mediaType,
      tmdbId: m.tmdbId,
      tvdbId: m.tvdbId,
    }))
      byKey.set(k, m);
  const newest = new Map<number, { media: Media; addedAt: number }>();
  for (const e of index.entries) {
    if (!access.sections.has(e.section)) continue;
    const m = titleKeys(e)
      .map((k) => byKey.get(k))
      .find(Boolean);
    if (!m) continue;
    const seen = newest.get(m.id);
    if (!seen || e.addedAt > seen.addedAt)
      newest.set(m.id, { media: m, addedAt: e.addedAt });
  }
  return [...newest.values()]
    .sort((a, b) => b.addedAt - a.addedAt || b.media.id - a.media.id)
    .map((v) => v.media);
}

/** Requests whose library is one they can see, by the request's root folder. */
export function requestOwnerPatterns(owners: Iterable<string>): string[] {
  const out: string[] = [];
  for (const owner of owners) {
    if (!/^[a-z0-9-]+$/.test(owner)) continue;
    out.push(`/library/${owner}`, `/library/${owner}/%`);
  }
  return out;
}

// ---------------------------------------------------------------- sources

function guidId(guids: { id: string }[] | undefined, scheme: string) {
  const hit = guids?.find((g) => g.id.startsWith(`${scheme}://`));
  const id = hit ? Number(hit.id.slice(scheme.length + 3)) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function adminToken(): Promise<string | null> {
  const admin = await getRepository(User).findOne({
    select: { id: true, plexToken: true },
    where: { id: 1 },
  });
  return admin?.plexToken ?? null;
}

async function loadIndex(): Promise<LibraryIndex> {
  const token = await adminToken();
  if (!token) throw new Error('no admin Plex token');
  const plex = new PlexAPI({ plexToken: token });
  const sections: LibrarySection[] = [];
  const entries: LibraryEntry[] = [];
  for (const lib of await plex.getLibraries()) {
    if (lib.type !== 'movie' && lib.type !== 'show') continue;
    const owner = (lib.Location ?? [])
      .map((l) => ownerFromPath(l.path))
      .find(Boolean);
    if (!owner) continue;
    sections.push({ key: String(lib.key), owner });
    const type = lib.type === 'movie' ? MediaType.MOVIE : MediaType.TV;
    for (let offset = 0; ; offset += 500) {
      const page = await plex.getLibraryContents(String(lib.key), {
        offset,
        size: 500,
      });
      for (const item of page.items) {
        entries.push({
          section: String(lib.key),
          type,
          tmdbId: guidId(item.Guid, 'tmdb'),
          tvdbId: guidId(item.Guid, 'tvdb'),
          addedAt: item.addedAt ?? 0,
        });
      }
      // Plex leaves totalSize out at times: a short page is the last one.
      if (page.items.length < 500) break;
      if (page.totalSize && offset + page.items.length >= page.totalSize) break;
    }
  }
  return { sections, entries };
}

async function loadShared(): Promise<SharedSections> {
  const token = await adminToken();
  const machineId = getSettings().plex.machineId;
  if (!token || !machineId) throw new Error('Plex is not configured');
  return sharedSectionsFrom(
    (await new PlexTvAPI(token).getSharedServers(machineId)) as SharedServersXml
  );
}

/** Swappable in tests. */
export const librarySources = { loadIndex, loadShared };

interface Cached<T> {
  value: T;
  at: number;
}
let indexCache: Cached<LibraryIndex> | null = null;
let sharedCache: Cached<SharedSections> | null = null;
let indexLoading: Promise<LibraryIndex> | null = null;
let sharedLoading: Promise<SharedSections> | null = null;

export function resetLibraryAccessCache(): void {
  indexCache = sharedCache = null;
  indexLoading = sharedLoading = null;
}

async function cached<T>(
  get: () => Cached<T> | null,
  set: (c: Cached<T>) => void,
  loading: () => Promise<T> | null,
  setLoading: (p: Promise<T> | null) => void,
  load: () => Promise<T>,
  ttl: number,
  label: string
): Promise<T | null> {
  const now = Date.now() / 1000;
  const current = get();
  if (current && now - current.at < ttl) return current.value;
  let pending = loading();
  if (!pending) {
    pending = load()
      .then((value) => {
        set({ value, at: Date.now() / 1000 });
        return value;
      })
      .finally(() => setLoading(null));
    setLoading(pending);
  }
  const usable =
    current && now - current.at < STALE_SECONDS ? current.value : null;
  if (usable) {
    // Serve the last copy while it refreshes; a failed refresh is logged and retried next time.
    pending.catch((e) =>
      logger.warn(`Library access: could not read ${label}: ${e.message}`, {
        label: 'Library Access',
      })
    );
    return usable;
  }
  try {
    return await pending;
  } catch (e) {
    logger.warn(`Library access: could not read ${label}: ${e.message}`, {
      label: 'Library Access',
    });
    return null;
  }
}

export async function libraryIndex(): Promise<LibraryIndex | null> {
  return cached(
    () => indexCache,
    (c) => (indexCache = c),
    () => indexLoading,
    (p) => (indexLoading = p),
    () => librarySources.loadIndex(),
    INDEX_SECONDS,
    'the Plex libraries'
  );
}

export async function sharedSections(): Promise<SharedSections | null> {
  return cached(
    () => sharedCache,
    (c) => (sharedCache = c),
    () => sharedLoading,
    (p) => (sharedLoading = p),
    () => librarySources.loadShared(),
    SHARED_SECONDS,
    'Plex sharing'
  );
}

/**
 * null = no limit. Without the libraries a person only sees their own requests
 * and no recently added titles, rather than everyone's.
 */
export async function libraryAccess(
  user: User | undefined
): Promise<LibraryAccess | null> {
  if (user && (user.id === 1 || canManageFanout(user))) return null;
  const [index, shared] = await Promise.all([libraryIndex(), sharedSections()]);
  return accessFor(user, index ?? { sections: [], entries: [] }, shared);
}

/** "Recently Added" for someone limited to their libraries. */
export async function recentlyAddedFor(
  access: LibraryAccess,
  take: number,
  skip: number
): Promise<{ total: number; results: Media[] }> {
  const index = await libraryIndex();
  if (!index || !access.sections.size) return { total: 0, results: [] };
  const wanted = index.entries.filter((e) => access.sections.has(e.section));
  const movieIds = [
    ...new Set(
      wanted
        .filter((e) => e.type === MediaType.MOVIE && e.tmdbId)
        .map((e) => e.tmdbId as number)
    ),
  ];
  const tvTmdb = [
    ...new Set(
      wanted
        .filter((e) => e.type === MediaType.TV && e.tmdbId)
        .map((e) => e.tmdbId as number)
    ),
  ];
  const tvTvdb = [
    ...new Set(
      wanted
        .filter((e) => e.type === MediaType.TV && e.tvdbId)
        .map((e) => e.tvdbId as number)
    ),
  ];
  const repo = getRepository(Media);
  const media: Media[] = [];
  const chunk = <T>(list: T[]) => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += 400) out.push(list.slice(i, i + 400));
    return out;
  };
  for (const ids of chunk(movieIds))
    media.push(
      ...(await repo.find({
        where: { mediaType: MediaType.MOVIE, tmdbId: In(ids) },
      }))
    );
  for (const ids of chunk(tvTmdb))
    media.push(
      ...(await repo.find({
        where: { mediaType: MediaType.TV, tmdbId: In(ids) },
      }))
    );
  for (const ids of chunk(tvTvdb))
    media.push(
      ...(await repo.find({
        where: { mediaType: MediaType.TV, tvdbId: In(ids) },
      }))
    );
  const ranked = rankRecentlyAdded(index, access, media);
  return { total: ranked.length, results: ranked.slice(skip, skip + take) };
}
