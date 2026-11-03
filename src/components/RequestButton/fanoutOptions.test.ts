import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { desiredFanoutState, fanoutLabel, ownerOptions } from './fanoutOptions';

describe('fan-out actions', () => {
  it('permits a fulfilled library to be removed and a removal to be cancelled', () => {
    assert.strictEqual(fanoutLabel('fulfilled'), 'Remove from My Library');
    assert.strictEqual(
      fanoutLabel('remove_pending'),
      'Retry Removal from My Library'
    );
    assert.strictEqual(fanoutLabel('pending'), 'Queued for My Library');
  });
  it('labels pending removal as a cancellation for another owner', () => {
    assert.deepStrictEqual(
      ownerOptions(
        [{ owner: 'friend', displayName: 'Friend', status: 'remove_pending' }],
        'admin'
      ),
      [{ owner: 'friend', label: 'Retry Removal from Friend Library' }]
    );
  });
  it('excludes self by normalized owner and names owner-specific removal', () => {
    const owners = [
      { owner: 'james-levac', displayName: 'James', status: 'fulfilled' },
      { owner: 'friend', displayName: 'Friend', status: 'fulfilled' },
    ];
    assert.deepStrictEqual(ownerOptions(owners, 'James LeVAc'), [
      { owner: 'friend', label: 'Remove from Friend Library' },
    ]);
  });
});

it('sends a stable removal intent for fulfilled and removal-pending libraries', () => {
  assert.strictEqual(desiredFanoutState('fulfilled'), 'absent');
  assert.strictEqual(desiredFanoutState('remove_pending'), 'absent');
  assert.strictEqual(desiredFanoutState('missing'), 'present');
});
