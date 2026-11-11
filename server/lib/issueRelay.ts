// Levac fork: Seerr problem reports ("Report an Issue") go to PVIBot, which
// checks the file, fixes it and answers on the issue (fork/seerr-issue-note).
// Called fire-and-forget from server/routes/issue.ts: it never throws and the
// user's request never waits for it.
import { IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import type Issue from '@server/entity/Issue';
import type IssueComment from '@server/entity/IssueComment';
import { currentOwner, titleFor } from '@server/lib/fanout';
import { sendLevacEvent, type LevacEvent } from '@server/lib/levacEvents';
import { libraryAccess, libraryIndex } from '@server/lib/libraryAccess';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

export type IssueAction = 'created' | 'comment' | 'reopened';

const LABEL = 'Issue Relay';

/** Swappable in tests. */
export const issueRelaySettings = { retryDelayMs: 60 * 1000 };

/** PVIBot's own replies, posted through the admin API key, start with this. */
export const PVIBOT_PREFIX = 'PVIBot:';

export function isPVIBotComment(message: string | null | undefined): boolean {
  return (message ?? '').trimStart().startsWith(PVIBOT_PREFIX);
}

const ISSUE_TYPES: Record<number, string> = {
  [IssueType.VIDEO]: 'video',
  [IssueType.AUDIO]: 'audio',
  [IssueType.SUBTITLES]: 'subtitles',
  [IssueType.OTHER]: 'other',
};

export function problemScope(
  mediaType: MediaType,
  season: number,
  episode: number
): string {
  if (mediaType === MediaType.MOVIE) return 'the whole movie';
  if (!season) return 'the whole show';
  return episode ? `season ${season} episode ${episode}` : `season ${season}`;
}

type Section = { key: string; title?: string; owner: string };
type Entry = {
  section: string;
  type: MediaType;
  tmdbId?: number;
  tvdbId?: number;
};

/** "TV-James (owner james), TV-Kulpreet (owner kulpreet)" or "none found". */
export function librariesText(
  sections: Section[],
  entries: Entry[],
  allowed: Set<string> | null,
  title: { type: MediaType; tmdbId?: number | null; tvdbId?: number | null }
): string {
  const holding = new Set(
    entries
      .filter(
        (e) =>
          e.type === title.type &&
          ((!!title.tmdbId && e.tmdbId === title.tmdbId) ||
            (title.type === MediaType.TV &&
              !!title.tvdbId &&
              e.tvdbId === title.tvdbId))
      )
      .map((e) => e.section)
  );
  const names = sections
    .filter((s) => holding.has(s.key) && (!allowed || allowed.has(s.key)))
    .map((s) => `${s.title || `section ${s.key}`} (owner ${s.owner})`);
  return names.length ? names.join(', ') : 'none found';
}

async function librariesFor(issue: Issue): Promise<string> {
  try {
    const [access, index] = await Promise.all([
      libraryAccess(issue.createdBy),
      libraryIndex(),
    ]);
    if (!index) return 'none found';
    return librariesText(
      index.sections,
      index.entries,
      access ? access.sections : null,
      {
        type: issue.media.mediaType,
        tmdbId: issue.media.tmdbId,
        tvdbId: issue.media.tvdbId,
      }
    );
  } catch {
    return 'none found';
  }
}

export async function buildIssueEvent(
  action: IssueAction,
  issue: Issue,
  comment?: IssueComment
): Promise<LevacEvent> {
  const media = issue.media;
  const { title, year } = await titleFor(media.mediaType, media.tmdbId ?? null);
  const first = [...(issue.comments ?? [])].sort((a, b) => a.id - b.id)[0];
  const message = action === 'comment' ? comment?.message : first?.message;
  const base = (getSettings().main.applicationUrl ?? '').replace(/\/+$/, '');
  return {
    event_type: 'seerr_issue',
    action,
    issue_id: issue.id,
    issue_type: ISSUE_TYPES[issue.issueType] ?? 'other',
    problem_scope: problemScope(
      media.mediaType,
      issue.problemSeason,
      issue.problemEpisode
    ),
    message: message ?? '',
    title: title ?? `TMDB ${media.tmdbId ?? '?'}`,
    year: year ?? '',
    media_type: media.mediaType === MediaType.MOVIE ? 'movie' : 'tv',
    tmdb_id: media.tmdbId ?? '',
    tvdb_id: media.tvdbId ?? '',
    reported_by: issue.createdBy.displayName,
    reporter_owner: currentOwner(issue.createdBy),
    libraries: await librariesFor(issue),
    issue_url: `${base}/issues/${issue.id}`,
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function deliver(
  action: IssueAction,
  issue: Issue,
  comment?: IssueComment
): Promise<void> {
  const deliveryId = `seerr-issue-${issue.id}-${action}-${
    comment?.id ?? Date.now()
  }`;
  const event = await buildIssueEvent(action, issue, comment);
  let result = await sendLevacEvent(event, deliveryId);
  if (result.error === 'not set up') {
    logger.debug(`No eventsUrl: issue ${issue.id} (${action}) not relayed`, {
      label: LABEL,
    });
    return;
  }
  if (!result.sent) {
    logger.warn(
      `Issue ${issue.id} (${action}) not sent to PVIBot, retrying: ${result.error}`,
      { label: LABEL, deliveryId }
    );
    await wait(issueRelaySettings.retryDelayMs);
    result = await sendLevacEvent(event, deliveryId);
  }
  if (result.sent)
    logger.info(`Issue ${issue.id} (${action}) sent to PVIBot`, {
      label: LABEL,
      deliveryId,
    });
  else
    logger.error(
      `Issue ${issue.id} (${action}) could not be sent to PVIBot: ${result.error}`,
      { label: LABEL, deliveryId }
    );
}

/** In-flight sends, so tests can wait for them. */
export const issueRelayInflight = new Set<Promise<void>>();

/**
 * Fire and forget. 'comment' relays only the reporter's own comments, and not
 * PVIBot's (its replies start with "PVIBot:"; when the reporter is also the
 * admin that would loop).
 */
export function relayIssue(
  action: IssueAction,
  issue: Issue,
  comment?: IssueComment
): void {
  try {
    if (action === 'comment') {
      if (!comment || isPVIBotComment(comment.message)) return;
      if (!comment.user || comment.user.id !== issue.createdBy?.id) return;
    }
    const job: Promise<void> = deliver(action, issue, comment)
      .catch((e) => {
        logger.error(
          `Issue ${issue.id} (${action}) relay failed: ${e.message}`,
          {
            label: LABEL,
          }
        );
      })
      .finally(() => issueRelayInflight.delete(job));
    issueRelayInflight.add(job);
  } catch (e) {
    logger.error(`Issue relay failed: ${e.message}`, { label: LABEL });
  }
}
