import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { issueRelayInflight, issueRelaySettings } from '@server/lib/issueRelay';
import { levacEventSender } from '@server/lib/levacEvents';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { IssueCommentSubscriber } from '@server/subscriber/IssueCommentSubscriber';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import { setupTestDb } from '@server/test/db';
import { NOTIFY_CONFIG, writeNotifyConfig } from '@server/test/notifyConfig';
import {
  assertNoCredentials,
  seedUserSettings,
} from '@server/test/userSettings';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import issueRoutes from './issue';
import issueCommentRoutes from './issueComment';

const sendIssueNotificationMock = mock.method(
  IssueSubscriber.prototype as unknown as {
    sendIssueNotification: (...args: unknown[]) => Promise<void>;
  },
  'sendIssueNotification',
  async () => undefined
).mock;

mock.method(
  IssueCommentSubscriber.prototype as unknown as {
    sendIssueCommentNotification: (...args: unknown[]) => Promise<void>;
  },
  'sendIssueCommentNotification',
  async () => undefined
);

// TheMovieDb keeps its methods as instance properties; no network in tests.
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async () => ({ title: 'Test Movie', release_date: '2020-05-01' });
  },
  set() {},
  configurable: true,
});

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
  app.use('/issue', issueRoutes);
  app.use('/issueComment', issueCommentRoutes);
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
  sendIssueNotificationMock.resetCalls();
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

async function seedMedia() {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

describe('POST /issue', () => {
  it('creates an issue on behalf of the supplied userId', async () => {
    const issueRepo = getRepository(Issue);
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Playback stutters near the end.',
      mediaId: media.id,
      problemSeason: 0,
      problemEpisode: 0,
      userId: friend.id,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.createdBy.email, 'demo@seerr.dev');
    assert.strictEqual(res.body.comments[0].user.email, 'demo@seerr.dev');

    const persisted = await issueRepo.findOneOrFail({
      where: { id: res.body.id },
    });

    assert.strictEqual(persisted.createdBy.id, friend.id);
    assert.strictEqual(persisted.comments[0].user.id, friend.id);
  });

  it('defaults to the authenticated user when userId is omitted', async () => {
    const media = await seedMedia();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.AUDIO,
      message: 'Audio is out of sync.',
      mediaId: media.id,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.createdBy.email, 'admin@seerr.dev');
    assert.strictEqual(res.body.comments[0].user.email, 'admin@seerr.dev');
  });

  it('allows creators to supply their own userId', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.SUBTITLES,
      message: 'Subtitles are missing.',
      mediaId: media.id,
      userId: friend.id,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.createdBy.email, 'demo@seerr.dev');
    assert.strictEqual(res.body.comments[0].user.email, 'demo@seerr.dev');
  });

  it('prevents non-managers from supplying another userId', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.OTHER,
      message: 'Something else is wrong.',
      mediaId: media.id,
      userId: admin.id,
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(
      res.body.message,
      'You do not have permission to create an issue on behalf of another user.'
    );
  });

  it('returns 404 when the supplied userId does not exist', async () => {
    const media = await seedMedia();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.OTHER,
      message: 'Something else is wrong.',
      mediaId: media.id,
      userId: 999999,
    });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.message, 'Issue user not found');
  });
});

describe('GET /issueComment/:commentId', () => {
  it('omits notification settings from the comment author', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await seedUserSettings('demo@seerr.dev');

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const created = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Playback stutters near the end.',
      mediaId: media.id,
      userId: friend.id,
    });
    assert.strictEqual(created.status, 201);

    const res = await agent.get(`/issueComment/${created.body.comments[0].id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.email, 'demo@seerr.dev');
    assert.ok(!('settings' in res.body.user));
    assertNoCredentials(res.body);
  });
});

describe('PVIBot relay', () => {
  const sent: Record<string, unknown>[] = [];
  const original = { ...levacEventSender };
  let failing = false;

  beforeEach(async () => {
    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);
    sent.length = 0;
    failing = false;
    issueRelaySettings.retryDelayMs = 0;
    levacEventSender.post = async (_url, body) => {
      sent.push(body as Record<string, unknown>);
      if (failing) throw new Error('n8n down');
      return {} as never;
    };
  });

  afterEach(() => {
    Object.assign(levacEventSender, original);
    rmSync(NOTIFY_CONFIG, { force: true });
  });

  const flush = () => Promise.all([...issueRelayInflight]);

  it('succeeds and sends nothing when eventsUrl is not set', async () => {
    rmSync(NOTIFY_CONFIG, { force: true });
    const media = await seedMedia();
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Stutters.',
      mediaId: media.id,
    });
    assert.strictEqual(res.status, 201);
    await flush();
    assert.strictEqual(sent.length, 0);
  });

  it('relays created, reporter comments and reopens, not PVIBot or admin comments', async () => {
    writeNotifyConfig('http://n8n/seerr/issue');
    const media = await seedMedia();
    const friend = await loginAs('demo@seerr.dev', 'test1234');
    const created = await friend.post('/issue').send({
      issueType: IssueType.AUDIO,
      message: 'No English audio.',
      mediaId: media.id,
    });
    assert.strictEqual(created.status, 201);
    await flush();
    assert.deepStrictEqual(
      sent.map((e) => [e.action, e.message]),
      [['created', 'No English audio.']]
    );
    assert.strictEqual(sent[0].issue_type, 'audio');
    assert.strictEqual(sent[0].problem_scope, 'the whole movie');

    const id = created.body.id;
    sent.length = 0;
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const comment = (agent: typeof admin, message: string) =>
      agent.post(`/issue/${id}/comment`).send({ message });
    await comment(admin, 'PVIBot: checking');
    await comment(admin, 'Admin chat');
    await comment(friend, 'PVIBot: mine');
    await flush();
    assert.strictEqual(sent.length, 0);

    await comment(friend, 'Still bad');
    await flush();
    assert.deepStrictEqual(
      sent.map((e) => [e.action, e.message]),
      [['comment', 'Still bad']]
    );

    sent.length = 0;
    // Opening an already open issue is not a reopen.
    await admin.post(`/issue/${id}/open`);
    await flush();
    assert.strictEqual(sent.length, 0);
    await admin.post(`/issue/${id}/resolved`);
    await admin.post(`/issue/${id}/open`);
    await flush();
    assert.deepStrictEqual(
      sent.map((e) => e.action),
      ['reopened']
    );
  });

  it('never fails the request when PVIBot is unreachable', async () => {
    writeNotifyConfig('http://n8n/seerr/issue');
    failing = true;
    const media = await seedMedia();
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Stutters.',
      mediaId: media.id,
    });
    assert.strictEqual(res.status, 201);
    await flush();
    assert.strictEqual(sent.length, 2); // first try and the one retry
  });
});
