import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import mediaRoutes from '@server/routes/media';
import requestRoutes from '@server/routes/request';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import xml2js from 'xml2js';
import {
  accessFor,
  librarySources,
  ownerFromPath,
  rankRecentlyAdded,
  requestOwnerPatterns,
  resetLibraryAccessCache,
  sharedSectionsFrom,
  type LibraryIndex,
} from './libraryAccess';

mock.method(MediaRequest, 'sendNotification', async () => undefined);

const user = (fields: Partial<User>) =>
  Object.assign(new User(), { permissions: Permission.REQUEST, ...fields });

const media = (id: number, type: MediaType, tmdbId: number, tvdbId?: number) =>
  Object.assign(new Media(), { id, mediaType: type, tmdbId, tvdbId });

const index: LibraryIndex = {
  sections: [
    { key: '1', owner: 'kulpreet' },
    { key: '2', owner: 'james' },
    { key: '3', owner: 'alison' },
    { key: '4', owner: 'alison' },
  ],
  entries: [
    { section: '2', type: MediaType.MOVIE, tmdbId: 10, addedAt: 100 },
    { section: '3', type: MediaType.MOVIE, tmdbId: 11, addedAt: 500 },
    { section: '1', type: MediaType.MOVIE, tmdbId: 10, addedAt: 300 },
    { section: '4', type: MediaType.TV, tvdbId: 77, addedAt: 400 },
    { section: '2', type: MediaType.TV, tvdbId: 77, addedAt: 200 },
    { section: '2', type: MediaType.MOVIE, tmdbId: 99, addedAt: 900 },
  ],
};

describe('library access rules', () => {
  it('reads the owner from Plex folders and Seerr root folders alike', () => {
    assert.equal(
      ownerFromPath('/mnt/media/Library/Kulpreet/Movies'),
      'kulpreet'
    );
    assert.equal(ownerFromPath('/library/william/TV Shows'), 'william');
    assert.equal(ownerFromPath('/mnt/media/Library/Disney'), 'disney');
    assert.equal(ownerFromPath('C:\\media\\Library\\Amanda\\Movies'), 'amanda');
    assert.equal(ownerFromPath('/mnt/media/Music'), null);
    assert.equal(ownerFromPath(null), null);
  });

  it('parses the plex.tv shared_servers list', async () => {
    const xml = await xml2js.parseStringPromise(`<MediaContainer>
      <SharedServer userID="889829530" allLibraries="0">
        <Section key="1" title="Movies-James" shared="1"/>
        <Section key="5" title="Movies-Maddy" shared="0"/>
        <Section key="19" title="Movies-Kulpreet" shared="1"/>
      </SharedServer>
      <SharedServer userID="4109241" allLibraries="1"/>
      <SharedServer userID="" allLibraries="0"/>
    </MediaContainer>`);
    const shared = sharedSectionsFrom(xml);
    assert.deepEqual([...(shared.get(889829530) as Set<string>)], ['1', '19']);
    assert.equal(shared.get(4109241), 'all');
    assert.equal(shared.size, 2);
  });

  it('lets the server owner and request managers see everything', () => {
    assert.equal(
      accessFor(user({ id: 1, username: 'james' }), index, null),
      null
    );
    assert.equal(
      accessFor(
        user({ id: 9, permissions: Permission.MANAGE_REQUESTS }),
        index,
        null
      ),
      null
    );
  });

  it('gives everyone else their own library plus what Plex shares with them', () => {
    const shared = new Map([[555, new Set(['2'])]]);
    const kp = accessFor(
      user({ id: 11, username: 'kulpreet', plexId: 555 }),
      index,
      shared
    );
    assert.deepEqual([...(kp?.sections ?? [])].sort(), ['1', '2']);
    assert.deepEqual([...(kp?.owners ?? [])].sort(), ['james', 'kulpreet']);
    const local = accessFor(user({ id: 8, username: 'kids' }), index, shared);
    assert.deepEqual([...(local?.sections ?? [])], []);
    assert.deepEqual([...(local?.owners ?? [])], ['kids']);
    const all = accessFor(
      user({ id: 12, username: 'tim', plexId: 7 }),
      index,
      new Map([[7, 'all']])
    );
    assert.equal(all?.sections.size, 4);
    // Plex unreachable and nothing cached: their own library only.
    const offline = accessFor(
      user({ id: 11, username: 'kulpreet', plexId: 555 }),
      index,
      null
    );
    assert.deepEqual([...(offline?.sections ?? [])], ['1']);
  });

  it('ranks what is in their sections by the newest copy, matching shows by TVDB', () => {
    const rows = [
      media(1, MediaType.MOVIE, 10),
      media(2, MediaType.MOVIE, 11),
      media(3, MediaType.TV, 500, 77),
    ];
    const access = {
      sections: new Set(['1', '2']),
      owners: new Set(['kulpreet', 'james']),
    };
    // 11 is only in Alison's library; 99 has no Seerr row; 10 counts from its copy at 300.
    assert.deepEqual(
      rankRecentlyAdded(index, access, rows).map((m) => m.id),
      [1, 3]
    );
    const alison = {
      sections: new Set(['3', '4']),
      owners: new Set(['alison']),
    };
    assert.deepEqual(
      rankRecentlyAdded(index, alison, rows).map((m) => m.id),
      [2, 3]
    );
  });

  it('matches request root folders exactly or below the owner folder only', () => {
    assert.deepEqual(requestOwnerPatterns(['james', 'bad owner', 'a_b']), [
      '/library/james',
      '/library/james/%',
    ]);
  });
});

describe('Discover limited to the libraries a person has', () => {
  let app: Express;

  before(() => {
    app = express();
    app.use(express.json());
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
      })
    );
    app.use(checkUser);
    app.use('/auth', authRoutes);
    app.use('/request', requestRoutes);
    app.use('/media', mediaRoutes);
  });

  const originals = { ...librarySources };
  afterEach(() => {
    Object.assign(librarySources, originals);
    resetLibraryAccessCache();
  });

  setupTestDb();

  async function loginAs(email: string) {
    const settings = getSettings();
    const prior = settings.main.localLogin;
    settings.main.localLogin = true;
    try {
      const agent = request.agent(app);
      assert.equal(
        (await agent.post('/auth/local').send({ email, password: 'test1234' }))
          .status,
        200
      );
      return agent;
    } finally {
      settings.main.localLogin = prior;
    }
  }

  async function seed() {
    const users = getRepository(User);
    const admin = await users.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const demo = await users.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    demo.permissions =
      Permission.REQUEST | Permission.REQUEST_VIEW | Permission.RECENT_VIEW;
    await users.save(demo);
    const mediaRepo = getRepository(Media);
    const at = new Date('2026-11-01T00:00:00Z');
    const [inShared, inOther, inOwn] = await mediaRepo.save([
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 9101,
        status: MediaStatus.AVAILABLE,
        mediaAddedAt: at,
      }),
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 9102,
        status: MediaStatus.AVAILABLE,
        mediaAddedAt: at,
      }),
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 9103,
        status: MediaStatus.AVAILABLE,
        mediaAddedAt: at,
      }),
    ]);
    const requests = getRepository(MediaRequest);
    const make = (m: Media, by: User, rootFolder: string) =>
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media: m,
        requestedBy: by,
        is4k: false,
        rootFolder,
      });
    const [shared, other, own] = await requests.save([
      make(inShared, admin, '/library/Alpha/Movies'),
      make(inOther, admin, '/library/beta/Movies'),
      make(inOwn, demo, '/library/beta/Movies'),
    ]);
    librarySources.loadIndex = async () => ({
      sections: [
        { key: '1', owner: 'demo' },
        { key: '2', owner: 'alpha' },
        { key: '3', owner: 'beta' },
      ],
      entries: [
        { section: '2', type: MediaType.MOVIE, tmdbId: 9101, addedAt: 100 },
        { section: '3', type: MediaType.MOVIE, tmdbId: 9102, addedAt: 300 },
        { section: '1', type: MediaType.MOVIE, tmdbId: 9103, addedAt: 200 },
      ],
    });
    // The seeded demo user shares the admin's plexId (1).
    librarySources.loadShared = async () => new Map([[1, new Set(['2'])]]);
    return { inShared, inOther, inOwn, shared, other, own };
  }

  it('shows a regular user only what is in their libraries as recently added', async () => {
    const s = await seed();
    const demo = await loginAs('demo@seerr.dev');
    const res = await demo.get(
      '/media?filter=allavailable&take=20&sort=mediaAdded'
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.results.map((m: Media) => m.id),
      [s.inOwn.id, s.inShared.id]
    );
    assert.equal(res.body.pageInfo.results, 2);
  });

  it('keeps the full list for the admin', async () => {
    const s = await seed();
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.get(
      '/media?filter=allavailable&take=20&sort=mediaAdded'
    );
    assert.deepEqual(
      res.body.results.map((m: Media) => m.id).sort(),
      [s.inShared.id, s.inOther.id, s.inOwn.id].sort()
    );
  });

  it('shows a regular user their own requests and those for libraries they can see', async () => {
    const s = await seed();
    const demo = await loginAs('demo@seerr.dev');
    const res = await demo.get('/request?filter=all&take=10&sort=added&skip=0');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.results.map((r: MediaRequest) => r.id).sort(),
      [s.shared.id, s.own.id].sort()
    );
    const admin = await loginAs('admin@seerr.dev');
    assert.equal(
      (await admin.get('/request?filter=all&take=10')).body.results.length,
      3
    );
  });

  it('falls back to their own requests and nothing recently added when Plex is unreachable', async () => {
    const s = await seed();
    librarySources.loadIndex = async () => {
      throw new Error('plex down');
    };
    librarySources.loadShared = async () => {
      throw new Error('plex.tv down');
    };
    const demo = await loginAs('demo@seerr.dev');
    const recent = await demo.get(
      '/media?filter=allavailable&take=20&sort=mediaAdded'
    );
    assert.deepEqual(recent.body.results, []);
    const reqs = await demo.get('/request?filter=all&take=10');
    assert.deepEqual(
      reqs.body.results.map((r: MediaRequest) => r.id),
      [s.own.id]
    );
  });
});
