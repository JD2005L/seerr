export type NotifyPromptDecision = 'prompt' | 'subscribe' | 'ios-hint' | 'none';

export type NotifyPromptState = {
  // Browser has service workers, push and notifications, and the server has
  // push registration turned on.
  pushSupported: boolean;
  permission: 'default' | 'granted' | 'denied';
  // This device already has a push subscription that belongs to this person.
  hasSubscription: boolean;
  isIos: boolean;
  isStandalone: boolean;
  // When "Not now" / "Got it" was last pressed on this device (ms), if ever.
  dismissedAt: number | null;
  now: number;
};

export const DISMISS_DAYS = 30;
export const DISMISS_MS = DISMISS_DAYS * 24 * 60 * 60 * 1000;
export const DISMISS_KEY = 'levacNotifyPromptDismissedAt';

export const dismissedRecently = (
  dismissedAt: number | null,
  now: number
): boolean =>
  dismissedAt != null && now >= dismissedAt && now - dismissedAt < DISMISS_MS;

// Decides what to do right after someone asks for something.
export function decideNotifyPrompt(
  state: NotifyPromptState
): NotifyPromptDecision {
  const dismissed = dismissedRecently(state.dismissedAt, state.now);

  // Safari on iPhone/iPad only does web push for sites on the Home Screen.
  if (state.isIos && !state.isStandalone) {
    return dismissed ? 'none' : 'ios-hint';
  }

  if (!state.pushSupported || state.permission === 'denied') return 'none';
  if (state.hasSubscription) return 'none';
  if (state.permission === 'granted') return 'subscribe';
  return dismissed ? 'none' : 'prompt';
}
