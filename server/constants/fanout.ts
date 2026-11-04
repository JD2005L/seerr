// What a "My Library" copy is doing, in plain words. Shared by the request
// button and the server's Notify PVIBot message, so both describe it the same way.
// The CT312 media-routing-watchdog does the copying every 2 minutes and writes
// status/lastError back to media_fanout_intent; these helpers only read them.

// A copy or removal still waiting after this long gets the Notify PVIBot option.
export const FANOUT_SLOW_AFTER_SECONDS = 10 * 60;

export type FanoutStage =
  | 'none' // not in this library and nothing asked
  | 'adding' // copy asked for, the worker has not finished yet
  | 'removing' // removal asked for, the worker has not finished yet
  | 'slow' // adding or removing for longer than FANOUT_SLOW_AFTER_SECONDS
  | 'failed' // the worker reported an error
  | 'done'; // in this library

export type FanoutHelpStatus =
  | 'sending'
  | 'sent'
  | 'send_failed'
  | 'investigating'
  | 'resolving'
  | 'resolved'
  | 'needs_james';

// PVIBot reports with these. 'sending', 'sent' and 'send_failed' are Seerr's own.
export const FANOUT_HELP_REPORTS = [
  'investigating',
  'resolving',
  'resolved',
  'needs_james',
] as const;

export interface FanoutHelpNote {
  at: string;
  text: string;
}

export interface FanoutHelp {
  id: number;
  status: FanoutHelpStatus;
  createdAt: string;
  updatedAt: string;
  sendError: string | null;
  notes: FanoutHelpNote[];
}

export interface FanoutFacts {
  status: string;
  desiredState?: 'present' | 'absent';
  lastError?: string | null;
  waitingSeconds?: number | null;
}

// What the person asked for last: present (add) or absent (remove).
export function fanoutWants(facts: FanoutFacts): 'present' | 'absent' {
  if (facts.status === 'remove_pending') return 'absent';
  if (facts.status === 'pending' || facts.status === 'queued') return 'present';
  return facts.desiredState ?? 'present';
}

export function fanoutStage(facts: FanoutFacts): FanoutStage {
  switch (facts.status) {
    case 'fulfilled':
      return 'done';
    case 'error':
      return 'failed';
    case 'pending':
    case 'queued':
    case 'remove_pending':
      if ((facts.waitingSeconds ?? 0) >= FANOUT_SLOW_AFTER_SECONDS)
        return 'slow';
      return facts.status === 'remove_pending' ? 'removing' : 'adding';
    default:
      // missing, removed
      return 'none';
  }
}

// The worker's lastError codes, for people.
export function fanoutReason(lastError?: string | null): string | null {
  const error = (lastError ?? '').trim();
  if (!error) return null;
  if (
    error === 'movie_file_not_available_yet' ||
    error === 'episode_files_not_available_yet'
  )
    return 'No copy of the file has been found to copy from yet.';
  if (error === 'app_item_not_found')
    return 'This title could not be found in Radarr or Sonarr.';
  if (error.startsWith('no_root_for_owner_'))
    return 'This library has no folder set up yet.';
  if (error === 'managed_app_root_removal_requires_explicit_arr_delete')
    return 'This is the library the title was downloaded into, so it cannot be removed from here.';
  if (error === 'dry_run' || error === 'dry_run_remove')
    return 'The copy worker ran in test mode, so nothing was changed.';
  if (/handshake|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timed out/i.test(error))
    return 'The copy worker could not reach the media server.';
  if (error.startsWith('[') || error.startsWith('{'))
    return 'Copying the files failed.';
  return error.length > 160 ? `${error.slice(0, 157)}...` : error;
}

export function waitedFor(seconds?: number | null): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 90) return 'a minute';
  const minutes = Math.round(s / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? 'an hour' : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'a day' : `${days} days`;
}

// One line saying where things stand, as shown in Seerr and sent to PVIBot.
export function fanoutSummary(facts: FanoutFacts, library: string): string {
  const stage = fanoutStage(facts);
  const wants = fanoutWants(facts);
  const reason = fanoutReason(facts.lastError);
  const waited = waitedFor(facts.waitingSeconds);
  switch (stage) {
    case 'done':
      return `In ${library}.`;
    case 'none':
      return `Not in ${library}.`;
    case 'adding':
      return `Being added to ${library}.${reason ? ` Last check: ${reason}` : ''}`;
    case 'removing':
      return `Being removed from ${library}.${reason ? ` Last check: ${reason}` : ''}`;
    case 'slow':
      return `${wants === 'absent' ? 'Removing from' : 'Adding to'} ${library} has not finished after ${waited}.${reason ? ` ${reason}` : ''}`;
    case 'failed':
      return `${wants === 'absent' ? 'Removing from' : 'Adding to'} ${library} failed.${reason ? ` ${reason}` : ''}`;
  }
}

export function helpIsOpen(help?: FanoutHelp | null): boolean {
  return (
    !!help &&
    (help.status === 'sending' ||
      help.status === 'sent' ||
      help.status === 'investigating' ||
      help.status === 'resolving')
  );
}
