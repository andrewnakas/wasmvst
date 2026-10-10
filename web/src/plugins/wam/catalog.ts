export interface WamCatalogEntry {
  name: string;
  vendor: string;
  url: string;
  category: string[];
  isInstrument: boolean;
  description?: string;
}

const COMMUNITY_BASE = 'https://www.webaudiomodules.com/community/plugins/';
const COMMUNITY_INDEX = 'https://www.webaudiomodules.com/community/plugins.json';

// These need hardware, video or a full sequencer host, so they aren't useful as track inserts.
const HIDDEN_CATEGORIES = new Set(['Video', 'External Device']);

interface CommunityEntry {
  name: string;
  vendor: string;
  path: string;
  category?: string[];
  description?: string;
}

let cache: Promise<WamCatalogEntry[]> | null = null;

export function fetchWamCatalog(): Promise<WamCatalogEntry[]> {
  cache ??= fetch(COMMUNITY_INDEX)
    .then((r) => {
      if (!r.ok) throw new Error(`WAM catalog HTTP ${r.status}`);
      return r.json() as Promise<CommunityEntry[]>;
    })
    .then((list) =>
      list
        .filter((p) => !(p.category ?? []).some((c) => HIDDEN_CATEGORIES.has(c)))
        .map((p) => ({
          name: p.name,
          vendor: p.vendor,
          url: COMMUNITY_BASE + p.path,
          category: p.category ?? [],
          isInstrument: (p.category ?? [])[0] === 'Instrument',
          description: p.description,
        })),
    )
    .catch((e) => {
      cache = null;
      throw e;
    });
  return cache;
}
