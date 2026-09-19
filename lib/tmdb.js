// TMDB client with es-MX > es-ES > en-US fallback and IMDb mapping.
// All Stremio ids emitted are IMDb `tt...` so Torrentio/MediaFusion/Comet
// stream addons keep resolving without changes.
const { TtlCache } = require('./cache');

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const LANGS = ['es-MX', 'es-ES', 'en-US'];
const FETCH_TIMEOUT_MS = 10000;
// Custom ID prefix: catalog/meta ids are `es:<tt>` so the detail page for
// OUR rows is served only by this addon (Cinemeta never sees these ids and
// can't override them with English). Video ids stay bare `tt...` so all
// stream addons (Torrentio/MediaFusion/TorBox) keep resolving.
const META_PREFIX = 'es:';

const detailsCache = new TtlCache({ maxEntries: 4000 });
const genreCache = new TtlCache({ maxEntries: 10 });
const findCache = new TtlCache({ maxEntries: 2000 });
// Spanish episode lists, filled in background so meta responses never block on them.
const seasonsCache = new TtlCache({ maxEntries: 1000 });
const posterCache = new TtlCache({ maxEntries: 2000 });
const seasonsInFlight = new Set();

function img(path, size = 'w500') {
  if (!path) return undefined;
  return `${IMG}/${size}${path}`;
}

async function tmdbFetch(path, { tokens, params = {}, language } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (language) url.searchParams.set('language', language);
  if (tokens.tmdbApiKey && !tokens.tmdbAccessToken) {
    url.searchParams.set('api_key', tokens.tmdbApiKey);
  }
  const headers = { accept: 'application/json' };
  if (tokens.tmdbAccessToken) headers.Authorization = `Bearer ${tokens.tmdbAccessToken}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`TMDB ${res.status} ${path}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// Run up to `limit` promises at once (TMDB rate limits ~40/10s).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return out.filter((v) => v !== undefined);
}

async function getGenres(tmdbType, tokens, ttl) {
  const kind = tmdbType === 'tv' ? 'tv' : 'movie';
  return genreCache.getOrFetch(`genres:${kind}:es`, ttl, async () => {
    try {
      const data = await tmdbFetch(`/genre/${kind}/list`, { tokens, language: 'es-MX' });
      const m = {};
      for (const g of data.genres || []) m[g.id] = g.name;
      return m;
    } catch {
      return {};
    }
  });
}

// Details in each language, merged per-field (best-available fallback).
// Single HTTP call per language: details + external_ids + images appended,
// so posters come embedded and no extra /images roundtrip is needed.
async function getDetailsMerged(tmdbType, tmdbId, tokens, ttl) {
  const cacheKey = `details:${tmdbType}:${tmdbId}`;
  const cached = detailsCache.get(cacheKey);
  if (cached) return cached;

  const payloads = [];
  for (const lang of LANGS) {
    try {
      const d = await tmdbFetch(`/${tmdbType}/${tmdbId}`, {
        tokens,
        language: lang,
        params: { append_to_response: 'external_ids,images' },
      });
      payloads.push({ lang, d });
      if (d.overview && (d.title || d.name)) break; // good enough, stop early
    } catch (e) {
      if (e.status === 404) break;
      // try next language on transient errors only once
      if (payloads.length === 0) throw e;
      break;
    }
  }
  if (payloads.length === 0) throw new Error(`TMDB details empty ${tmdbType}:${tmdbId}`);
  const first = payloads[0].d;
  const pick = (fn) => {
    for (const p of payloads) {
      const v = fn(p.d);
      if (v) return v;
    }
    return undefined;
  };
  const posters =
    (payloads.find((p) => p.d.images && p.d.images.posters && p.d.images.posters.length) || {}).d?.images?.posters || [];
  const merged = {
    ...first,
    title: pick((d) => d.title) || first.title,
    name: pick((d) => d.name) || first.name,
    overview: pick((d) => d.overview) || '',
    tagline: pick((d) => d.tagline) || '',
    poster_path: payloads[0].d.poster_path || first.poster_path,
    backdrop_path: pick((d) => d.backdrop_path) || first.backdrop_path,
    _posters: posters,
  };
  detailsCache.set(cacheKey, merged, ttl);
  return merged;
}

// Prefer a Spanish-text poster so titles are readable from the couch.
// Pure sync: works off the posters embedded in the details response.
function pickPosterEs(details, fallbackPath) {
  const posters = ((details && details._posters) || []).filter((p) => p.file_path);
  const es = posters
    .filter((p) => p.iso_639_1 === 'es')
    .sort((a, b) => b.vote_average * b.vote_count - a.vote_average * a.vote_count);
  const pool = es.length ? es : posters.sort((a, b) => b.vote_count - a.vote_count);
  if (pool.length && pool[0].file_path) return img(pool[0].file_path, 'w500');
  return img(fallbackPath, 'w500');
}

// Fallback when details carried no embedded posters (rare): one /images call.
async function getPosterEsViaApi(tmdbType, tmdbId, tokens, ttl, fallbackPath) {
  try {
    const data = await tmdbFetch(`/${tmdbType}/${tmdbId}/images`, {
      tokens,
      params: { include_image_language: 'es,en,null' },
    });
    return pickPosterEs({ _posters: data.posters || [] }, fallbackPath);
  } catch {
    return img(fallbackPath, 'w500');
  }
}

async function resolvePoster(tmdbType, tmdbId, details, tokens, ttl) {
  if (details._posters && details._posters.length) return pickPosterEs(details, details.poster_path);
  const key = `poster:${tmdbType}:${tmdbId}`;
  const hit = posterCache.get(key);
  if (hit !== undefined) return hit;
  const url = await getPosterEsViaApi(tmdbType, tmdbId, tokens, ttl, details.poster_path);
  posterCache.set(key, url, ttl);
  return url;
}

async function toPreview(tmdbType, raw, tokens, ttl, genres) {
  const tmdbId = raw.id;
  let details;
  try {
    details = await getDetailsMerged(tmdbType, tmdbId, tokens, ttl);
  } catch {
    return undefined;
  }
  const imdbId = details.external_ids && details.external_ids.imdb_id;
  if (!imdbId || !imdbId.startsWith('tt')) return undefined; // streams need IMDb ids

  const isMovie = tmdbType === 'movie';
  const name = isMovie ? details.title : details.name;
  if (!name) return undefined;
  const date = isMovie ? details.release_date : details.first_air_date;
  const poster = await resolvePoster(tmdbType, tmdbId, details, tokens, ttl);

  if (!isMovie && imdbId) warmSeasons(tmdbId, imdbId, tokens, ttl); // fire-and-forget

  return {
    id: META_PREFIX + imdbId,
    type: isMovie ? 'movie' : 'series',
    name,
    poster,
    background: img(details.backdrop_path, 'original'),
    description: details.overview || '',
    releaseInfo: (date || '').slice(0, 4),
    genres: (details.genres || (details.genre_ids || []).map((g) => genres[g]).filter(Boolean)),
    imdbRating: details.vote_average ? String(Math.round(details.vote_average * 10) / 10) : undefined,
  };
}

async function enrichList(tmdbType, raws, tokens, ttl) {
  const genres = await getGenres(tmdbType, tokens, ttl);
  const previews = await mapLimit(raws, 5, (r) => toPreview(tmdbType, r, tokens, ttl, genres));
  return previews.filter((p) => p && p.id);
}

async function search(tmdbType, query, page, tokens, ttl) {
  const data = await tmdbFetch(`/search/${tmdbType}`, {
    tokens,
    language: LANGS[0],
    params: { query, include_adult: 'false', page },
  });
  return data;
}

async function trending(tmdbType, page, tokens) {
  return tmdbFetch(`/trending/${tmdbType}/week`, { tokens, language: LANGS[0], params: { page } });
}

async function popular(tmdbType, page, tokens) {
  return tmdbFetch(`/${tmdbType}/popular`, { tokens, language: LANGS[0], params: { page } });
}

// imdb tt... -> tmdb id (for meta handler)
async function findTmdbByImdb(imdbId, tokens, ttl) {
  return findCache.getOrFetch(`find:${imdbId}`, ttl, async () => {
    const data = await tmdbFetch(`/find/${imdbId}`, {
      tokens,
      language: LANGS[0],
      params: { external_source: 'imdb_id' },
    });
    const m = (data.movie_results || [])[0];
    const s = (data.tv_results || [])[0];
    if (m) return { tmdbType: 'movie', tmdbId: m.id };
    if (s) return { tmdbType: 'tv', tmdbId: s.id };
    return null;
  });
}

// Full meta for detail page. `metaId` is our custom `es:<tt>` id (bare `tt`
// also accepted). Returned meta keeps the custom id, while every VIDEO id
// stays bare `tt...` so stream addons keep matching.
async function getFullMeta(stremioType, metaId, tokens, ttlMeta) {
  const imdbId = metaId.startsWith(META_PREFIX) ? metaId.slice(META_PREFIX.length) : metaId;
  if (!/^tt\d+$/.test(imdbId)) return null;
  const found = await findTmdbByImdb(imdbId, tokens, ttlMeta);
  if (!found) return null;
  const { tmdbType, tmdbId } = found;
  const [details, genres] = await Promise.all([
    getDetailsMerged(tmdbType, tmdbId, tokens, ttlMeta),
    getGenres(tmdbType, tokens, ttlMeta),
  ]);
  const isMovie = tmdbType === 'movie';
  const name = isMovie ? details.title : details.name;
  const date = isMovie ? details.release_date : details.first_air_date;
  const poster = await resolvePoster(tmdbType, tmdbId, details, tokens, ttlMeta);

  const meta = {
    id: META_PREFIX + imdbId,
    type: stremioType,
    name,
    poster,
    background: img(details.backdrop_path, 'original'),
    logo: undefined,
    description: details.overview || '',
    releaseInfo: (date || '').slice(0, 4),
    genres: (details.genres || (details.genre_ids || []).map((g) => genres[g]).filter(Boolean)),
    imdbRating: details.vote_average ? String(Math.round(details.vote_average * 10) / 10) : undefined,
    runtime: details.runtime ? `${details.runtime}m` : undefined,
  };

  if (isMovie) {
    // Single video with the BARE tt id: stream requests go to
    // /stream/movie/tt... where Torrentio/MediaFusion/TorBox all match.
    meta.videos = [
      {
        id: imdbId,
        title: name,
        released: date ? new Date(date).toISOString() : undefined,
        overview: details.overview || '',
        thumbnail: img(details.backdrop_path, 'w500'),
      },
    ];
  } else {
    const cachedVideos = seasonsCache.get(`seasons:${tmdbId}`);
    if (cachedVideos && cachedVideos.length) {
      meta.videos = cachedVideos;
    } else if (process.env.VERCEL) {
      // Serverless: background work may freeze after responding, so fetch
      // episodes blocking (higher concurrency, first view is slower but complete).
      try {
        const videos = await fetchSeasonsEs(tmdbId, imdbId, tokens, ttlMeta);
        if (videos.length) {
          seasonsCache.set(`seasons:${tmdbId}`, videos, ttlMeta);
          meta.videos = videos;
        } else {
          meta.videos = placeholderVideos(details, imdbId);
        }
      } catch {
        meta.videos = placeholderVideos(details, imdbId);
      }
    } else {
      // Placeholders with BARE tt video ids so episodes + streams work on
      // the very first view; Spanish titles replace them once the background
      // warm finishes (next view).
      meta.videos = placeholderVideos(details, imdbId);
      warmSeasons(tmdbId, imdbId, tokens, ttlMeta);
    }
  }
  return meta;
}

// Generic episode entries built from season/episode counts already present
// in the tv details (no extra HTTP). Video ids are bare tt so streams resolve.
function placeholderVideos(details, imdbId) {
  const seasons = (details.seasons || []).filter(
    (s) => s.season_number > 0 && s.episode_count > 0
  );
  const videos = [];
  for (const s of seasons.slice(0, 20)) {
    for (let e = 1; e <= Math.min(s.episode_count, 60); e++) {
      videos.push({
        id: `${imdbId}:${s.season_number}:${e}`,
        title: `Episodio ${e}`,
        season: s.season_number,
        episode: e,
      });
    }
  }
  return videos;
}

// Fire-and-forget season prefetch, deduped while in flight.
function warmSeasons(tmdbId, imdbId, tokens, ttl) {
  const key = `seasons:${tmdbId}`;
  if (seasonsCache.get(key) || seasonsInFlight.has(key)) return;
  seasonsInFlight.add(key);
  fetchSeasonsEs(tmdbId, imdbId, tokens, ttl)
    .then((videos) => {
      if (videos.length) seasonsCache.set(key, videos, ttl);
    })
    .catch(() => {})
    .finally(() => seasonsInFlight.delete(key));
}

async function fetchSeasonsEs(tmdbId, imdbId, tokens, ttl) {
  const details = await getDetailsMerged('tv', tmdbId, tokens, ttl);
  const seasons = (details.seasons || []).filter(
    (s) => s.season_number > 0 && s.episode_count > 0
  );
  const limited = seasons.slice(0, 10); // cap cost for long-running shows
  const concurrency = process.env.VERCEL ? 6 : 2;
  const perSeason = await mapLimit(limited, concurrency, async (s) => {
    try {
      const data = await tmdbFetch(`/tv/${tmdbId}/season/${s.season_number}`, {
        tokens,
        language: LANGS[0],
      });
      return (data.episodes || []).map((ep) => ({
        id: `${imdbId}:${ep.season_number}:${ep.episode_number}`,
        title: ep.name || `Episodio ${ep.episode_number}`,
        released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
        overview: ep.overview || '',
        thumbnail: img(ep.still_path, 'w500'),
        season: ep.season_number,
        episode: ep.episode_number,
      }));
    } catch {
      return [];
    }
  });
  return perSeason.flat();
}

// Deterministic daily shuffle for the "Aleatorio" catalog.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function shuffled(arr, seed) {
  const rnd = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  LANGS,
  META_PREFIX,
  search,
  trending,
  popular,
  enrichList,
  getFullMeta,
  findTmdbByImdb,
  dailySeed,
  shuffled,
};
