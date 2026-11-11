// Levac fork: one line saying where a request really is (Media Pipeline).
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CalendarIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/solid';
import type {
  PipelineResult,
  PipelineStatus,
} from '@server/lib/pipelineStatus';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.PipelineStatus', {
  expected: 'Expected {date}',
  percentAt: '{percent}% at {speed}',
  percent: '{percent}%',
});

const FAST_MS = 10_000;
const SLOW_MS = 60_000;

const isMoving = (s: PipelineStatus) =>
  s.stage === 'downloading' ||
  (s.stage === 'transferring' && s.transferProgress != null);

/**
 * Every open request the person can see, from one shared request: each card
 * and page that asks for it gets the same copy, so it is one call per refresh
 * for the whole page. Refreshes every 10 seconds while anything is moving,
 * every minute otherwise.
 */
export function usePipelineStatuses() {
  const { data } = useSWR<PipelineResult>('/api/v1/pipeline', {
    refreshInterval: (latest) =>
      latest?.available && latest.statuses.some(isMoving) ? FAST_MS : SLOW_MS,
    dedupingInterval: 5000,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  return data?.available ? data.statuses : [];
}

export function usePipelineStatus(
  requestId: number | undefined
): PipelineStatus | undefined {
  const all = usePipelineStatuses();
  return requestId == null
    ? undefined
    : all.find((s) => s.requestId === requestId);
}

export const formatSpeed = (bytesPerSecond: number) => {
  const mb = bytesPerSecond / 1_000_000;
  return mb >= 1
    ? `${mb.toFixed(mb >= 10 ? 0 : 1)} MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1000))} KB/s`;
};

const PipelineLine = ({ status }: { status: PipelineStatus }) => {
  const intl = useIntl();
  const copying =
    status.stage === 'transferring' && status.transferProgress != null;
  const fraction = copying ? status.transferProgress : status.progress;
  const speed = copying ? status.transferSpeed : status.speed;
  const showBar =
    !status.unreleased &&
    fraction != null &&
    (status.stage === 'downloading' || copying);
  const percent = showBar
    ? Math.round(Math.min(1, Math.max(0, fraction)) * 100)
    : 0;
  const comesOut = status.comesOut ? new Date(status.comesOut) : null;
  const expected =
    status.unreleased && comesOut && !Number.isNaN(comesOut.getTime())
      ? intl.formatMessage(messages.expected, {
          date: intl.formatDate(comesOut, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          }),
        })
      : null;
  const Icon = status.problem
    ? ExclamationTriangleIcon
    : status.unreleased
      ? CalendarIcon
      : copying
        ? ArrowPathIcon
        : status.stage === 'downloading'
          ? ArrowDownTrayIcon
          : MagnifyingGlassIcon;
  const text = [status.headline, status.detail].filter(Boolean).join(' · ');

  return (
    <div
      className="mt-1 min-w-0 text-xs sm:text-sm"
      data-testid="pipeline-status"
    >
      <div
        className={`flex min-w-0 items-center gap-1.5 ${
          status.problem ? 'text-yellow-400' : 'text-gray-300'
        }`}
      >
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="truncate" title={text}>
          {text}
        </span>
      </div>
      {showBar && (
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-700">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="flex-shrink-0 text-gray-400">
            {speed
              ? intl.formatMessage(messages.percentAt, {
                  percent,
                  speed: formatSpeed(speed),
                })
              : intl.formatMessage(messages.percent, { percent })}
          </span>
        </div>
      )}
      {expected && <div className="mt-0.5 text-gray-400">{expected}</div>}
      {status.problem && (
        <div className="mt-0.5 truncate text-yellow-400" title={status.problem}>
          {status.problem}
        </div>
      )}
      {status.hermes?.note && (
        <div
          className="mt-0.5 truncate text-gray-400"
          title={status.hermes.note}
        >
          PVIBot: {status.hermes.note}
        </div>
      )}
    </div>
  );
};

/** Nothing when the request is finished, declined, not approved, or unknown to the pipeline. */
const PipelineStatusLine = ({ requestId }: { requestId?: number }) => {
  const status = usePipelineStatus(requestId);
  return status ? <PipelineLine status={status} /> : null;
};

/** The same for each of a title's requests (movie and TV pages). */
export const PipelineStatusLines = ({
  requestIds,
}: {
  requestIds: number[];
}) => {
  const all = usePipelineStatuses();
  const mine = all.filter((s) => requestIds.includes(s.requestId));
  if (!mine.length) return null;
  return (
    <div className="mb-2 space-y-1">
      {mine.map((s) => (
        <PipelineLine key={s.requestId} status={s} />
      ))}
    </div>
  );
};

export default PipelineStatusLine;
