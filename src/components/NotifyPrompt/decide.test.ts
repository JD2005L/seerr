import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DISMISS_MS,
  decideNotifyPrompt,
  type NotifyPromptState,
} from './decide';

const now = 1_800_000_000_000;
const base: NotifyPromptState = {
  pushSupported: true,
  permission: 'default',
  hasSubscription: false,
  isIos: false,
  isStandalone: false,
  dismissedAt: null,
  now,
};
const decide = (over: Partial<NotifyPromptState>) =>
  decideNotifyPrompt({ ...base, ...over });

describe('decideNotifyPrompt', () => {
  it('prompts when permission is undecided and nothing is subscribed', () => {
    assert.equal(decide({}), 'prompt');
  });

  it('does nothing when push is not supported', () => {
    assert.equal(decide({ pushSupported: false }), 'none');
  });

  it('never prompts when permission was denied', () => {
    assert.equal(decide({ permission: 'denied' }), 'none');
    assert.equal(decide({ permission: 'denied', dismissedAt: null }), 'none');
  });

  it('does nothing when the device is already subscribed', () => {
    assert.equal(decide({ hasSubscription: true }), 'none');
    assert.equal(
      decide({ hasSubscription: true, permission: 'granted' }),
      'none'
    );
  });

  it('subscribes quietly when granted but not subscribed', () => {
    assert.equal(decide({ permission: 'granted' }), 'subscribe');
  });

  it('quiet subscribe ignores an old "Not now"', () => {
    assert.equal(
      decide({ permission: 'granted', dismissedAt: now - 1000 }),
      'subscribe'
    );
  });

  it('stays quiet for 30 days after "Not now", then asks again', () => {
    assert.equal(decide({ dismissedAt: now - DISMISS_MS + 1 }), 'none');
    assert.equal(decide({ dismissedAt: now - DISMISS_MS }), 'prompt');
  });

  it('treats a dismissal time in the future as expired', () => {
    assert.equal(decide({ dismissedAt: now + 1000 }), 'prompt');
  });

  it('shows the Home Screen hint on iOS outside the installed app', () => {
    assert.equal(decide({ isIos: true, pushSupported: false }), 'ios-hint');
    assert.equal(decide({ isIos: true }), 'ios-hint');
  });

  it('iOS hint respects the 30 day dismissal', () => {
    assert.equal(
      decide({ isIos: true, pushSupported: false, dismissedAt: now - 1000 }),
      'none'
    );
    assert.equal(
      decide({
        isIos: true,
        pushSupported: false,
        dismissedAt: now - DISMISS_MS,
      }),
      'ios-hint'
    );
  });

  it('uses the normal flow on iOS once installed to the Home Screen', () => {
    assert.equal(decide({ isIos: true, isStandalone: true }), 'prompt');
    assert.equal(
      decide({ isIos: true, isStandalone: true, permission: 'granted' }),
      'subscribe'
    );
    assert.equal(
      decide({ isIos: true, isStandalone: true, hasSubscription: true }),
      'none'
    );
  });
});
