export type FanoutOwner = {
  owner: string;
  displayName: string;
  status: string;
  lastError?: string | null;
};
export function normalizeOwnerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
export function fanoutLabel(status: string): string {
  switch (status) {
    case 'fulfilled':
      return 'Remove from My Library';
    case 'remove_pending':
      return 'Cancel Removal from My Library';
    case 'pending':
    case 'queued':
      return 'Queued for My Library';
    case 'error':
      return 'Action Failed - Retry';
    default:
      return 'Add to My Library';
  }
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
      label: `${entry.status === 'remove_pending' ? 'Cancel Removal from' : entry.status === 'fulfilled' ? 'Remove from' : 'Add to'} ${entry.displayName} Library`,
    }));
}
