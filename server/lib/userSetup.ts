// Levac fork: set a new person up automatically.
//
// Adding someone used to need manual steps: their Plex libraries enabled in
// Seerr, one Radarr and one Sonarr override rule sending their requests to
// their own library, and a username equal to their library owner (a first
// Plex sign-in has none, so the owner would come from the email and "Add to My
// Library" would not find their library). This runs on startup, every 15
// minutes and after a Plex sign-in creates or links a user. It only adds:
// it never disables a library, edits a rule or changes permissions. A person
// it cannot finish (no library of their own, several candidates, a missing
// root folder, a username set to something else) is reported to PVIBot as
// needs_james, once per outcome, so a person can fix it.
import PlexAPI from '@server/api/plexapi';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { UserType } from '@server/constants/user';
import datasource, { getRepository } from '@server/datasource';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import {
  currentOwner,
  fanoutParameters,
  normalizeOwner,
} from '@server/lib/fanout';
import { sendLevacEvent, type LevacEvent } from '@server/lib/levacEvents';
import {
  libraryIndex,
  ownerFromPath,
  sharedSections,
  type LibraryIndex,
  type SharedSections,
} from '@server/lib/libraryAccess';
import { plexFullScanner } from '@server/lib/scanners/plex';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import logger from '@server/logger';

const LABEL = 'User Setup';
const START_DELAY_MS = 30 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

type Servarr = {
  getRootFolders(): Promise<{ path: string }[]>;
  getTags(): Promise<{ id: number; label: string }[]>;
  createTag(options: { label: string }): Promise<{ id: number; label: string }>;
};

/** Swappable in tests. */
export const userSetupSources = {
  radarr: (server: RadarrSettings): Servarr =>
    new RadarrAPI({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    }),
  sonarr: (server: SonarrSettings): Servarr =>
    new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    }),
  syncLibraries: async (): Promise<void> => {
    const admin = await getRepository(User).findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    await new PlexAPI({ plexToken: admin.plexToken }).syncLibraries();
  },
  startScan: (): void => {
    plexFullScanner.run();
  },
  send: (event: LevacEvent, deliveryId: string) =>
    sendLevacEvent(event, deliveryId),
};

export type SetupOutcome = 'set_up' | 'needs_james';

type Result = {
  outcome: SetupOutcome;
  owner: string;
  summary: string;
  details: string[];
};

// ---------------------------------------------------------------- notices

async function query(sql: string, parameters: unknown[] = []) {
  return datasource.query(
    fanoutParameters(sql, datasource.options.type),
    parameters
  );
}

// What PVIBot was told about each person, so a restart does not tell it again.
// Created like media_fanout_help: plain SQL that works on SQLite and Postgres.
export async function ensureSetupNoticeTable(): Promise<void> {
  await query(`create table if not exists user_setup_notice
    (user_id integer primary key, outcome text not null,
    sent integer not null default 0, payload text not null,
    updated_at timestamp default CURRENT_TIMESTAMP)`);
}

type NoticeRow = {
  user_id: number;
  outcome: string;
  sent: number;
  payload: string;
};

async function noticeFor(userId: number): Promise<NoticeRow | undefined> {
  const rows: NoticeRow[] = await query(
    `select user_id, outcome, sent, payload from user_setup_notice where user_id = ?`,
    [userId]
  );
  return rows[0];
}

async function deliver(row: NoticeRow): Promise<void> {
  const event = JSON.parse(row.payload) as LevacEvent;
  const result = await userSetupSources.send(
    event,
    `seerr-user-setup-${row.user_id}-${row.outcome}-${Date.now()}`
  );
  if (result.sent)
    await query(
      `update user_setup_notice set sent = 1, updated_at = CURRENT_TIMESTAMP where user_id = ?`,
      [row.user_id]
    );
}

// One message per person per outcome. A message that could not be sent is kept
// and tried again on the next run.
async function notify(user: User, result: Result): Promise<void> {
  const event: LevacEvent = {
    event_type: 'seerr_user_setup',
    outcome: result.outcome,
    user_id: user.id,
    user_name: nameOf(user),
    plex_username: user.plexUsername ?? '',
    owner: result.owner,
    summary: result.summary,
    details: result.details.join('\n'),
  };
  const row = await noticeFor(user.id);
  if (row && row.outcome === result.outcome) {
    if (!row.sent) await deliver(row);
    return;
  }
  const next = {
    user_id: user.id,
    outcome: result.outcome,
    sent: 0,
    payload: JSON.stringify(event),
  };
  if (row)
    await query(
      `update user_setup_notice set outcome = ?, sent = 0, payload = ?,
      updated_at = CURRENT_TIMESTAMP where user_id = ?`,
      [next.outcome, next.payload, user.id]
    );
  else
    await query(
      `insert into user_setup_notice (user_id, outcome, sent, payload) values (?, ?, 0, ?)`,
      [user.id, next.outcome, next.payload]
    );
  await deliver(next);
}

async function retryUnsent(): Promise<void> {
  const rows: NoticeRow[] = await query(
    `select user_id, outcome, sent, payload from user_setup_notice where sent = 0`
  );
  for (const row of rows) await deliver(row);
}

// ---------------------------------------------------------------- libraries

/** Enable every per-person Plex library in Seerr's list. Returns how many it newly enabled. */
export async function enableLibraries(index: LibraryIndex): Promise<number> {
  const settings = getSettings();
  const missing = index.sections.some(
    (s) => !settings.plex.libraries.some((l) => l.id === s.key)
  );
  if (missing) await userSetupSources.syncLibraries();
  let enabled = 0;
  for (const section of index.sections) {
    const library = settings.plex.libraries.find((l) => l.id === section.key);
    if (library && !library.enabled) {
      library.enabled = true;
      enabled++;
    }
  }
  if (enabled) {
    await settings.save();
    userSetupSources.startScan();
    logger.info(`Enabled ${enabled} Plex librar(ies) for new people`, {
      label: LABEL,
    });
  }
  return enabled;
}

// ---------------------------------------------------------------- people

function nameOf(user: User): string {
  const name =
    user.displayName || user.username || user.plexUsername || user.email || '';
  return name.includes('@') ? name.split('@')[0] : name;
}

function ruleUserIds(rule: OverrideRule): number[] {
  return (rule.users ?? '')
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id));
}

/** Names a person goes by, normalized: "kulpreetsingh786", "kulpreet-singh". */
function nameKeys(user: User): string[] {
  return [
    user.plexUsername,
    user.displayName,
    user.username,
    user.email?.split('@')[0],
  ]
    .map((n) => normalizeOwner(n ?? ''))
    .filter(Boolean);
}

type Pick = { owner?: string; candidates: string[]; sharedAll?: boolean };

function pickOwner(
  user: User,
  libraryOwners: Set<string>,
  claimed: Set<string>,
  index: LibraryIndex,
  shared: SharedSections | null
): Pick {
  const self = currentOwner(user);
  if (self && libraryOwners.has(self)) return { owner: self, candidates: [] };
  const granted = user.plexId ? shared?.get(user.plexId) : undefined;
  if (granted === 'all') return { candidates: [], sharedAll: true };
  const candidates = [
    ...new Set(
      index.sections
        .filter((s) => granted?.has(s.key))
        .map((s) => s.owner)
        .filter((o) => !claimed.has(o))
    ),
  ];
  const names = nameKeys(user);
  const exact = candidates.filter((c) => names.includes(c));
  if (exact.length === 1) return { owner: exact[0], candidates };
  const prefix = candidates.filter(
    (c) => c.length >= 3 && names.some((n) => n.startsWith(c))
  );
  if (!exact.length && prefix.length) {
    const longest = Math.max(...prefix.map((c) => c.length));
    const best = prefix.filter((c) => c.length === longest);
    if (best.length === 1) return { owner: best[0], candidates };
  }
  if (candidates.length === 1) return { owner: candidates[0], candidates };
  return { candidates };
}

function folderFor(
  folders: { path: string }[],
  owner: string,
  kind: RegExp
): string | undefined {
  return folders
    .map((f) => f.path)
    .find((p) => ownerFromPath(p) === owner && kind.test(p));
}

async function tagFor(api: Servarr, owner: string): Promise<number> {
  const tags = await api.getTags();
  const found = tags.find((t) => normalizeOwner(t.label) === owner);
  return found ? found.id : (await api.createTag({ label: owner })).id;
}

function libraryNames(index: LibraryIndex, owner: string): string {
  const settings = getSettings();
  const names = index.sections
    .filter((s) => s.owner === owner)
    .map(
      (s) => settings.plex.libraries.find((l) => l.id === s.key)?.name ?? null
    )
    .filter((n): n is string => !!n);
  return names.length ? names.join(' and ') : `the ${owner} libraries`;
}

async function setUpPerson(
  user: User,
  owner: string,
  index: LibraryIndex
): Promise<Result> {
  const name = nameOf(user);
  const settings = getSettings();
  const radarrServer = settings.radarr.find((s) => s.isDefault && !s.is4k);
  const sonarrServer = settings.sonarr.find((s) => s.isDefault && !s.is4k);
  const needs = (summary: string, details: string[]): Result => ({
    outcome: 'needs_james',
    owner,
    summary,
    details,
  });
  if (user.username && normalizeOwner(user.username) !== owner)
    return needs(
      `${name} signed in to Seerr, but their username is set to "${user.username}", which is not their library owner "${owner}", so I left them alone.`,
      [
        `Plex shares the ${owner} library with them.`,
        `Set their Seerr username to "${owner}" and I will add their override rules.`,
      ]
    );
  if (!radarrServer || !sonarrServer)
    return needs(
      `${name} signed in to Seerr, but there is no default Radarr or Sonarr server to send their requests to.`,
      ['Mark one non-4K Radarr and one non-4K Sonarr server as default.']
    );
  const radarr = userSetupSources.radarr(radarrServer);
  const sonarr = userSetupSources.sonarr(sonarrServer);
  const movies = folderFor(
    await radarr.getRootFolders(),
    owner,
    /\/movies\/?$/i
  );
  const shows = folderFor(
    await sonarr.getRootFolders(),
    owner,
    /\/tv shows\/?$/i
  );
  if (!movies || !shows) {
    const missing = [!movies && 'Radarr', !shows && 'Sonarr'].filter(Boolean);
    return needs(
      `${name} signed in to Seerr, but ${missing.join(' and ')} has no root folder for their library, so their requests would go to James's library.`,
      [
        `Owner: ${owner}.`,
        !movies ? `Radarr is missing /library/${owner}/Movies.` : '',
        !shows ? `Sonarr is missing /library/${owner}/TV Shows.` : '',
      ].filter(Boolean)
    );
  }
  const radarrTag = await tagFor(radarr, owner);
  const sonarrTag = await tagFor(sonarr, owner);
  const added: string[] = [];
  if (!user.username) {
    await getRepository(User).update({ id: user.id }, { username: owner });
    user.username = owner;
    added.push(`Set their Seerr username to "${owner}".`);
  }
  // Same fields the upstream override rule route saves.
  await getRepository(OverrideRule).save([
    new OverrideRule({
      users: String(user.id),
      radarrServiceId: radarrServer.id,
      profileId: radarrServer.activeProfileId,
      rootFolder: movies,
      tags: String(radarrTag),
    }),
    new OverrideRule({
      users: String(user.id),
      sonarrServiceId: sonarrServer.id,
      profileId: sonarrServer.activeProfileId,
      rootFolder: shows,
      tags: String(sonarrTag),
    }),
  ]);
  added.push(
    `Radarr rule: ${movies} (profile ${radarrServer.activeProfileId}, tag ${radarrTag}).`,
    `Sonarr rule: ${shows} (profile ${sonarrServer.activeProfileId}, tag ${sonarrTag}).`
  );
  return {
    outcome: 'set_up',
    owner,
    summary: `${name} signed in to Seerr; their requests now go to ${libraryNames(index, owner)}.`,
    details: added,
  };
}

function noLibrary(user: User, pick: Pick): Result {
  const name = nameOf(user);
  if (pick.sharedAll)
    return {
      outcome: 'needs_james',
      owner: '',
      summary: `${name} signed in to Seerr, but Plex shares every library with them, so I cannot tell which is theirs.`,
      details: ["Their requests would go to James's library."],
    };
  if (!pick.candidates.length)
    return {
      outcome: 'needs_james',
      owner: '',
      summary: `${name} signed in to Seerr, but Plex shares no library of their own with them yet, so their requests would go to James's library.`,
      details: [
        'No per-person library is shared with them that another person does not already have.',
        'Create their libraries (Movies-<Name>, TV-<Name>) and share them in Plex.',
      ],
    };
  return {
    outcome: 'needs_james',
    owner: '',
    summary: `${name} signed in to Seerr, but Plex shares more than one library with them and I cannot tell which is theirs.`,
    details: [`Candidates: ${pick.candidates.join(', ')}.`],
  };
}

export async function setUpPeople(index: LibraryIndex): Promise<void> {
  const users = await getRepository(User).find();
  const rules = await getRepository(OverrideRule).find();
  const ruled = new Set(rules.flatMap(ruleUserIds));
  const libraryOwners = new Set(index.sections.map((s) => s.owner));
  const shared = await sharedSections();
  for (const user of users) {
    if (user.id === 1 || user.userType !== UserType.PLEX || ruled.has(user.id))
      continue;
    try {
      const claimed = new Set<string>();
      for (const other of users) {
        if (other.id === user.id) continue;
        const own = currentOwner(other);
        if (own) claimed.add(own);
        for (const rule of rules)
          if (ruleUserIds(rule).includes(other.id)) {
            const o = ownerFromPath(rule.rootFolder);
            if (o) claimed.add(o);
          }
      }
      const pick = pickOwner(user, libraryOwners, claimed, index, shared);
      const result = pick.owner
        ? await setUpPerson(user, pick.owner, index)
        : noLibrary(user, pick);
      await notify(user, result);
    } catch (e) {
      logger.warn(`Could not set up user ${user.id}: ${e.message}`, {
        label: LABEL,
      });
    }
  }
}

// ---------------------------------------------------------------- runner

let running = false;
let again = false;

/** One run at a time; a request that arrives during a run triggers one more. Never throws. */
export async function runUserSetup(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      try {
        await ensureSetupNoticeTable();
        const index = await libraryIndex();
        if (index) {
          await enableLibraries(index);
          await retryUnsent();
          await setUpPeople(index);
        }
      } catch (e) {
        logger.warn(`User setup run failed: ${e.message}`, { label: LABEL });
      }
    } while (again);
  } finally {
    running = false;
  }
}

/** For sign-in: starts a run without waiting for it. */
export function triggerUserSetup(): void {
  void runUserSetup();
}

export function startUserSetup(): void {
  setTimeout(() => void runUserSetup(), START_DELAY_MS).unref();
  setInterval(() => void runUserSetup(), INTERVAL_MS).unref();
}
