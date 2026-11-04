import ButtonWithDropdown from '@app/components/Common/ButtonWithDropdown';
import RequestModal from '@app/components/RequestModal';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChatBubbleLeftEllipsisIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
} from '@heroicons/react/24/outline';
import {
  CheckIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import {
  fanoutStage,
  helpIsOpen,
  type FanoutHelp,
} from '@server/constants/fanout';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';
import {
  desiredFanoutState,
  fanoutInProgress,
  fanoutLabel,
  helpLabel,
  libraryName,
  libraryToastView,
  ownerOptions,
  type FanoutOwner,
  type LibraryWatch,
} from './fanoutOptions';
import { hideLibraryToast, showLibraryToast } from './libraryToast';

// Key for the signed-in person's own library in the per-library maps below.
const SELF = '';

const stageIcon = (entry: FanoutOwner) => {
  switch (fanoutStage(entry)) {
    case 'done':
      return <MinusCircleIcon />;
    case 'adding':
    case 'removing':
      return <ArrowPathIcon className="animate-spin" />;
    case 'slow':
      return <ClockIcon />;
    case 'failed':
      return <ExclamationTriangleIcon />;
    default:
      return <ArrowDownTrayIcon />;
  }
};

const errorText = (error: unknown): string => {
  const data = axios.isAxiosError(error) ? error.response?.data : undefined;
  const message =
    (data as { message?: string } | undefined)?.message ??
    (error as Error)?.message;
  return message
    ? String(message).slice(0, 200)
    : 'Seerr did not answer. Check your connection and try again.';
};

const messages = defineMessages('components.RequestButton', {
  viewrequest: 'View Request',
  viewrequest4k: 'View 4K Request',
  requestmore: 'Request More',
  requestmore4k: 'Request More in 4K',
  approverequest: 'Approve Request',
  approverequest4k: 'Approve 4K Request',
  declinerequest: 'Decline Request',
  declinerequest4k: 'Decline 4K Request',
  approverequests:
    'Approve {requestCount, plural, one {Request} other {{requestCount} Requests}}',
  declinerequests:
    'Decline {requestCount, plural, one {Request} other {{requestCount} Requests}}',
  approve4krequests:
    'Approve {requestCount, plural, one {4K Request} other {{requestCount} 4K Requests}}',
  decline4krequests:
    'Decline {requestCount, plural, one {4K Request} other {{requestCount} 4K Requests}}',
});

interface ButtonOption {
  id: string;
  text: string;
  action: () => void;
  svg?: React.ReactNode;
}

interface RequestButtonProps {
  mediaType: 'movie' | 'tv';
  onUpdate: () => void;
  tmdbId: number;
  media?: Media;
  isShowComplete?: boolean;
  is4kShowComplete?: boolean;
}

const RequestButton = ({
  tmdbId,
  onUpdate,
  media,
  mediaType,
  isShowComplete = false,
  is4kShowComplete = false,
}: RequestButtonProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showRequest4kModal, setShowRequest4kModal] = useState(false);
  const [editRequest, setEditRequest] = useState(false);
  // "My Library": the signed-in person's own entry, from /fanout/status.
  const [selfEntry, setSelfEntry] = useState<FanoutOwner>({
    owner: SELF,
    displayName: '',
    status: 'missing',
  });
  // Everyone else's, for admins, from /fanout/owners.
  const [fanoutOwners, setFanoutOwners] = useState<FanoutOwner[]>([]);
  // Libraries this page is following since the person clicked, by owner.
  const [watched, setWatched] = useState<Record<string, LibraryWatch>>({});
  const [busy, setBusy] = useState<Record<string, 'saving' | 'notifying'>>({});
  const isAvailable = media?.status === MediaStatus.AVAILABLE;
  const canManageOwners = hasPermission(
    [Permission.ADMIN, Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
    { type: 'or' }
  );
  const fanoutQuery = `mediaType=${mediaType}&tmdbId=${tmdbId}`;

  const entryFor = useCallback(
    (key: string): FanoutOwner | undefined =>
      key === SELF
        ? selfEntry
        : fanoutOwners.find((entry) => entry.owner === key),
    [selfEntry, fanoutOwners]
  );
  const nameFor = useCallback(
    (key: string) =>
      libraryName(key === SELF ? undefined : entryFor(key)?.displayName),
    [entryFor]
  );
  // Toast buttons outlive the render that drew them; read live state through these.
  const latest = useRef({ entryFor, watched });
  latest.current = { entryFor, watched };

  const refresh = useCallback(async () => {
    try {
      const { data } = await axios.get<FanoutOwner>(
        `/api/v1/request/fanout/status?${fanoutQuery}`
      );
      setSelfEntry({ ...data, owner: SELF, displayName: '' });
      if (canManageOwners) {
        const owners = await axios.get<{ owners: FanoutOwner[] }>(
          `/api/v1/request/fanout/owners?${fanoutQuery}`
        );
        setFanoutOwners(owners.data.owners);
      }
    } catch {
      // Keep what is shown; the next poll or click tries again.
    }
  }, [fanoutQuery, canManageOwners]);

  useEffect(() => {
    if (!isAvailable || !user) return;
    void refresh();
  }, [isAvailable, user, refresh]);

  // Poll quickly while something this page asked for is still moving, slowly
  // while anything else is, and not at all otherwise.
  const allEntries = useMemo(
    () => [selfEntry, ...fanoutOwners],
    [selfEntry, fanoutOwners]
  );
  const pollEvery = useMemo(() => {
    const following = Object.keys(watched).some((key) => {
      const entry = entryFor(key);
      return (
        !!busy[key] ||
        (!!entry &&
          (fanoutInProgress(fanoutStage(entry)) || helpIsOpen(entry.help)))
      );
    });
    if (following) return 5000;
    return allEntries.some((entry) => {
      const stage = fanoutStage(entry);
      return stage === 'adding' || stage === 'removing';
    })
      ? 30000
      : 0;
  }, [watched, busy, entryFor, allEntries]);

  useEffect(() => {
    if (!isAvailable || !user || !pollEvery) return;
    const interval = setInterval(() => void refresh(), pollEvery);
    return () => clearInterval(interval);
  }, [isAvailable, user, pollEvery, refresh]);

  const watch = (key: string, change: Partial<LibraryWatch>) =>
    setWatched((current) => ({
      ...current,
      [key]: { ...(current[key] ?? { wants: 'present' }), ...change },
    }));
  const unwatch = (key: string) =>
    setWatched((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  const setBusyFor = (key: string, state?: 'saving' | 'notifying') =>
    setBusy((current) => {
      const next = { ...current };
      if (state) next[key] = state;
      else delete next[key];
      return next;
    });

  const toggleLibrary = async (key: string, wants?: 'present' | 'absent') => {
    const entry = latest.current.entryFor(key);
    const nextIntent =
      wants ??
      desiredFanoutState(entry?.status ?? 'missing', entry?.desiredState);
    watch(key, {
      wants: nextIntent,
      saveError: null,
      helpError: null,
      helped: false,
    });
    setBusyFor(key, 'saving');
    try {
      await axios.post('/api/v1/request/fanout', {
        mediaType,
        tmdbId,
        desiredState: nextIntent,
        ...(key === SELF ? {} : { owner: key }),
      });
      await refresh();
      onUpdate();
    } catch (error) {
      watch(key, { saveError: errorText(error) });
    } finally {
      setBusyFor(key);
    }
  };

  // Clicking a library entry: add, remove or retry, or, while it is still
  // running, show where it is instead of asking again.
  const libraryClick = (key: string) => {
    if (busy[key]) return;
    const entry = entryFor(key);
    if (entry && fanoutInProgress(fanoutStage(entry))) {
      watch(key, {
        wants: entry.status === 'remove_pending' ? 'absent' : 'present',
      });
      void refresh();
      return;
    }
    void toggleLibrary(key);
  };

  const notifyPvibot = async (key: string) => {
    if (busy[key]) return;
    const current = latest.current.watched[key];
    const entry = latest.current.entryFor(key);
    watch(key, {
      wants:
        current?.wants ??
        (entry?.status === 'remove_pending' ||
        (entry?.status === 'error' && entry.desiredState === 'absent')
          ? 'absent'
          : 'present'),
      helped: true,
      helpError: null,
    });
    setBusyFor(key, 'notifying');
    try {
      const { data } = await axios.post<{ help: FanoutHelp }>(
        '/api/v1/request/fanout/help',
        {
          mediaType,
          tmdbId,
          ...(key === SELF ? {} : { owner: key }),
          ...(current?.saveError ? { clientError: current.saveError } : {}),
        }
      );
      // The add/remove error is now with PVIBot; follow its reply instead.
      watch(key, { saveError: null });
      const withHelp = (item: FanoutOwner) => ({ ...item, help: data.help });
      if (key === SELF) setSelfEntry(withHelp);
      else
        setFanoutOwners((owners) =>
          owners.map((item) => (item.owner === key ? withHelp(item) : item))
        );
      await refresh();
    } catch (error) {
      watch(key, { helpError: errorText(error) });
    } finally {
      setBusyFor(key);
    }
  };

  // Keep each followed library's live message in step with what the server says.
  const toastId = (key: string) =>
    `fanout-${mediaType}-${tmdbId}-${key || 'self'}`;
  useEffect(() => {
    for (const [key, following] of Object.entries(watched)) {
      const entry = entryFor(key);
      if (!entry) continue;
      const view = libraryToastView(entry, following, busy[key], nameFor(key));
      showLibraryToast(toastId(key), view, {
        onRetry: () => void toggleLibrary(key, following.wants),
        onNotify: () => void notifyPvibot(key),
        onDismiss: () => unwatch(key),
      });
      if (view.final) unwatch(key);
    }
    // toggleLibrary/notifyPvibot read live state through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched, busy, entryFor, nameFor]);

  // Leaving the page: drop messages still waiting on this page's polling.
  useEffect(
    () => () => {
      for (const key of Object.keys(latest.current.watched))
        hideLibraryToast(toastId(key));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tmdbId, mediaType]
  );

  // All pending requests
  const activeRequests = media?.requests.filter(
    (request) => request.status === MediaRequestStatus.PENDING && !request.is4k
  );
  const active4kRequests = media?.requests.filter(
    (request) => request.status === MediaRequestStatus.PENDING && request.is4k
  );

  // Current user's pending request, or the first pending request
  const activeRequest = useMemo(() => {
    return activeRequests && activeRequests.length > 0
      ? (activeRequests.find(
          (request) => request.requestedBy.id === user?.id
        ) ?? activeRequests[0])
      : undefined;
  }, [activeRequests, user]);
  const active4kRequest = useMemo(() => {
    return active4kRequests && active4kRequests.length > 0
      ? (active4kRequests.find(
          (request) => request.requestedBy.id === user?.id
        ) ?? active4kRequests[0])
      : undefined;
  }, [active4kRequests, user]);

  const modifyRequest = async (
    request: MediaRequest,
    type: 'approve' | 'decline'
  ) => {
    const response = await axios.post(`/api/v1/request/${request.id}/${type}`);

    if (response) {
      onUpdate();
      mutate('/api/v1/request/count');
    }
  };

  const modifyRequests = async (
    requests: MediaRequest[],
    type: 'approve' | 'decline'
  ): Promise<void> => {
    if (!requests) {
      return;
    }

    await Promise.all(
      requests.map(async (request) => {
        return axios.post(`/api/v1/request/${request.id}/${type}`);
      })
    );

    onUpdate();
    mutate('/api/v1/request/count');
  };

  const buttons: ButtonOption[] = [];

  // If there are pending requests, show request management options first
  if (activeRequest || active4kRequest) {
    if (
      activeRequest &&
      (activeRequest.requestedBy.id === user?.id ||
        (activeRequests?.length === 1 &&
          hasPermission(Permission.MANAGE_REQUESTS)))
    ) {
      buttons.push({
        id: 'active-request',
        text: intl.formatMessage(messages.viewrequest),
        action: () => {
          setEditRequest(true);
          setShowRequestModal(true);
        },
        svg: <InformationCircleIcon />,
      });
    }

    if (
      activeRequest &&
      hasPermission(Permission.MANAGE_REQUESTS) &&
      mediaType === 'movie'
    ) {
      buttons.push(
        {
          id: 'approve-request',
          text: intl.formatMessage(messages.approverequest),
          action: () => {
            modifyRequest(activeRequest, 'approve');
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-request',
          text: intl.formatMessage(messages.declinerequest),
          action: () => {
            modifyRequest(activeRequest, 'decline');
          },
          svg: <XMarkIcon />,
        }
      );
    } else if (
      activeRequests &&
      activeRequests.length > 0 &&
      hasPermission(Permission.MANAGE_REQUESTS) &&
      mediaType === 'tv'
    ) {
      buttons.push(
        {
          id: 'approve-request-batch',
          text: intl.formatMessage(messages.approverequests, {
            requestCount: activeRequests.length,
          }),
          action: () => {
            modifyRequests(activeRequests, 'approve');
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-request-batch',
          text: intl.formatMessage(messages.declinerequests, {
            requestCount: activeRequests.length,
          }),
          action: () => {
            modifyRequests(activeRequests, 'decline');
          },
          svg: <XMarkIcon />,
        }
      );
    }

    if (
      active4kRequest &&
      (active4kRequest.requestedBy.id === user?.id ||
        (active4kRequests?.length === 1 &&
          hasPermission(Permission.MANAGE_REQUESTS)))
    ) {
      buttons.push({
        id: 'active-4k-request',
        text: intl.formatMessage(messages.viewrequest4k),
        action: () => {
          setEditRequest(true);
          setShowRequest4kModal(true);
        },
        svg: <InformationCircleIcon />,
      });
    }

    if (
      active4kRequest &&
      hasPermission(Permission.MANAGE_REQUESTS) &&
      mediaType === 'movie'
    ) {
      buttons.push(
        {
          id: 'approve-4k-request',
          text: intl.formatMessage(messages.approverequest4k),
          action: () => {
            modifyRequest(active4kRequest, 'approve');
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-4k-request',
          text: intl.formatMessage(messages.declinerequest4k),
          action: () => {
            modifyRequest(active4kRequest, 'decline');
          },
          svg: <XMarkIcon />,
        }
      );
    } else if (
      active4kRequests &&
      active4kRequests.length > 0 &&
      hasPermission(Permission.MANAGE_REQUESTS) &&
      mediaType === 'tv'
    ) {
      buttons.push(
        {
          id: 'approve-4k-request-batch',
          text: intl.formatMessage(messages.approve4krequests, {
            requestCount: active4kRequests.length,
          }),
          action: () => {
            modifyRequests(active4kRequests, 'approve');
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-4k-request-batch',
          text: intl.formatMessage(messages.decline4krequests, {
            requestCount: active4kRequests.length,
          }),
          action: () => {
            modifyRequests(active4kRequests, 'decline');
          },
          svg: <XMarkIcon />,
        }
      );
    }
  }

  // Standard request button
  if (
    (!media ||
      media.status === MediaStatus.UNKNOWN ||
      (media.status === MediaStatus.DELETED && !activeRequest)) &&
    hasPermission(
      [
        Permission.REQUEST,
        mediaType === 'movie'
          ? Permission.REQUEST_MOVIE
          : Permission.REQUEST_TV,
      ],
      { type: 'or' }
    )
  ) {
    buttons.push({
      id: 'request',
      text: intl.formatMessage(globalMessages.request),
      action: () => {
        setEditRequest(false);
        setShowRequestModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  } else if (
    mediaType === 'tv' &&
    (!activeRequest || activeRequest.requestedBy.id !== user?.id) &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_TV], {
      type: 'or',
    }) &&
    media &&
    media.status !== MediaStatus.BLOCKLISTED &&
    !isShowComplete
  ) {
    buttons.push({
      id: 'request-more',
      text: intl.formatMessage(messages.requestmore),
      action: () => {
        setEditRequest(false);
        setShowRequestModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  }

  // 4K request button
  if (
    (!media ||
      media.status4k === MediaStatus.UNKNOWN ||
      (media.status4k === MediaStatus.DELETED && !active4kRequest)) &&
    hasPermission(
      [
        Permission.REQUEST_4K,
        mediaType === 'movie'
          ? Permission.REQUEST_4K_MOVIE
          : Permission.REQUEST_4K_TV,
      ],
      { type: 'or' }
    ) &&
    ((settings.currentSettings.movie4kEnabled && mediaType === 'movie') ||
      (settings.currentSettings.series4kEnabled && mediaType === 'tv'))
  ) {
    buttons.push({
      id: 'request4k',
      text: intl.formatMessage(globalMessages.request4k),
      action: () => {
        setEditRequest(false);
        setShowRequest4kModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  } else if (
    mediaType === 'tv' &&
    (!active4kRequest || active4kRequest.requestedBy.id !== user?.id) &&
    hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
      type: 'or',
    }) &&
    media &&
    media.status4k !== MediaStatus.BLOCKLISTED &&
    !is4kShowComplete &&
    settings.currentSettings.series4kEnabled
  ) {
    buttons.push({
      id: 'request-more-4k',
      text: intl.formatMessage(messages.requestmore4k),
      action: () => {
        setEditRequest(false);
        setShowRequest4kModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  }

  if (isAvailable && user) {
    const libraryButtons = (key: string, entry: FanoutOwner, label: string) => {
      const name = nameFor(key);
      buttons.push({
        id: key === SELF ? 'fanout-self' : `fanout-${key}`,
        text:
          busy[key] === 'saving'
            ? watched[key]?.wants === 'absent'
              ? `Removing from ${name.label}...`
              : `Adding to ${name.label}...`
            : label,
        action: () => libraryClick(key),
        svg: busy[key] ? (
          <ArrowPathIcon className="animate-spin" />
        ) : (
          stageIcon(entry)
        ),
      });
      const notify = helpLabel(entry, name.label, !!watched[key]?.saveError);
      if (notify)
        buttons.push({
          id: key === SELF ? 'fanout-help-self' : `fanout-help-${key}`,
          text: busy[key] === 'notifying' ? 'Telling PVIBot...' : notify,
          action: () =>
            helpIsOpen(entry.help)
              ? watch(key, { helped: true })
              : void notifyPvibot(key),
          svg: <ChatBubbleLeftEllipsisIcon />,
        });
    };
    libraryButtons(SELF, selfEntry, fanoutLabel(selfEntry));
    if (canManageOwners) {
      ownerOptions(
        fanoutOwners,
        user.username || user.email || String(user.id)
      ).forEach((option) => {
        const entry = entryFor(option.owner);
        if (entry) libraryButtons(option.owner, entry, option.label);
      });
    }
  }

  const [buttonOne, ...others] = buttons;

  if (!buttonOne) {
    return null;
  }

  return (
    <>
      <RequestModal
        tmdbId={tmdbId}
        show={showRequestModal}
        type={mediaType}
        editRequest={editRequest ? activeRequest : undefined}
        onComplete={() => {
          onUpdate();
          setShowRequestModal(false);
        }}
        onCancel={() => setShowRequestModal(false)}
      />
      <RequestModal
        tmdbId={tmdbId}
        show={showRequest4kModal}
        type={mediaType}
        editRequest={editRequest ? active4kRequest : undefined}
        is4k
        onComplete={() => {
          onUpdate();
          setShowRequest4kModal(false);
        }}
        onCancel={() => setShowRequest4kModal(false)}
      />
      <ButtonWithDropdown
        text={
          <>
            {buttonOne.svg}
            <span>{buttonOne.text}</span>
          </>
        }
        onClick={buttonOne.action}
        className="ml-2"
      >
        {others && others.length > 0
          ? others.map((button) => (
              <ButtonWithDropdown.Item
                onClick={button.action}
                key={`request-option-${button.id}`}
              >
                {button.svg}
                <span>{button.text}</span>
              </ButtonWithDropdown.Item>
            ))
          : null}
      </ButtonWithDropdown>
    </>
  );
};

export default RequestButton;
