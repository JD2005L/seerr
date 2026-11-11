// Levac fork: which titles are in the libraries this person can see. Seerr's
// media status is global ("Available" if anyone has it), so badges ask here
// whether it is available to them. Unknown or loading counts as "yes", which
// is how the site behaved before.
import useSWR from 'swr';

interface MyLibrary {
  limited: boolean;
  titles?: string[];
}

const REFRESH_MS = 2 * 60 * 1000;

// Plain-set lookup shared by every card; rebuilt only when the data changes.
const sets = new WeakMap<MyLibrary, Set<string>>();

export function titleSet(data: MyLibrary): Set<string> {
  let set = sets.get(data);
  if (!set) sets.set(data, (set = new Set(data.titles ?? [])));
  return set;
}

export function inLibrary(
  data: MyLibrary | undefined,
  type: 'movie' | 'tv',
  tmdbId?: number,
  tvdbId?: number
): boolean {
  if (!data || !data.limited) return true;
  const set = titleSet(data);
  if (tmdbId && set.has(`${type}:tmdb:${tmdbId}`)) return true;
  return type === 'tv' && !!tvdbId && set.has(`tv:tvdb:${tvdbId}`);
}

export default function useMyLibrary() {
  const { data } = useSWR<MyLibrary>('/api/v1/library/mine', {
    refreshInterval: REFRESH_MS,
    dedupingInterval: 30 * 1000,
    revalidateOnFocus: false,
  });
  return {
    inMyLibrary: (type: 'movie' | 'tv', tmdbId?: number, tvdbId?: number) =>
      inLibrary(data, type, tmdbId, tvdbId),
  };
}
