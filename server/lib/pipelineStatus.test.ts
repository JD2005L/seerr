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
import {
  librarySources,
  resetLibraryAccessCache,
} from '@server/lib/libraryAccess';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import pipelineRoutes from '@server/routes/pipeline';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import {
  canSeeRequest,
  pipelineRows,
  pipelineSources,
  resetPipelineCache,
  trim,
  type PipelineRow,
} from './pipelineStatus';

mock.method(MediaRequest, 'sendNotification', async () => undefined);

const originals = { ...pipelineSources };
const libraryOriginals = { ...librarySources };
afterEach(() => {
  Object.assign(pipelineSources, originals);
  Object.assign(librarySources, libraryOriginals);
  resetPipelineCache();
  resetLibraryAccessCache();
  mock.timers.reset();
});

const config = () => ({ url: 'http://pipeline.test', key: 'k' });

describe('pipeline status visibility', () => {
  const access = { sections: new Set(['1']), owners: new Set(['kulpreet']) };

  it('lets unrestricted users see every request', () => {
    assert.equal(
      canSeeRequest(
        { requestedById: 5, rootFolder: '/library/x/Movies' },
        { id: 1 },
        null
      ),
      true
    );
  });

  it('shows their own request whatever its library', () => {
    assert.equal(
      canSeeRequest(
        { requestedById: 7, rootFolder: '/library/alison/Movies' },
        { id: 7 },
        access
      ),
      true
    );
  });

  it('shows a request for a library they can see', () => {
    assert.equal(
      canSeeRequest(
        { requestedById: 5, rootFolder: '/library/Kulpreet/TV Shows' },
        { id: 7 },
        access
      ),
      true
    );
  });

  it('hides a request for a library they cannot see, or with no library', () => {
    assert.equal(
      canSeeRequest(
        { requestedById: 5, rootFolder: '/library/alison/Movies' },
        { id: 7 },
        access
      ),
      false
    );
    assert.equal(
      canSeeRequest({ requestedById: 5, rootFolder: null }, { id: 7 }, access),
      false
    );
  });
});

describe('pipeline cache', () => {
  it('is unavailable with no config', async () => {
    pipelineSources.config = () => null;
    pipelineSources.fetchRows = async () => {
      throw new Error('should not be called');
    };
    assert.equal(await pipelineRows(), null);
  });

  it('reuses one fetch within 10 seconds, shares an in-flight fetch, then refetches', async () => {
    mock.timers.enable({ apis: ['Date'] });
    let calls = 0;
    pipelineSources.config = config;
    pipelineSources.fetchRows = async () => {
      calls++;
      return [{ id: calls }];
    };
    const [a, b] = await Promise.all([pipelineRows(), pipelineRows()]);
    assert.equal(calls, 1);
    assert.deepEqual(a?.rows, b?.rows);
    mock.timers.tick(5_000);
    await pipelineRows();
    assert.equal(calls, 1);
    mock.timers.tick(6_000);
    const again = await pipelineRows();
    assert.equal(calls, 2);
    assert.equal(again?.rows[0].id, 2);
  });

  it('serves the last good copy for up to 5 minutes when a refresh fails', async () => {
    mock.timers.enable({ apis: ['Date'] });
    let fail = false;
    pipelineSources.config = config;
    pipelineSources.fetchRows = async () => {
      if (fail) throw new Error('down');
      return [{ id: 1 }];
    };
    await pipelineRows();
    fail = true;
    mock.timers.tick(30_000);
    const stale = await pipelineRows();
    assert.equal(stale?.stale, true);
    assert.equal(stale?.rows.length, 1);
    mock.timers.tick(5 * 60_000);
    assert.equal(await pipelineRows(), null);
  });

  it('is unavailable when the first fetch fails', async () => {
    pipelineSources.config = config;
    pipelineSources.fetchRows = async () => {
      throw new Error('down');
    };
    assert.equal(await pipelineRows(), null);
  });

  it('trims internal fields', () => {
    const row = {
      id: 3,
      stage: 'downloading',
      headline: 'Downloading',
      progress: 0.5,
      problem: { kind: 'x', text: 'Stuck' },
      hermes: { state: 'investigating', note: 'Looking' },
      seerrUser: 4,
      steps: [],
    } as PipelineRow;
    const out = trim(row) as unknown as Record<string, unknown>;
    assert.equal(out.problem, 'Stuck');
    assert.deepEqual(out.hermes, { state: 'investigating', note: 'Looking' });
    assert.equal('seerrUser' in out, false);
    assert.equal('steps' in out, false);
  });
});

describe('GET /pipeline', () => {
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
    app.use('/pipeline', pipelineRoutes);
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
    demo.permissions = Permission.REQUEST | Permission.REQUEST_VIEW;
    await users.save(demo);
    const medias = await getRepository(Media).save(
      [9201, 9202, 9203, 9204, 9205].map(
        (tmdbId) =>
          new Media({
            mediaType: MediaType.MOVIE,
            tmdbId,
            status: MediaStatus.PROCESSING,
          })
      )
    );
    const make = (
      m: Media,
      by: User,
      rootFolder: string,
      status = MediaRequestStatus.APPROVED
    ) =>
      new MediaRequest({
        type: MediaType.MOVIE,
        status,
        media: m,
        requestedBy: by,
        is4k: false,
        rootFolder,
      });
    const [visible, hidden, own, pending, finished] = await getRepository(
      MediaRequest
    ).save([
      make(medias[0], admin, '/library/alpha/Movies'),
      make(medias[1], admin, '/library/beta/Movies'),
      make(medias[2], demo, '/library/beta/Movies'),
      make(medias[3], demo, '/library/beta/Movies', MediaRequestStatus.PENDING),
      make(medias[4], demo, '/library/beta/Movies'),
    ]);
    librarySources.loadIndex = async () => ({
      sections: [
        { key: '1', owner: 'demo' },
        { key: '2', owner: 'alpha' },
        { key: '3', owner: 'beta' },
      ],
      entries: [],
    });
    librarySources.loadShared = async () => new Map([[1, new Set(['2'])]]);
    pipelineSources.config = config;
    pipelineSources.fetchRows = async () => [
      ...[visible, hidden, own, pending].map((r) => ({
        id: r.id,
        stage: 'downloading',
        headline: 'Downloading',
        progress: 0.4,
        seerrUser: 99,
      })),
      { id: finished.id, stage: 'library', done: true },
      { id: 424242, stage: 'downloading' },
    ];
    return { visible, hidden, own, pending, finished };
  }

  it('gives a regular user their own and visible-library requests, approved and open only', async () => {
    const s = await seed();
    const demo = await loginAs('demo@seerr.dev');
    const res = await demo.get('/pipeline');
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.deepEqual(
      res.body.statuses.map((x: { requestId: number }) => x.requestId).sort(),
      [s.visible.id, s.own.id].sort()
    );
    assert.equal('seerrUser' in res.body.statuses[0], false);
  });

  it('gives the admin every open approved request, and narrows by requestIds', async () => {
    const s = await seed();
    const admin = await loginAs('admin@seerr.dev');
    const all = await admin.get('/pipeline');
    assert.deepEqual(
      all.body.statuses.map((x: { requestId: number }) => x.requestId).sort(),
      [s.visible.id, s.hidden.id, s.own.id].sort()
    );
    const some = await admin.get(`/pipeline?requestIds=${s.hidden.id},abc`);
    assert.deepEqual(
      some.body.statuses.map((x: { requestId: number }) => x.requestId),
      [s.hidden.id]
    );
  });

  it('reports unavailable with no config', async () => {
    await seed();
    pipelineSources.config = () => null;
    const demo = await loginAs('demo@seerr.dev');
    const res = await demo.get('/pipeline');
    assert.deepEqual(res.body, { available: false, statuses: [] });
  });
});
