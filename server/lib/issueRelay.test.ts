import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import type Issue from '@server/entity/Issue';
import type IssueComment from '@server/entity/IssueComment';
import { levacEventSender } from '@server/lib/levacEvents';
import {
  librarySources,
  resetLibraryAccessCache,
} from '@server/lib/libraryAccess';
import { NOTIFY_CONFIG, writeNotifyConfig } from '@server/test/notifyConfig';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildIssueEvent,
  isPVIBotComment,
  issueRelayInflight,
  issueRelaySettings,
  librariesText,
  problemScope,
  relayIssue,
} from './issueRelay';

// TheMovieDb keeps its methods as instance properties; no network in tests.
Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async () => ({ name: 'Test Show', first_air_date: '2019-01-01' });
  },
  set() {},
  configurable: true,
});

const sections = [
  { key: '1', title: 'Movies-James', owner: 'james' },
  { key: '2', title: 'TV-James', owner: 'james' },
  { key: '3', title: 'TV-Kulpreet', owner: 'kulpreet' },
];
const entries = [
  { section: '2', type: MediaType.TV, tmdbId: 10, tvdbId: 99, addedAt: 1 },
  { section: '3', type: MediaType.TV, tmdbId: 10, tvdbId: 99, addedAt: 1 },
  { section: '1', type: MediaType.MOVIE, tmdbId: 10, addedAt: 1 },
];

describe('problemScope', () => {
  it('uses plain words', () => {
    assert.equal(problemScope(MediaType.MOVIE, 0, 0), 'the whole movie');
    assert.equal(problemScope(MediaType.MOVIE, 2, 5), 'the whole movie');
    assert.equal(problemScope(MediaType.TV, 0, 0), 'the whole show');
    assert.equal(problemScope(MediaType.TV, 2, 0), 'season 2');
    assert.equal(problemScope(MediaType.TV, 2, 5), 'season 2 episode 5');
  });
});

describe('librariesText', () => {
  const show = { type: MediaType.TV, tmdbId: 10, tvdbId: 99 };
  it('lists the libraries that hold the title, by type', () => {
    assert.equal(
      librariesText(sections, entries, null, show),
      'TV-James (owner james), TV-Kulpreet (owner kulpreet)'
    );
    assert.equal(
      librariesText(sections, entries, null, {
        ...show,
        type: MediaType.MOVIE,
      }),
      'Movies-James (owner james)'
    );
  });
  it('only names libraries the reporter can see', () => {
    assert.equal(
      librariesText(sections, entries, new Set(['3']), show),
      'TV-Kulpreet (owner kulpreet)'
    );
  });
  it('matches shows by tvdb id too, and says none found', () => {
    assert.equal(
      librariesText(sections, entries, null, {
        type: MediaType.TV,
        tmdbId: 77,
        tvdbId: 99,
      }),
      'TV-James (owner james), TV-Kulpreet (owner kulpreet)'
    );
    assert.equal(
      librariesText(sections, entries, new Set(), show),
      'none found'
    );
    assert.equal(
      librariesText(sections, entries, null, { type: MediaType.TV, tmdbId: 5 }),
      'none found'
    );
  });
});

describe('isPVIBotComment', () => {
  it('spots the PVIBot prefix', () => {
    assert.ok(isPVIBotComment('PVIBot: replaced the file'));
    assert.ok(isPVIBotComment('  PVIBot: x'));
    assert.ok(!isPVIBotComment('Asking PVIBot: please'));
    assert.ok(!isPVIBotComment(undefined));
  });
});

const reporter = {
  id: 2,
  username: 'Kulpreet',
  displayName: 'Kulpreet K',
  permissions: 0,
};
const admin = {
  id: 1,
  username: 'james',
  displayName: 'James',
  permissions: 2,
};

function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: 7,
    issueType: IssueType.AUDIO,
    problemSeason: 2,
    problemEpisode: 5,
    media: { mediaType: MediaType.TV, tmdbId: 10, tvdbId: 99 },
    createdBy: reporter,
    comments: [{ id: 1, message: 'No English audio', user: reporter }],
    ...over,
  } as unknown as Issue;
}

function comment(id: number, message: string, user: unknown = reporter) {
  return { id, message, user } as unknown as IssueComment;
}

describe('relay', () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const original = { ...levacEventSender };
  const originalSources = { ...librarySources };
  const hadConfig = existsSync(NOTIFY_CONFIG);
  const backup = hadConfig ? readFileSync(NOTIFY_CONFIG, 'utf8') : '';

  const flush = () => Promise.all([...issueRelayInflight]);

  beforeEach(() => {
    posts.length = 0;
    issueRelaySettings.retryDelayMs = 0;
    levacEventSender.post = async (url, body) => {
      posts.push({ url, body: body as Record<string, unknown> });
      return {} as never;
    };
    resetLibraryAccessCache();
    librarySources.loadIndex = async () => ({ sections, entries });
    librarySources.loadShared = async () => new Map([[5, new Set(['3'])]]);
    writeNotifyConfig('http://n8n/seerr/issue');
  });

  afterEach(() => {
    Object.assign(levacEventSender, original);
    Object.assign(librarySources, originalSources);
    resetLibraryAccessCache();
    if (hadConfig) writeFileSync(NOTIFY_CONFIG, backup);
    else rmSync(NOTIFY_CONFIG, { force: true });
  });

  it('builds the flat contract for a new report', async () => {
    const event = await buildIssueEvent('created', makeIssue());
    assert.equal(event.event_type, 'seerr_issue');
    assert.equal(event.action, 'created');
    assert.equal(event.issue_id, 7);
    assert.equal(event.issue_type, 'audio');
    assert.equal(event.problem_scope, 'season 2 episode 5');
    assert.equal(event.message, 'No English audio');
    assert.equal(event.title, 'Test Show');
    assert.equal(event.year, '2019');
    assert.equal(event.media_type, 'tv');
    assert.equal(event.tmdb_id, 10);
    assert.equal(event.tvdb_id, 99);
    assert.equal(event.reported_by, 'Kulpreet K');
    assert.equal(event.reporter_owner, 'kulpreet');
    // Not an admin and no Plex sharing: only their own library is theirs, and
    // the title is not in it.
    assert.equal(event.libraries, 'none found');
    assert.match(String(event.issue_url), /\/issues\/7$/);
    for (const v of Object.values(event))
      assert.ok(typeof v === 'string' || typeof v === 'number');
  });

  it('lists the libraries an admin reporter can see', async () => {
    const event = await buildIssueEvent(
      'created',
      makeIssue({ createdBy: admin } as never)
    );
    assert.equal(
      event.libraries,
      'TV-James (owner james), TV-Kulpreet (owner kulpreet)'
    );
  });

  it('comment events carry the comment text', async () => {
    const event = await buildIssueEvent(
      'comment',
      makeIssue(),
      comment(9, 'Still no English')
    );
    assert.equal(event.message, 'Still no English');
  });

  it('sends created through the events relay, signed', async () => {
    relayIssue('created', makeIssue());
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'http://n8n/seerr/issue');
    assert.equal(posts[0].body.action, 'created');
    assert.ok(posts[0].body.hermes);
  });

  it("relays only the reporter's own comments, never PVIBot's", async () => {
    const issue = makeIssue();
    relayIssue('comment', issue, comment(2, 'PVIBot: swapped the file'));
    relayIssue('comment', issue, comment(3, 'Admin note', admin));
    await flush();
    assert.equal(posts.length, 0);
    relayIssue('comment', issue, comment(4, 'Still broken'));
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.action, 'comment');
    assert.equal(posts[0].body.message, 'Still broken');
  });

  it('sends reopened', async () => {
    relayIssue('reopened', makeIssue());
    await flush();
    assert.equal(posts[0].body.action, 'reopened');
  });

  it('sends nothing without an eventsUrl', async () => {
    writeNotifyConfig(undefined);
    relayIssue('created', makeIssue());
    await flush();
    assert.equal(posts.length, 0);
  });

  it('retries a failed send once, with the same delivery id', async () => {
    let calls = 0;
    levacEventSender.post = async (_url, body) => {
      calls++;
      posts.push({ url: '', body: body as Record<string, unknown> });
      if (calls === 1) throw new Error('n8n down');
      return {} as never;
    };
    relayIssue('created', makeIssue());
    await flush();
    assert.equal(calls, 2);
    const id = (i: number) =>
      (posts[i].body.hermes as { delivery_id: string }).delivery_id;
    assert.match(id(0), /^seerr-issue-7-created-/);
    assert.equal(id(0), id(1));
  });

  it('gives up after the retry and never throws', async () => {
    let calls = 0;
    levacEventSender.post = async () => {
      calls++;
      throw new Error('n8n down');
    };
    relayIssue('created', makeIssue());
    await flush();
    assert.equal(calls, 2);
  });
});
