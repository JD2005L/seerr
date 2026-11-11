import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import type { LevacEvent } from '@server/lib/levacEvents';
import {
  librarySources,
  resetLibraryAccessCache,
  type LibraryIndex,
  type SharedSections,
} from '@server/lib/libraryAccess';
import { Permission } from '@server/lib/permissions';
import { getSettings, type Library } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { runUserSetup, userSetupSources } from './userSetup';

const index: LibraryIndex = {
  sections: [
    { key: '1', owner: 'kulpreet' },
    { key: '2', owner: 'kulpreet' },
    { key: '3', owner: 'james' },
    { key: '4', owner: 'alison' },
    { key: '5', owner: 'alison' },
  ],
  entries: [],
};

const lib = (id: string, name: string, enabled: boolean): Library => ({
  id,
  name,
  enabled,
  type: name.startsWith('Movies') ? 'movie' : 'show',
});

const allLibraries = (enabled: boolean) => [
  lib('1', 'Movies-Kulpreet', enabled),
  lib('2', 'TV-Kulpreet', enabled),
  lib('3', 'Movies-James', enabled),
  lib('4', 'Movies-Alison', enabled),
  lib('5', 'TV-Alison', enabled),
];

type Fake = {
  folders: string[];
  tags: { id: number; label: string }[];
  created: string[];
};

const fake = (folders: string[], tags: Fake['tags'] = []): Fake => ({
  folders,
  tags,
  created: [],
});

describe('automatic new-person setup', () => {
  const settings = getSettings();
  const saved = {
    plex: settings.plex.libraries,
    radarr: settings.radarr,
    sonarr: settings.sonarr,
  };
  const originals = { ...librarySources };
  const sourceOriginals = { ...userSetupSources };
  let shared: SharedSections;
  let radarr: Fake;
  let sonarr: Fake;
  let sent: LevacEvent[];
  let scans: number;
  let syncs: number;

  setupTestDb();

  beforeEach(async () => {
    // The seeded demo user would be set up too; these tests add their own people.
    await getRepository(User).delete({ email: 'demo@seerr.dev' });
    resetLibraryAccessCache();
    shared = new Map();
    sent = [];
    scans = syncs = 0;
    radarr = fake(['/library/Kulpreet/Movies', '/library/Alison/Movies']);
    sonarr = fake(['/library/Kulpreet/TV Shows', '/library/Alison/TV Shows']);
    settings.plex.libraries = allLibraries(true);
    const server = {
      id: 0,
      isDefault: true,
      is4k: false,
      activeProfileId: 6,
    };
    settings.radarr = [server as never];
    settings.sonarr = [{ ...server } as never];
    mock.method(settings, 'save', async () => undefined);
    librarySources.loadIndex = async () => index;
    librarySources.loadShared = async () => shared;
    const api = (f: () => Fake) => () => ({
      getRootFolders: async () => f().folders.map((path) => ({ path })),
      getTags: async () => f().tags,
      createTag: async ({ label }: { label: string }) => {
        const tag = { id: 500 + f().created.length, label };
        f().created.push(label);
        f().tags.push(tag);
        return tag;
      },
    });
    userSetupSources.radarr = api(() => radarr);
    userSetupSources.sonarr = api(() => sonarr);
    userSetupSources.startScan = () => void scans++;
    userSetupSources.syncLibraries = async () => {
      syncs++;
      settings.plex.libraries = allLibraries(false).map(
        (l) => settings.plex.libraries.find((e) => e.id === l.id) ?? l
      );
    };
    userSetupSources.send = async (event) => {
      sent.push(event);
      return { sent: true };
    };
  });

  afterEach(() => {
    mock.restoreAll();
    Object.assign(librarySources, originals);
    Object.assign(userSetupSources, sourceOriginals);
    settings.plex.libraries = saved.plex;
    settings.radarr = saved.radarr;
    settings.sonarr = saved.sonarr;
  });

  async function person(fields: Partial<User>) {
    const created = new User({
      permissions: Permission.REQUEST,
      userType: UserType.PLEX,
      avatar: '',
      ...fields,
    });
    return getRepository(User).save(created);
  }

  const rulesFor = (id: number) =>
    getRepository(OverrideRule).find({ where: { users: String(id) } });

  it('finds the owner by name and adds both rules, the username and a missing tag', async () => {
    shared.set(900, new Set(['1', '2', '3']));
    const kul = await person({
      email: 'kulpreet.s@example.com',
      plexId: 900,
      plexUsername: 'kulpreetsingh786',
    });
    radarr.tags = [{ id: 534, label: 'kulpreet' }];
    await runUserSetup();

    const stored = await getRepository(User).findOneByOrFail({ id: kul.id });
    assert.equal(stored.username, 'kulpreet');
    const rules = await rulesFor(kul.id);
    assert.equal(rules.length, 2);
    const movie = rules.find((r) => r.radarrServiceId === 0);
    const tv = rules.find((r) => r.sonarrServiceId === 0);
    assert.equal(movie?.rootFolder, '/library/Kulpreet/Movies');
    assert.equal(movie?.profileId, 6);
    assert.equal(movie?.tags, '534');
    assert.equal(movie?.sonarrServiceId, null);
    assert.equal(tv?.rootFolder, '/library/Kulpreet/TV Shows');
    assert.equal(tv?.tags, '500');
    assert.deepEqual(sonarr.created, ['kulpreet']);
    assert.deepEqual(radarr.created, []);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event_type, 'seerr_user_setup');
    assert.equal(sent[0].outcome, 'set_up');
    assert.equal(sent[0].owner, 'kulpreet');
    assert.equal(sent[0].user_id, kul.id);
    assert.equal(sent[0].plex_username, 'kulpreetsingh786');
    assert.match(
      String(sent[0].summary),
      /their requests now go to Movies-Kulpreet and TV-Kulpreet\.$/
    );
  });

  it('uses the one library Plex shares and keeps the folder case', async () => {
    shared.set(901, new Set(['4', '5']));
    const zed = await person({
      email: 'zed@example.com',
      plexId: 901,
      plexUsername: 'zed',
    });
    await runUserSetup();
    const rules = await rulesFor(zed.id);
    assert.deepEqual(rules.map((r) => r.rootFolder).sort(), [
      '/library/Alison/Movies',
      '/library/Alison/TV Shows',
    ]);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: zed.id })).username,
      'alison'
    );
    assert.equal(sent[0].outcome, 'set_up');
  });

  it('skips owners another person already has', async () => {
    shared.set(902, new Set(['1', '2', '4', '5']));
    await person({
      email: 'k@example.com',
      plexId: 903,
      plexUsername: 'k',
      username: 'Kulpreet',
    });
    const zed = await person({
      email: 'zed@example.com',
      plexId: 902,
      plexUsername: 'zed',
    });
    await runUserSetup();
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: zed.id })).username,
      'alison'
    );
  });

  it('reports an ambiguous person and changes nothing', async () => {
    shared.set(904, new Set(['1', '2', '4', '5']));
    const sam = await person({
      email: 'sam@example.com',
      plexId: 904,
      plexUsername: 'sam',
    });
    await runUserSetup();
    assert.equal((await rulesFor(sam.id)).length, 0);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: sam.id })).username,
      null
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].outcome, 'needs_james');
    assert.equal(sent[0].owner, '');
    assert.match(String(sent[0].details), /kulpreet, alison/);
  });

  it('reports a person with no library of their own', async () => {
    shared.set(906, new Set());
    await person({ email: 'bo@example.com', plexId: 906, plexUsername: 'bo' });
    await runUserSetup();
    const none = sent.find((e) => e.plex_username === 'bo');
    assert.equal(none?.outcome, 'needs_james');
    assert.match(String(none?.summary), /shares no library of their own/);
  });

  it('leaves people who already have rules alone', async () => {
    shared.set(907, new Set(['4', '5']));
    const lee = await person({
      email: 'lee@example.com',
      plexId: 907,
      plexUsername: 'lee',
    });
    const existing = await getRepository(OverrideRule).save(
      new OverrideRule({
        users: `3,${lee.id}`,
        radarrServiceId: 0,
        profileId: 4,
        rootFolder: '/library/Other/Movies',
        tags: '1',
      })
    );
    await runUserSetup();
    const rules = await getRepository(OverrideRule).find();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, existing.id);
    assert.equal(rules[0].profileId, 4);
    assert.equal(sent.length, 0);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: lee.id })).username,
      null
    );
  });

  it('does not touch a username set to something else', async () => {
    shared.set(908, new Set(['4', '5']));
    const bob = await person({
      email: 'bob@example.com',
      plexId: 908,
      plexUsername: 'bob',
      username: 'Bobby',
    });
    await runUserSetup();
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: bob.id })).username,
      'Bobby'
    );
    assert.equal((await rulesFor(bob.id)).length, 0);
    assert.equal(sent[0].outcome, 'needs_james');
    assert.equal(sent[0].owner, 'alison');
  });

  it('does not create anything when a root folder is missing', async () => {
    shared.set(909, new Set(['4', '5']));
    sonarr.folders = ['/library/Kulpreet/TV Shows'];
    const amy = await person({
      email: 'amy@example.com',
      plexId: 909,
      plexUsername: 'amy',
    });
    await runUserSetup();
    assert.equal((await rulesFor(amy.id)).length, 0);
    assert.deepEqual([...radarr.created, ...sonarr.created], []);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: amy.id })).username,
      null
    );
    assert.equal(sent[0].outcome, 'needs_james');
    assert.match(String(sent[0].details), /Sonarr is missing/);
  });

  it('tells PVIBot once per outcome and again only when it changes', async () => {
    shared.set(910, new Set(['1', '2', '4', '5']));
    const sam = await person({
      email: 'sam@example.com',
      plexId: 910,
      plexUsername: 'sam',
    });
    await runUserSetup();
    await runUserSetup();
    assert.equal(sent.length, 1);
    shared.set(910, new Set(['4', '5']));
    resetLibraryAccessCache();
    await runUserSetup();
    await runUserSetup();
    assert.deepEqual(
      sent.map((e) => e.outcome),
      ['needs_james', 'set_up']
    );
    assert.equal((await rulesFor(sam.id)).length, 2);
  });

  it('keeps a message that could not be sent and retries it', async () => {
    shared.set(911, new Set(['4', '5']));
    await person({ email: 'cy@example.com', plexId: 911, plexUsername: 'cy' });
    let fail = true;
    userSetupSources.send = async (event) => {
      if (fail) return { sent: false, error: 'down' };
      sent.push(event);
      return { sent: true };
    };
    await runUserSetup();
    assert.equal(sent.length, 0);
    fail = false;
    await runUserSetup();
    await runUserSetup();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].outcome, 'set_up');
  });

  it('enables missing libraries once, syncs only when one is missing, never disables', async () => {
    settings.plex.libraries = [
      lib('1', 'Movies-Kulpreet', false),
      lib('3', 'Movies-James', true),
      lib('9', 'Movies-Disney', false),
    ];
    await runUserSetup();
    assert.equal(syncs, 1);
    assert.equal(scans, 1);
    const byId = new Map(settings.plex.libraries.map((l) => [l.id, l]));
    for (const key of ['1', '2', '3', '4', '5'])
      assert.equal(byId.get(key)?.enabled, true, key);
    settings.plex.libraries = [
      ...settings.plex.libraries,
      lib('9', 'Movies-Disney', false),
    ].filter((l, i, all) => all.findIndex((o) => o.id === l.id) === i);
    await runUserSetup();
    assert.equal(syncs, 1);
    assert.equal(scans, 1);
    assert.equal(
      settings.plex.libraries.find((l) => l.id === '9')?.enabled,
      false
    );
  });
});
