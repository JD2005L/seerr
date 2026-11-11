import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import {
  accessibleTitleKeys,
  librarySources,
  resetLibraryAccessCache,
  type LibraryIndex,
} from '@server/lib/libraryAccess';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import libraryRoutes from '@server/routes/library';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const index: LibraryIndex = {
  sections: [
    { key: '1', owner: 'demo' },
    { key: '2', owner: 'alpha' },
    { key: '3', owner: 'beta' },
  ],
  entries: [
    { section: '1', type: MediaType.MOVIE, tmdbId: 10, addedAt: 1 },
    { section: '1', type: MediaType.TV, tmdbId: 20, tvdbId: 77, addedAt: 2 },
    { section: '2', type: MediaType.MOVIE, tmdbId: 11, addedAt: 3 },
    { section: '3', type: MediaType.MOVIE, tmdbId: 12, addedAt: 4 },
    { section: '3', type: MediaType.TV, tvdbId: 88, addedAt: 5 },
  ],
};

describe('accessibleTitleKeys', () => {
  it('builds movie and tv keys for the sections only', () => {
    const keys = accessibleTitleKeys(index, {
      sections: new Set(['1', '3']),
      owners: new Set(['demo', 'beta']),
    });
    assert.deepEqual(keys.sort(), [
      'movie:tmdb:10',
      'movie:tmdb:12',
      'tv:tmdb:20',
      'tv:tvdb:77',
      'tv:tvdb:88',
    ]);
  });

  it('is empty when no section is visible', () => {
    assert.deepEqual(
      accessibleTitleKeys(index, { sections: new Set(), owners: new Set() }),
      []
    );
  });
});

describe('GET /library/mine', () => {
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
    app.use('/library', libraryRoutes);
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

  async function limitDemo() {
    const users = getRepository(User);
    const demo = await users.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    demo.permissions = Permission.REQUEST;
    await users.save(demo);
    librarySources.loadIndex = async () => index;
    // The seeded demo user shares the admin's plexId (1): shared section 2.
    librarySources.loadShared = async () => new Map([[1, new Set(['2'])]]);
  }

  it('lists the titles a regular user can see', async () => {
    await limitDemo();
    const demo = await loginAs('demo@seerr.dev');
    const res = await demo.get('/library/mine');
    assert.equal(res.status, 200);
    assert.equal(res.body.limited, true);
    assert.deepEqual(res.body.titles.sort(), [
      'movie:tmdb:10',
      'movie:tmdb:11',
      'tv:tmdb:20',
      'tv:tvdb:77',
    ]);
  });

  it('is not limited for the admin', async () => {
    await limitDemo();
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.get('/library/mine');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { limited: false });
  });

  it('is not limited when the library list cannot be read', async () => {
    await limitDemo();
    librarySources.loadIndex = async () => {
      throw new Error('plex down');
    };
    const demo = await loginAs('demo@seerr.dev');
    const res = await demo.get('/library/mine');
    assert.deepEqual(res.body, { limited: false });
  });
});
