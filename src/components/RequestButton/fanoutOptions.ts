import {
  fanoutReason,
  fanoutStage,
  fanoutWants,
  helpIsOpen,
  waitedFor,
  type FanoutHelp,
  type FanoutStage,
} from '@server/constants/fanout';

export type FanoutOwner = {
  owner: string;
  displayName: string;
  status: string;
  desiredState?: 'present' | 'absent';
  lastError?: string | null;
  requestedAt?: string | null;
  waitingSeconds?: number | null;
  help?: FanoutHelp | null;
};

export function normalizeOwnerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function desiredFanoutState(
  status: string,
  lastIntent: 'present' | 'absent' = 'present'
): 'present' | 'absent' {
  if (status === 'error') return lastIntent;
  return status === 'fulfilled' || status === 'remove_pending'
    ? 'absent'
    : 'present';
}

// "My Library" for the person's own, "William's Library" for anyone else's.
// label is for menus, text for sentences.
export type LibraryName = { label: string; text: string };

export function libraryName(displayName?: string): LibraryName {
  return displayName
    ? { label: `${displayName}'s Library`, text: `${displayName}'s library` }
    : { label: 'My Library', text: 'your library' };
}

type Facts = Pick<
  FanoutOwner,
  'status' | 'desiredState' | 'lastError' | 'waitingSeconds'
>;

// Still running: clicking shows where it is instead of asking again.
export function fanoutInProgress(stage: FanoutStage): boolean {
  return stage === 'adding' || stage === 'removing' || stage === 'slow';
}

export function fanoutLabel(entry: Facts, library = 'My Library'): string {
  const wants = fanoutWants(entry);
  switch (fanoutStage(entry)) {
    case 'done':
      return `Remove from ${library}`;
    case 'adding':
      return `Adding to ${library}...`;
    case 'removing':
      return `Removing from ${library}...`;
    case 'slow':
      return wants === 'absent'
        ? `Still Removing from ${library}...`
        : `Still Adding to ${library}...`;
    case 'failed':
      return wants === 'absent'
        ? `Retry Removal from ${library}`
        : `Retry Adding to ${library}`;
    default:
      return `Add to ${library}`;
  }
}

// The Notify PVIBot menu entry, when there is something to tell it about.
export function helpLabel(
  entry: Facts & Pick<FanoutOwner, 'help'>,
  library = 'My Library',
  saveFailed = false
): string | null {
  if (helpIsOpen(entry.help)) return `PVIBot Is Looking at ${library}`;
  const stage = fanoutStage(entry);
  return saveFailed || stage === 'failed' || stage === 'slow'
    ? `Notify PVIBot About ${library}`
    : null;
}

export function ownerOptions(
  owners: FanoutOwner[],
  username: string
): { owner: string; label: string }[] {
  return owners
    .filter(
      (entry) => entry.owner && entry.owner !== normalizeOwnerName(username)
    )
    .map((entry) => ({
      owner: entry.owner,
      label: fanoutLabel(entry, libraryName(entry.displayName).label),
    }));
}

// What this page is following for one library since the person clicked.
export type LibraryWatch = {
  wants: 'present' | 'absent';
  // The add/remove request itself failed; there may be no intent row.
  saveError?: string | null;
  // Notify PVIBot itself failed to reach Seerr.
  helpError?: string | null;
  // Notify PVIBot was pressed on this page.
  helped?: boolean;
};

export type LibraryToastView = {
  appearance: 'success' | 'error' | 'info' | 'warning';
  title: string;
  detail?: string | null;
  notes?: string[];
  busy?: boolean;
  actions?: ('retry' | 'notify')[];
  duration?: number;
  // Finished: stop following it once shown.
  final?: boolean;
};

const DONE_SHOWN_MS = 10000;

export function libraryToastView(
  entry: FanoutOwner,
  watch: LibraryWatch,
  busy: 'saving' | 'notifying' | undefined,
  library: LibraryName
): LibraryToastView {
  const text = library.text;
  const adding = watch.wants === 'present';
  const stage = fanoutStage(entry);
  const reason = fanoutReason(entry.lastError);
  const help = entry.help;
  const notes = (help?.notes ?? []).slice(-3).map((note) => note.text);

  if (busy === 'saving')
    return {
      appearance: 'info',
      busy: true,
      title: adding ? `Adding to ${text}...` : `Removing from ${text}...`,
    };
  if (busy === 'notifying')
    return { appearance: 'info', busy: true, title: 'Telling PVIBot...' };
  if (watch.helpError)
    return {
      appearance: 'error',
      title: 'PVIBot could not be reached.',
      detail: `${watch.helpError} Let James know.`,
      actions: ['notify'],
    };

  if (adding && stage === 'done')
    return {
      appearance: 'success',
      title: `Added to ${text}.`,
      detail: notes.length
        ? null
        : 'It shows up in Plex within a minute or two.',
      notes,
      duration: DONE_SHOWN_MS,
      final: true,
    };
  if (!adding && stage === 'none' && !watch.saveError)
    return {
      appearance: 'success',
      title: `Removed from ${text}.`,
      notes,
      duration: DONE_SHOWN_MS,
      final: true,
    };

  if (help && (watch.helped || helpIsOpen(help)))
    switch (help.status) {
      case 'sending':
        return { appearance: 'info', busy: true, title: 'Telling PVIBot...' };
      case 'send_failed':
        return {
          appearance: 'error',
          title: 'PVIBot could not be reached.',
          detail: `${help.sendError ?? ''} Let James know.`.trim(),
          actions: ['notify'],
        };
      case 'sent':
        return {
          appearance: 'info',
          title: 'PVIBot has been told.',
          detail:
            'It will look into it and message James. Its progress shows here.',
        };
      case 'investigating':
      case 'resolving':
        return {
          appearance: 'info',
          busy: true,
          title: 'PVIBot is working on it.',
          notes,
        };
      case 'resolved':
        return {
          appearance: 'success',
          title: 'PVIBot says it is fixed.',
          notes,
          duration: DONE_SHOWN_MS * 2,
        };
      case 'needs_james':
        return {
          appearance: 'warning',
          title: 'PVIBot needs James for this one.',
          notes,
        };
    }

  if (watch.saveError)
    return {
      appearance: 'error',
      title: adding
        ? `Could not add it to ${text}.`
        : `Could not remove it from ${text}.`,
      detail: watch.saveError,
      actions: ['retry', 'notify'],
    };

  switch (stage) {
    case 'adding':
      return {
        appearance: 'info',
        busy: true,
        title: `Adding to ${text}...`,
        detail: reason
          ? `Last check: ${reason}`
          : 'This usually takes a few minutes. You can leave this page.',
      };
    case 'removing':
      return {
        appearance: 'info',
        busy: true,
        title: `Removing from ${text}...`,
        detail: reason
          ? `Last check: ${reason}`
          : 'This usually takes a few minutes. You can leave this page.',
      };
    case 'slow':
      return {
        appearance: 'warning',
        title: adding
          ? `Still not in ${text} after ${waitedFor(entry.waitingSeconds)}.`
          : `Still in ${text} after ${waitedFor(entry.waitingSeconds)}.`,
        detail: reason ?? 'The copy worker has not finished it.',
        actions: ['notify'],
      };
    case 'failed':
      return {
        appearance: 'error',
        title: adding
          ? `Could not add it to ${text}.`
          : `Could not remove it from ${text}.`,
        detail: reason,
        actions: ['retry', 'notify'],
      };
    case 'done':
      return {
        appearance: 'info',
        title: `Still in ${text}.`,
        duration: DONE_SHOWN_MS,
        final: true,
      };
    default:
      return {
        appearance: 'warning',
        title: `Not in ${text} yet, and nothing is queued.`,
        detail: 'Try again, or tell PVIBot.',
        actions: ['retry', 'notify'],
      };
  }
}
