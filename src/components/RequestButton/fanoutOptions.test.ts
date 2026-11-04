import type { FanoutHelp } from '@server/constants/fanout';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  desiredFanoutState,
  fanoutLabel,
  helpLabel,
  libraryName,
  libraryToastView,
  ownerOptions,
} from './fanoutOptions';

const william = libraryName('William');

const help = (status: FanoutHelp['status'], notes: string[] = []) => ({
  id: 7,
  status,
  createdAt: '2026-11-03T21:00:00.000Z',
  updatedAt: '2026-11-03T21:00:00.000Z',
  sendError: status === 'send_failed' ? 'PVIBot could not be reached.' : null,
  notes: notes.map((text) => ({ at: '2026-11-03T21:01:00.000Z', text })),
});

describe('fan-out actions', () => {
  it('permits a fulfilled library to be removed and a removal to be cancelled', () => {
    assert.strictEqual(
      fanoutLabel({ status: 'fulfilled' }),
      'Remove from My Library'
    );
    assert.strictEqual(
      fanoutLabel({ status: 'remove_pending' }),
      'Removing from My Library...'
    );
    assert.strictEqual(
      fanoutLabel({ status: 'pending' }),
      'Adding to My Library...'
    );
  });
  it('labels pending removal as in progress for another owner', () => {
    assert.deepStrictEqual(
      ownerOptions(
        [{ owner: 'friend', displayName: 'Friend', status: 'remove_pending' }],
        'admin'
      ),
      [{ owner: 'friend', label: "Removing from Friend's Library..." }]
    );
  });
  it('excludes self by normalized owner and names owner-specific removal', () => {
    const owners = [
      { owner: 'james-levac', displayName: 'James', status: 'fulfilled' },
      { owner: 'friend', displayName: 'Friend', status: 'fulfilled' },
    ];
    assert.deepStrictEqual(ownerOptions(owners, 'James LeVAc'), [
      { owner: 'friend', label: "Remove from Friend's Library" },
    ]);
  });
  it('never offers Add for a library that is already queued', () => {
    // The 2026-11-03 report: William's copy had been queued for days and the
    // menu still said "Add to William Library", so clicking did nothing visible.
    const [option] = ownerOptions(
      [
        {
          owner: 'william',
          displayName: 'William',
          status: 'pending',
          lastError: 'movie_file_not_available_yet',
          waitingSeconds: 5 * 24 * 3600,
        },
      ],
      'james'
    );
    assert.strictEqual(option.label, "Still Adding to William's Library...");
  });
});

it('sends a stable removal intent for fulfilled and removal-pending libraries', () => {
  assert.strictEqual(desiredFanoutState('fulfilled'), 'absent');
  assert.strictEqual(desiredFanoutState('remove_pending'), 'absent');
  assert.strictEqual(desiredFanoutState('missing'), 'present');
});

it('retries failed removal instead of adding it back', () => {
  assert.strictEqual(desiredFanoutState('error', 'absent'), 'absent');
  assert.strictEqual(desiredFanoutState('error', 'present'), 'present');
  assert.deepStrictEqual(
    ownerOptions(
      [
        {
          owner: 'friend',
          displayName: 'Friend',
          status: 'error',
          desiredState: 'absent',
        },
      ],
      'admin'
    ),
    [{ owner: 'friend', label: "Retry Removal from Friend's Library" }]
  );
});

describe('Notify PVIBot menu entry', () => {
  it('appears only for a failed, slow or unsaved change', () => {
    assert.strictEqual(
      helpLabel({ status: 'pending', waitingSeconds: 30 }),
      null
    );
    assert.strictEqual(helpLabel({ status: 'fulfilled' }), null);
    assert.strictEqual(
      helpLabel({ status: 'error' }, william.label),
      "Notify PVIBot About William's Library"
    );
    assert.strictEqual(
      helpLabel({ status: 'pending', waitingSeconds: 11 * 60 }),
      'Notify PVIBot About My Library'
    );
    assert.strictEqual(
      helpLabel({ status: 'missing' }, 'My Library', true),
      'Notify PVIBot About My Library'
    );
  });
  it('says PVIBot is on it instead of offering a second notice', () => {
    assert.strictEqual(
      helpLabel(
        { status: 'error', help: help('investigating') },
        william.label
      ),
      "PVIBot Is Looking at William's Library"
    );
  });
});

describe('live library message', () => {
  const adding = { wants: 'present' as const };

  it('shows work starting the moment the person clicks', () => {
    const view = libraryToastView(
      { owner: 'william', displayName: 'William', status: 'missing' },
      adding,
      'saving',
      william
    );
    assert.strictEqual(view.busy, true);
    assert.strictEqual(view.title, "Adding to William's library...");
  });
  it('keeps showing progress while the worker copies', () => {
    const view = libraryToastView(
      {
        owner: 'william',
        displayName: 'William',
        status: 'pending',
        waitingSeconds: 60,
      },
      adding,
      undefined,
      william
    );
    assert.strictEqual(view.appearance, 'info');
    assert.strictEqual(view.busy, true);
    assert.strictEqual(view.final, undefined);
  });
  it('confirms success and lets the message close itself', () => {
    const view = libraryToastView(
      { owner: 'william', displayName: 'William', status: 'fulfilled' },
      adding,
      undefined,
      william
    );
    assert.strictEqual(view.appearance, 'success');
    assert.strictEqual(view.title, "Added to William's library.");
    assert.strictEqual(view.final, true);
    assert.ok(view.duration && view.duration < Infinity);
  });
  it('offers Notify PVIBot when a copy is stuck, with the reason in plain words', () => {
    const view = libraryToastView(
      {
        owner: 'william',
        displayName: 'William',
        status: 'pending',
        lastError: 'movie_file_not_available_yet',
        waitingSeconds: 5 * 24 * 3600,
      },
      adding,
      undefined,
      william
    );
    assert.strictEqual(view.appearance, 'warning');
    assert.strictEqual(
      view.title,
      "Still not in William's library after 5 days."
    );
    assert.match(view.detail ?? '', /No copy of the file/);
    assert.deepStrictEqual(view.actions, ['notify']);
  });
  it('offers retry and Notify PVIBot when the worker fails or Seerr cannot save', () => {
    assert.deepStrictEqual(
      libraryToastView(
        { owner: 'william', displayName: 'William', status: 'error' },
        adding,
        undefined,
        william
      ).actions,
      ['retry', 'notify']
    );
    const unsaved = libraryToastView(
      { owner: 'william', displayName: 'William', status: 'missing' },
      { ...adding, saveError: 'Unable to process fan-out request.' },
      undefined,
      william
    );
    assert.strictEqual(unsaved.appearance, 'error');
    assert.strictEqual(unsaved.detail, 'Unable to process fan-out request.');
    assert.deepStrictEqual(unsaved.actions, ['retry', 'notify']);
  });
  it("follows PVIBot's reply after Notify PVIBot", () => {
    const stuck = {
      owner: 'william',
      displayName: 'William',
      status: 'error',
    };
    const followed = { ...adding, helped: true };
    assert.strictEqual(
      libraryToastView(
        { ...stuck, help: help('sent') },
        followed,
        undefined,
        william
      ).title,
      'PVIBot has been told.'
    );
    const working = libraryToastView(
      {
        ...stuck,
        help: help('investigating', ["Found the file in James's library"]),
      },
      followed,
      undefined,
      william
    );
    assert.deepStrictEqual(working.notes, [
      "Found the file in James's library",
    ]);
    const failed = libraryToastView(
      { ...stuck, help: help('send_failed') },
      followed,
      undefined,
      william
    );
    assert.strictEqual(failed.appearance, 'error');
    assert.deepStrictEqual(failed.actions, ['notify']);
    // Success wins over PVIBot's last status.
    assert.strictEqual(
      libraryToastView(
        { ...stuck, status: 'fulfilled', help: help('resolving', ['Copied']) },
        followed,
        undefined,
        william
      ).title,
      "Added to William's library."
    );
  });
  it('confirms a removal once the library no longer has it', () => {
    const view = libraryToastView(
      { owner: 'william', displayName: 'William', status: 'removed' },
      { wants: 'absent' },
      undefined,
      william
    );
    assert.strictEqual(view.title, "Removed from William's library.");
    assert.strictEqual(view.final, true);
  });
});
