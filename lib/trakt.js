// Minimal Trakt client: trending/popular catalogs. IDs map to IMDb/TMDB,
// enrichment into Spanish metadata happens via lib/tmdb.js.
const { TtlCache } = require('./cache');

const API = 'https://api.trakt.tv';
const traktCache = new TtlCache({ maxEntries: 200 });

async function traktFetch(path, { clientId, params = {} }) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
      'User-Agent': 'stremio-es-addon/0.1 (personal)',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Trakt ${res.status} ${path}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Returns [{ imdb, tmdb, title, year }] for movies or shows.
async function listIds(kind, sort, { clientId, limit = 20, page = 1 }, ttl) {
  // kind: 'movies' | 'shows'; sort: 'trending' | 'popular'
  const key = `trakt:${kind}:${sort}:${page}:${limit}`;
  return traktCache.getOrFetch(key, ttl, async () => {
    const data = await traktFetch(`/${kind}/${sort}`, {
      clientId,
      params: { limit, page, extended: 'full' },
    });
    return (Array.isArray(data) ? data : [])
      .map((entry) => {
        const item = entry.movie || entry.show || entry;
        const ids = item.ids || {};
        return {
          imdb: ids.imdb || null,
          tmdb: ids.tmdb || null,
          title: item.title,
          year: item.year,
        };
      })
      .filter((e) => e.imdb || e.tmdb);
  });
}

module.exports = { listIds };
