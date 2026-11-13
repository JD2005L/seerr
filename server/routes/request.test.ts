import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import datasource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import OverrideRule from '@server/entity/OverrideRule';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  assertNoCredentials,
  seedUserSettings,
} from '@server/test/userSettings';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

const getMovieImpl: (args: {
  movieId: number;
  language?: string;
}) => Promise<TmdbMovieDetails> = async ({ movieId }) => fakeTmdbMovie(movieId);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async (args: { movieId: number; language?: string }) =>
      getMovieImpl(args);
  },
  set() {},
  configurable: true,
});

const getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async ({ tvId }) => fakeTmdbShow(tvId);

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

function fakeTmdbMovie(tmdbId: number): TmdbMovieDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { keywords: [] },
    external_ids: {},
  } as unknown as TmdbMovieDetails;
}

function fakeTmdbShow(tmdbId: number): TmdbTvDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { results: [] },
    external_ids: {},
  } as unknown as TmdbTvDetails;
}

function configureRadarr(overrides: Partial<RadarrSettings>[]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
}

function configureSonarr(overrides: Partial<SonarrSettings>[]): void {
  const settings = getSettings();
  settings.sonarr = overrides.map((o, i) => ({
    id: i,
    name: `Sonarr ${i}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    animeTags: [],
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as SonarrSettings[];
}

let app: Express;

function createApp() {
  const app = express();
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
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

beforeEach(() => {
  sendNotificationMock.resetCalls();
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function seedRequest(status = MediaRequestStatus.PENDING) {
  const userRepo = getRepository(User);
  const mediaRepo = getRepository(Media);
  const requestRepo = getRepository(MediaRequest);

  const requestedBy = await userRepo.findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });

  const media = await mediaRepo.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const created = await requestRepo.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
      updatedAt: new Date('2025-03-01T00:00:00.000Z'),
    })
  );

  return requestRepo.findOneOrFail({
    where: { id: created.id },
    relations: { requestedBy: true, modifiedBy: true },
  });
}

describe('DELETE /request/:requestId', () => {
  it('allows the owner to delete their own pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('allows an admin to delete any pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('prevents a non-owner non-admin from deleting a pending request', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    // Create a request owned by admin, then try to delete as friend
    const owner = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 54321,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('prevents the owner from deleting an approved request', async () => {
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('returns 404 for a non-existent request', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete('/request/99999999');

    assert.strictEqual(res.status, 404);
  });

  it('deletes a request once when two deletes race', async () => {
    const repo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const results = await Promise.all([
      admin.delete(`/request/${mediaRequest.id}`),
      admin.delete(`/request/${mediaRequest.id}`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [204, 404]);
    assert.strictEqual(await repo.count({ where: { id: mediaRequest.id } }), 0);
  });
});

describe('PUT /request/:requestId (movie)', () => {
  it('persists server and root folder changes to the database', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      profileId: 7,
      rootFolder: '/updated/movies',
      tags: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 3);
    assert.strictEqual(saved.profileId, 7);
    assert.strictEqual(saved.rootFolder, '/updated/movies');
  });

  it('refuses to modify a request that is no longer pending', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      rootFolder: '/updated/movies',
    });

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, null);
    assert.strictEqual(saved.rootFolder, null);
  });
});

async function seedUser(
  email: string,
  fields: {
    movieQuotaLimit?: number;
    tvQuotaLimit?: number;
    tvQuotaDays?: number;
    permissions?: number;
  } = {}
) {
  const userRepo = getRepository(User);
  const user = await userRepo.findOneOrFail({ where: { email } });
  Object.assign(user, fields);

  return userRepo.save(user);
}

async function seedTvMedia(tmdbId: number) {
  const mediaRepo = getRepository(Media);

  return (
    (await mediaRepo.findOne({
      where: { tmdbId, mediaType: MediaType.TV },
    })) ??
    (await mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    ))
  );
}

async function seedMediaSeasons(
  tmdbId: number,
  seasons: { seasonNumber: number; status: MediaStatus }[]
) {
  const media = await seedTvMedia(tmdbId);
  media.seasons = seasons.map(
    ({ seasonNumber, status }) =>
      new Season({ seasonNumber, status, status4k: MediaStatus.UNKNOWN })
  );

  return getRepository(Media).save(media);
}

async function seedTvRequest(
  requestedBy: User,
  seasons: number[],
  { tmdbId = 67890, ignoreQuota = false, createdAt = new Date() } = {}
) {
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.PENDING,
      media: await seedTvMedia(tmdbId),
      requestedBy,
      is4k: false,
      ignoreQuota,
      createdAt,
      seasons: seasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.PENDING,
          })
      ),
    })
  );
}

describe('PUT /request/:requestId (tv)', () => {
  it('does not add a season held by another request', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('demo@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );

    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });
    assert.deepStrictEqual(
      otherSaved.seasons.map((s) => s.seasonNumber),
      [3]
    );
  });

  it('gives a season to only one of two concurrent edits', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('demo@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const friend = await loginAs('demo@seerr.dev', 'test1234');

    const [adminRes, friendRes] = await Promise.all([
      admin
        .put(`/request/${mediaRequest.id}`)
        .send({ mediaType: MediaType.TV, seasons: [1, 2] }),
      friend
        .put(`/request/${otherRequest.id}`)
        .send({ mediaType: MediaType.TV, seasons: [3, 2] }),
    ]);

    assert.strictEqual(adminRes.status, 200);
    assert.strictEqual(friendRes.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });

    const holders = [saved, otherSaved].filter((r) =>
      r.seasons.some((s) => s.seasonNumber === 2)
    );
    assert.strictEqual(holders.length, 1);

    assert.deepStrictEqual(
      [...saved.seasons, ...otherSaved.seasons]
        .map((s) => s.seasonNumber)
        .sort((a, b) => a - b),
      [1, 2, 3]
    );
  });
});

describe('PUT /request/:requestId (season availability)', () => {
  it('does not add a season the media already has', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 3]
    );
  });

  it('returns 202 when every requested season is already covered', async () => {
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
    });

    assert.strictEqual(res.status, 202);
  });

  it('keeps the seasons it already holds once they are available', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 1, status: MediaStatus.AVAILABLE },
      { seasonNumber: 2, status: MediaStatus.PROCESSING },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      serverId: 3,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
    assert.strictEqual(saved.serverId, 3);
  });

  it('does not charge quota for a season the media already has', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber),
      [1]
    );
  });
});

describe('PUT /request/:requestId (quota)', () => {
  it('rejects adding seasons beyond the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('rejects adding seasons to a request older than the quota window', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', {
      tvQuotaLimit: 2,
      tvQuotaDays: 7,
    });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('allows swapping seasons at the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [3, 4],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [3, 4]
    );
  });

  it('rejects reassignment to a user without room for the existing seasons', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('rejects reassignment of a movie request to a user at their limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRepo = getRepository(Media);

    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('demo@seerr.dev', { movieQuotaLimit: 1 });

    // Uses up the target's single movie request
    await seedRequest();

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 55555,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('allows reassignment to a user who bypasses quotas', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const target = await seedUser('admin@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, target.id);
  });

  it('allows an edit that exceeds the limit when the request ignores quota', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });

    await seedTvRequest(owner, [1, 2], { tmdbId: 77777 });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      ignoreQuota: true,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });

  it('charges only the net increase when an edit both adds and removes', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 4 });
    const mediaRequest = await seedTvRequest(owner, [1, 2, 3]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 4, 5],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 4, 5]
    );
  });
});

const movieOptions = {
  serverId: 2,
  profileId: 9,
  rootFolder: '/chosen',
  tags: [3],
};

const tvOptions = { ...movieOptions, languageProfileId: 4 };

const noOptions = {
  serverId: null,
  profileId: null,
  rootFolder: null,
  languageProfileId: null,
  tags: null,
};

function storedOptions(request: MediaRequest) {
  return {
    serverId: request.serverId,
    profileId: request.profileId,
    rootFolder: request.rootFolder,
    languageProfileId: request.languageProfileId,
    tags: request.tags,
  };
}

describe('PUT /request/:requestId (advanced options)', () => {
  it('keeps the stored options when a regular requester edits their seasons', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    const stored = {
      serverId: 1,
      profileId: 5,
      rootFolder: '/stored',
      languageProfileId: 2,
      tags: [6],
    };
    await requestRepo.save(Object.assign(mediaRequest, stored));

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      ...tvOptions,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
    assert.deepStrictEqual(storedOptions(saved), stored);
  });

  it('rejects a regular requester editing their movie request as a series', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1],
      ...tvOptions,
    });

    assert.strictEqual(res.status, 403);
  });
});

describe('GET /request/:requestId', () => {
  it('omits notification settings from requestedBy and modifiedBy', async () => {
    const pending = await seedRequest();
    await seedUserSettings('demo@seerr.dev');
    await seedUserSettings('admin@seerr.dev');

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const approved = await admin.post(`/request/${pending.id}/approve`);
    assert.strictEqual(approved.status, 200);

    const res = await admin.get(`/request/${pending.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requestedBy.email, 'demo@seerr.dev');
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');
    assert.ok(!('settings' in res.body.requestedBy));
    assert.ok(!('settings' in res.body.modifiedBy));
    assertNoCredentials(res.body);
  });
});

describe('POST /request/:requestId/:status', () => {
  const cases = [
    { action: 'approve', expected: MediaRequestStatus.APPROVED },
    { action: 'decline', expected: MediaRequestStatus.DECLINED },
  ] as const;

  for (const { action, expected } of cases) {
    it(`transitions to ${action}d and records the acting user`, async () => {
      const repo = getRepository(MediaRequest);
      const pending = await seedRequest();
      const admin = await loginAs('admin@seerr.dev', 'test1234');

      const res = await admin.post(`/request/${pending.id}/${action}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, expected);
      assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

      const persisted = await repo.findOneOrFail({
        where: { id: pending.id },
        relations: { modifiedBy: true },
      });

      assert.strictEqual(persisted.status, expected);
      assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
      assert.ok(persisted.updatedAt > pending.updatedAt);
    });
  }

  it('rejects a status the route does not define', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/frobnicate`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({
      where: { id: pending.id },
      relations: { modifiedBy: true },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
    assert.ok(!persisted.modifiedBy);
  });

  it('refuses to act on a request that is no longer pending', async () => {
    const repo = getRepository(MediaRequest);
    const approved = await seedRequest(MediaRequestStatus.APPROVED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${approved.id}/decline`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const persisted = await repo.findOneOrFail({ where: { id: approved.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });

  it('applies only one of a concurrent approve and decline', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const [approve, decline] = await Promise.all([
      admin.post(`/request/${pending.id}/approve`),
      admin.post(`/request/${pending.id}/decline`),
    ]);

    assert.deepStrictEqual([approve.status, decline.status].sort(), [200, 409]);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(
      persisted.status,
      approve.status === 200
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.DECLINED
    );
  });

  it('rejects the removed pending verb even on a non-pending request', async () => {
    const repo = getRepository(MediaRequest);
    const declined = await seedRequest(MediaRequestStatus.DECLINED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${declined.id}/pending`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({ where: { id: declined.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
  });
});

describe('POST /request/:requestId/retry', () => {
  it('re-approves a failed request and records the acting user', async () => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

    const persisted = await repo.findOneOrFail({
      where: { id: failed.id },
      relations: { modifiedBy: true },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
    assert.ok(persisted.updatedAt > failed.updatedAt);
  });

  it('refuses to retry a request that has not failed', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/retry`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /failed/i);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
  });

  it('sends a concurrently retried request to *arr once', async (t) => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const results = await Promise.all([
      admin.post(`/request/${failed.id}/retry`),
      admin.post(`/request/${failed.id}/retry`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.strictEqual(sendToRadarr.mock.callCount(), 1);

    const persisted = await repo.findOneOrFail({ where: { id: failed.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });
});

describe('DELETE /request/:requestId, deleted media status restoration', () => {
  async function seedDeletedMediaScenario() {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99001,
        status: MediaStatus.DELETED,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
        isAutoRequest: true,
      })
    );

    media.status = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    return { media, staleRequest, newRequest, admin };
  }

  it('restores media status to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const mediaRepo = getRepository(Media);
    const { media, newRequest } = await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.DELETED);
  });

  it('restores media status4k to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99003,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.DELETED);
  });

  it('resets media status to UNKNOWN when the stale completed request is also deleted', async () => {
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);
    const { media, newRequest, staleRequest } =
      await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.UNKNOWN);

    const remaining = await requestRepo.find({
      where: { media: { id: media.id } },
    });
    assert.strictEqual(remaining.length, 0);
  });

  it('resets media status4k to UNKNOWN when the stale completed 4K request is also deleted', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99004,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.UNKNOWN);
  });

  it('does not reset media status when other active requests still exist', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99002,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const req1 = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${req1.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PENDING);
  });

  it('does not reset media status when status is PARTIALLY_AVAILABLE and only completed requests remain', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99005,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const completedRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${completedRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
  });
});

describe('POST /request (movie), override rules', () => {
  it('applies an override rule when the default Radarr server id differs from its array index', async () => {
    configureRadarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88001,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('applies an override rule when the default Radarr server id matches its array index (sanity check)', async () => {
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88002,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('does not apply an unrelated override rule when there is no default Radarr server configured', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88005,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('applies the selected server override rule when a specific server is requested', async () => {
    configureRadarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, is4k: false },
    ]);
    getSettings().sonarr = [];

    const friend = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 2,
        users: String(friend.id),
        rootFolder: '/selected/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88007,
      serverId: 2,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/selected/movies');
  });

  it('does not apply the default server override rule when another server is requested', async () => {
    configureRadarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, is4k: false },
    ]);
    getSettings().sonarr = [];

    const friend = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 1,
        users: String(friend.id),
        rootFolder: '/default/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88008,
      serverId: 2,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('falls back to the default server override rule when the requested server does not exist', async () => {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 1,
        users: String(friend.id),
        rootFolder: '/default/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88009,
      serverId: 7,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/default/movies');
  });
});

describe('POST /request (tv), override rules', () => {
  it('applies an override rule when the default Sonarr server id differs from its array index', async () => {
    configureSonarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88003,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('applies an override rule when the default Sonarr server id matches its array index (sanity check)', async () => {
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88004,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('does not apply an unrelated override rule when there is no default Sonarr server configured', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88006,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('applies the selected server override rule when a specific server is requested', async () => {
    configureSonarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, is4k: false },
    ]);
    getSettings().radarr = [];

    const friend = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 2,
        users: String(friend.id),
        rootFolder: '/selected/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88011,
      seasons: [1],
      serverId: 2,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/selected/tv');
  });

  it('does not apply the default server override rule when another server is requested', async () => {
    configureSonarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, is4k: false },
    ]);
    getSettings().radarr = [];

    const friend = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 1,
        users: String(friend.id),
        rootFolder: '/default/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88012,
      seasons: [1],
      serverId: 2,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('falls back to the default server override rule when the requested server does not exist', async () => {
    configureSonarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 1,
        users: String(friend.id),
        rootFolder: '/default/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88013,
      seasons: [1],
      serverId: 7,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/default/tv');
  });
});

describe('POST /request, override rules and requester choices', () => {
  async function requestWithRule(permissions: number) {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const requester = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    requester.permissions = permissions;
    await userRepo.save(requester);

    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 1,
        rootFolder: '/rule',
        profileId: 7,
        tags: '2',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    return agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88010,
      serverId: 1,
      rootFolder: '/chosen',
      tags: [],
    });
  }

  it('keeps what an advanced requester sets and fills the rest from the rule', async () => {
    const res = await requestWithRule(
      Permission.REQUEST | Permission.REQUEST_ADVANCED
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/chosen');
    assert.strictEqual(res.body.profileId, 7);
    assert.deepStrictEqual(res.body.tags, []);
  });

  it('keeps what a request manager sets and fills the rest from the rule', async (t) => {
    // Manage Requests auto-approves; keep it from calling Radarr
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const res = await requestWithRule(
      Permission.REQUEST | Permission.MANAGE_REQUESTS
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/chosen');
    assert.strictEqual(res.body.profileId, 7);
    assert.deepStrictEqual(res.body.tags, []);
  });

  it('applies the rule over what a regular requester sets', async () => {
    const res = await requestWithRule(Permission.REQUEST);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/rule');
  });
});

describe('POST /request, advanced options', () => {
  it('ignores advanced options on a movie request from a regular requester', async () => {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }, { id: 2 }]);
    getSettings().sonarr = [];

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88020,
      ...movieOptions,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), noOptions);
  });

  it('ignores advanced options on a series request from a regular requester', async () => {
    configureSonarr([{ id: 1, isDefault: true, is4k: false }, { id: 2 }]);
    getSettings().radarr = [];

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88021,
      seasons: [1],
      ...tvOptions,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), noOptions);
  });

  it('ignores a 4K server and its options on a non-4K request', async () => {
    configureRadarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, isDefault: true, is4k: true },
    ]);
    getSettings().sonarr = [];
    await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88022,
      is4k: false,
      ...movieOptions,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), noOptions);
  });

  it('keeps advanced options from an advanced requester', async () => {
    configureSonarr([{ id: 1, isDefault: true, is4k: false }, { id: 2 }]);
    getSettings().radarr = [];
    await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88023,
      seasons: [1],
      ...tvOptions,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), tvOptions);
  });

  it('keeps advanced options when the serverId is null', async () => {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];
    await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88024,
      ...movieOptions,
      serverId: null,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), {
      ...movieOptions,
      serverId: null,
      languageProfileId: null,
    });
  });
});

describe('DELETE /request/:requestId, orphaned season status reset', () => {
  // Seeding an approved request sends it to any configured Sonarr
  beforeEach(() => {
    getSettings().sonarr = [];
  });

  async function seedTvShow(
    tmdbId: number,
    seasons: Partial<Season>[]
  ): Promise<Media> {
    const mediaRepo = getRepository(Media);

    return mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        seasons: seasons.map((season) => new Season(season)),
      })
    );
  }

  async function seedTvRequest(
    media: Media,
    seasonNumbers: number[]
  ): Promise<MediaRequest> {
    const userRepo = getRepository(User);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    return requestRepo.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
        seasons: seasonNumbers.map(
          (seasonNumber) =>
            new SeasonRequest({
              seasonNumber,
              status: MediaRequestStatus.APPROVED,
            })
        ),
      })
    );
  }

  it('resets a request-covered PROCESSING season to UNKNOWN so it can be re-requested', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99101, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);

    const friend = await loginAs('demo@seerr.dev', 'test1234');
    const reRequest = await friend.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 99101,
      seasons: [1],
    });
    assert.strictEqual(reRequest.status, 201);
  });

  it('does not touch PROCESSING seasons the deleted request did not cover', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99102, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
      { seasonNumber: 2, status: MediaStatus.PROCESSING },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    const seasonOne = updated.seasons.find((s) => s.seasonNumber === 1);
    const seasonTwo = updated.seasons.find((s) => s.seasonNumber === 2);
    assert.strictEqual(seasonOne?.status, MediaStatus.UNKNOWN);
    assert.strictEqual(seasonTwo?.status, MediaStatus.PROCESSING);
  });

  it('keeps a season PROCESSING while another active request still covers it', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99103, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
    ]);
    const firstRequest = await seedTvRequest(media, [1]);
    await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${firstRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.PROCESSING);
  });

  it('leaves season status4k untouched when deleting a non-4K request', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99104, [
      {
        seasonNumber: 1,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.PROCESSING,
      },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);
    assert.strictEqual(updated.seasons[0].status4k, MediaStatus.PROCESSING);
  });
});

describe('per-owner library fan-out', () => {
  it('separates unseen movie and TV titles with the same numeric ID', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const movie = await demo
      .post('/request/fanout')
      .send({ mediaType: 'movie', tmdbId: 999123 });
    const tv = await demo
      .post('/request/fanout')
      .send({ mediaType: 'tv', tmdbId: 999123 });
    assert.strictEqual(movie.status, 200);
    assert.strictEqual(tv.status, 200, JSON.stringify(tv.body));
    assert.notStrictEqual(movie.body.requestId, tv.body.requestId);
    const rows = await datasource.query(
      'select mediaType from media_fanout_intent where owner = ?',
      [movie.body.owner]
    );
    assert.deepStrictEqual(
      rows.map((r: { mediaType: string }) => r.mediaType).sort(),
      ['movie', 'tv']
    );
  });

  it('separates unseen TV TMDB and TVDB keys with the same number', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const tmdb = await demo
      .post('/request/fanout')
      .send({ mediaType: 'tv', tmdbId: 998821 });
    const tvdb = await demo
      .post('/request/fanout')
      .send({ mediaType: 'tv', tvdbId: 998821 });
    assert.strictEqual(tmdb.status, 200);
    assert.strictEqual(tvdb.status, 200, JSON.stringify(tvdb.body));
    assert.notStrictEqual(tmdb.body.requestId, tvdb.body.requestId);
    const rows = await datasource.query(
      'select tmdbId, tvdbId from media_fanout_intent where owner = ?',
      [tmdb.body.owner]
    );
    assert.strictEqual(rows.length, 2);
  });

  it('returns persisted removal intent after worker error', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const body = { mediaType: 'movie', tmdbId: 998822 };
    const added = await demo
      .post('/request/fanout')
      .send({ ...body, desiredState: 'present' });
    await datasource.query(
      'update media_fanout_intent set status = ? where requestId = ?',
      ['fulfilled', added.body.requestId]
    );
    const removed = await demo
      .post('/request/fanout')
      .send({ ...body, desiredState: 'absent' });
    assert.strictEqual(removed.body.desiredState, 'absent');
    await datasource.query(
      'update media_fanout_intent set status = ? where requestId = ?',
      ['error', added.body.requestId]
    );
    const status = await demo.get(
      '/request/fanout/status?mediaType=movie&tmdbId=998822'
    );
    assert.strictEqual(status.body.status, 'error');
    assert.strictEqual(status.body.desiredState, 'absent');
    const owners = await admin.get(
      '/request/fanout/owners?mediaType=movie&tmdbId=998822'
    );
    const entry = owners.body.owners.find(
      (o: { owner: string }) => o.owner === added.body.owner
    );
    assert.strictEqual(entry.desiredState, 'absent');
    const retry = await demo
      .post('/request/fanout')
      .send({ ...body, desiredState: status.body.desiredState });
    assert.strictEqual(retry.body.status, 'remove_pending');
    assert.strictEqual(retry.body.desiredState, 'absent');
  });

  it('reconciles a legacy unseen-title row without replacing another media type', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const owner = (
      await demo.get('/request/fanout/status?mediaType=movie&tmdbId=999125')
    ).body.owner;
    await datasource.query(
      `insert into media_fanout_intent
       (requestId, mediaType, app, tmdbId, owner, source, status)
       values(?, ?, ?, ?, ?, ?, ?)`,
      [-999125, 'movie', 'radarr', 999125, owner, 'seerr-ui', 'fulfilled']
    );
    const existing = await demo
      .post('/request/fanout')
      .send({ mediaType: 'movie', tmdbId: 999125, desiredState: 'absent' });
    const tv = await demo
      .post('/request/fanout')
      .send({ mediaType: 'tv', tmdbId: 999125, desiredState: 'present' });
    assert.strictEqual(existing.body.status, 'remove_pending');
    assert.strictEqual(tv.body.status, 'pending');
    const rows = await datasource.query(
      'select mediaType, requestId from media_fanout_intent where owner = ?',
      [owner]
    );
    assert.strictEqual(rows.length, 2);
    assert.ok(
      rows.some(
        (row: { mediaType: string; requestId: number }) =>
          row.mediaType === 'movie' && row.requestId === -999125
      )
    );
  });

  it('does not create an intent for repeated absent requests on missing media', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const body = { mediaType: 'movie', tmdbId: 999126, desiredState: 'absent' };
    const first = await demo.post('/request/fanout').send(body);
    const retry = await demo.post('/request/fanout').send(body);
    assert.strictEqual(first.body.status, 'missing');
    assert.strictEqual(retry.body.status, 'missing');
    assert.strictEqual(
      (
        await datasource.query(
          'select id from media_fanout_intent where owner = ?',
          [first.body.owner]
        )
      ).length,
      0
    );
  });

  it('honors explicit removal on retry and allows explicit cancellation', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const body = {
      mediaType: 'movie',
      tmdbId: 999124,
      desiredState: 'present',
    };
    const added = await demo.post('/request/fanout').send(body);
    assert.strictEqual(added.body.status, 'pending');
    await datasource.query(
      'update media_fanout_intent set status = ? where requestId = ?',
      ['fulfilled', added.body.requestId]
    );
    const removal = await demo
      .post('/request/fanout')
      .send({ ...body, desiredState: 'absent' });
    assert.strictEqual(removal.body.status, 'remove_pending');
    const retry = await demo
      .post('/request/fanout')
      .send({ ...body, desiredState: 'absent' });
    assert.strictEqual(retry.body.status, 'remove_pending');
    const cancel = await demo.post('/request/fanout').send(body);
    assert.strictEqual(cancel.body.status, 'fulfilled');
    assert.strictEqual(
      (
        await demo
          .post('/request/fanout')
          .send({ ...body, desiredState: 'invalid' })
      ).status,
      400
    );
  });

  it('retries an explicit removal after a failed removal intent', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const body = {
      mediaType: 'movie',
      tmdbId: 999127,
      desiredState: 'present',
    };
    const added = await demo.post('/request/fanout').send(body);
    await datasource.query(
      'update media_fanout_intent set status = ? where requestId = ?',
      ['error', added.body.requestId]
    );
    const retry = await demo
      .post('/request/fanout')
      .send({ ...body, desiredState: 'absent' });
    assert.strictEqual(retry.body.status, 'remove_pending');
  });

  it('does not route a selected-user 4K request through a regular mapping', async () => {
    configureRadarr([
      { id: 1, is4k: true, isDefault: true },
      { id: 42, is4k: false, isDefault: false },
    ]);
    getSettings().sonarr = [];
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    user.permissions |= Permission.REQUEST_4K_MOVIE;
    await getRepository(User).save(user);
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 42,
        users: String(user.id),
        profileId: 7,
      })
    );
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const lookup = await admin.get(
      `/request/destination?mediaType=movie&userId=${user.id}&is4k=true`
    );
    assert.strictEqual(lookup.status, 404);
    const response = await admin.post('/request').send({
      mediaType: 'movie',
      mediaId: 998823,
      userId: user.id,
      is4k: true,
      serverId: 1,
    });
    assert.strictEqual(response.status, 201, JSON.stringify(response.body));
    assert.strictEqual(response.body.serverId, 1);
    const wrongServer = await admin.post('/request').send({
      mediaType: 'movie',
      mediaId: 998824,
      userId: user.id,
      is4k: true,
      serverId: 42,
    });
    assert.strictEqual(wrongServer.status, 400);
  });

  it('uses a mapped profile instead of a posted admin profile', async (t) => {
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    configureRadarr([
      { id: 1, isDefault: true },
      { id: 42, isDefault: false },
    ]);
    getSettings().sonarr = [];
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 42,
        users: String(user.id),
        profileId: 7,
      })
    );
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const response = await admin.post('/request').send({
      mediaType: 'movie',
      mediaId: 998802,
      userId: user.id,
      profileId: 99,
    });
    assert.strictEqual(response.status, 201, JSON.stringify(response.body));
    assert.strictEqual(response.body.profileId, 7);
  });

  it('keeps a regular requester selected profile when mapped', async () => {
    configureRadarr([{ id: 1, isDefault: true }]);
    getSettings().sonarr = [];
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 1,
        users: String(user.id),
        profileId: 7,
      })
    );
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const response = await demo
      .post('/request')
      .send({ mediaType: 'movie', mediaId: 998803, profileId: 9 });
    assert.strictEqual(response.status, 201, JSON.stringify(response.body));
    assert.strictEqual(response.body.profileId, 9);
  });
  it('isolates a self-service intent by owner and toggles removal', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const body = { mediaType: 'movie', tmdbId: 987654 };
    const added = await demo.post('/request/fanout').send(body);
    assert.strictEqual(added.status, 200);
    assert.strictEqual(added.body.status, 'pending');
    assert.ok(added.body.requestId < 0);
    const other = await admin.get(
      '/request/fanout/status?mediaType=movie&tmdbId=987654'
    );
    assert.strictEqual(other.body.status, 'missing');
    const rows = await datasource.query(
      'select * from media_fanout_intent where owner = ?',
      [added.body.owner]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].source, 'seerr-ui');
    await datasource.query(
      'update media_fanout_intent set status = ? where id = ?',
      ['fulfilled', rows[0].id]
    );
    const removed = await demo.post('/request/fanout').send(body);
    assert.strictEqual(removed.body.status, 'remove_pending');
    const cancelled = await demo.post('/request/fanout').send(body);
    assert.strictEqual(cancelled.body.status, 'fulfilled');
  });

  it('rejects another owner for a regular user and lists statuses for a manager', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const target = (await admin.get('/request/fanout/owners')).body.owners.find(
      (u: { owner: string }) => u.owner === 'admin'
    );
    assert.ok(target);
    assert.strictEqual(
      (
        await demo
          .post('/request/fanout')
          .send({ mediaType: 'movie', tmdbId: 87234, owner: target.owner })
      ).status,
      403
    );
    assert.strictEqual((await demo.get('/request/fanout/owners')).status, 403);
    assert.strictEqual(
      (
        await admin
          .post('/request/fanout')
          .send({ mediaType: 'movie', tmdbId: 87234, owner: target.owner })
      ).status,
      200
    );
    const listed = await admin.get(
      '/request/fanout/owners?mediaType=movie&tmdbId=87234'
    );
    assert.strictEqual(
      listed.body.owners.find(
        (u: { owner: string }) => u.owner === target.owner
      ).status,
      'pending'
    );
    assert.strictEqual(
      (
        await demo.get(
          '/request/fanout/status?mediaType=movie&tmdbId=87234&owner=' +
            target.owner
        )
      ).status,
      403
    );
  });

  it('uses the selected requester destination when posting a movie request', async (t) => {
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    configureRadarr([
      { id: 1, isDefault: true },
      { id: 42, isDefault: false },
    ]);
    getSettings().sonarr = [];
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 42,
        users: String(user.id),
        profileId: 7,
        rootFolder: '/demo-library',
        tags: '3,5',
      })
    );
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const response = await admin.post('/request').send({
      mediaType: 'movie',
      mediaId: 998801,
      userId: user.id,
      serverId: 1,
      rootFolder: '/wrong',
      tags: [99],
    });
    assert.strictEqual(response.status, 201, JSON.stringify(response.body));
    assert.strictEqual(response.body.serverId, 42);
    assert.strictEqual(response.body.profileId, 7);
    assert.strictEqual(response.body.rootFolder, '/demo-library');
    assert.deepStrictEqual(response.body.tags, [3, 5]);
    assert.strictEqual(response.body.requestedBy.id, user.id);
  });

  it('uses the offset keyspace for known titles and reads a legacy request-backed intent', async () => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 87777,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const added = await demo
      .post('/request/fanout')
      .send({ mediaType: 'movie', tmdbId: media.tmdbId });
    assert.strictEqual(added.status, 200);
    assert.strictEqual(added.body.requestId, 100000000 + media.id);
    await datasource.query(
      'update media_fanout_intent set status = ? where requestId = ?',
      ['fulfilled', added.body.requestId]
    );
    const status = await demo.get(
      `/request/fanout/status?mediaType=movie&tmdbId=${media.tmdbId}`
    );
    assert.strictEqual(status.body.status, 'fulfilled');
    assert.strictEqual(status.body.globallyAvailable, true);
    assert.strictEqual(status.body.removable, true);
  });

  it('updates an existing request-backed row instead of duplicating it', async () => {
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const owner = (
      await demo.get('/request/fanout/status?mediaType=tv&tvdbId=765432')
    ).body.owner;
    await datasource.query(
      `insert into media_fanout_intent
      (requestId, mediaType, app, tvdbId, owner, source, status)
      values(?, ?, ?, ?, ?, ?, ?)`,
      [1234, 'tv', 'sonarr', 765432, owner, 'request', 'fulfilled']
    );
    const removal = await demo
      .post('/request/fanout')
      .send({ mediaType: 'tv', tvdbId: 765432 });
    assert.strictEqual(removal.status, 200);
    assert.strictEqual(removal.body.status, 'remove_pending');
    assert.strictEqual(
      (
        await datasource.query(
          'select id from media_fanout_intent where owner = ?',
          [owner]
        )
      ).length,
      1
    );
  });

  it('resolves the selected requester plain movie override without exposing it to regular users', async () => {
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const demo = await loginAs('demo@seerr.dev', 'test1234');
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 42,
        users: String(user.id),
        profileId: 7,
        rootFolder: '/demo',
        tags: '3, 5',
      })
    );
    const mapped = await admin.get(
      '/request/destination?mediaType=movie&userId=' + user.id
    );
    assert.strictEqual(mapped.status, 200);
    assert.deepStrictEqual(mapped.body, {
      serverId: 42,
      profileId: 7,
      rootFolder: '/demo',
      tags: [3, 5],
    });
    assert.strictEqual(
      (await demo.get('/request/destination?mediaType=movie&userId=' + user.id))
        .status,
      403
    );
    assert.strictEqual(
      (await admin.get('/request/destination?mediaType=movie&userId=0')).status,
      400
    );
  });
});
