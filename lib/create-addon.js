// Shared addon construction (no listen side effect) so both the local
// server (addon.js -> serveHTTP) and Vercel serverless (api/index.js)
// serve the exact same interface.
const { addonBuilder } = require('stremio-addon-sdk');
const { readEnv, resolveTokens, hasTmdb } = require('./config');
const { TtlCache } = require('./cache');
const tmdb = require('./tmdb');
const trakt = require('./trakt');

const PAGE_SIZE = 20;

function createAddon() {
  const env = readEnv();
  const catalogCache = new TtlCache({ maxEntries: 1000 });

  const manifest = {
    id: env.addonId,
    version: '0.2.3',
    name: env.addonName,
    description:
      'Búsqueda, catálogos y sinopsis en español (es-MX > es-ES > en). Pósters con título en español cuando existen. Recomendados Trakt + aleatorio. Compatible con Torrentio/MediaFusion/TorBox.',
    types: ['movie', 'series'],
    resources: ['catalog', 'meta'],
    // Custom prefix: our detail pages (`es:<tt>`) are served ONLY by this
    // addon, so Cinemeta can never override them with English. We deliberately
    // do NOT claim `tt`, otherwise we'd race Cinemeta again.
    idPrefixes: ['es:'],
    catalogs: [
      { type: 'movie', id: 'es-trending-movies', name: '🔥 Tendencias (ES)', extra: [{ name: 'search' }, { name: 'skip' }] },
      { type: 'movie', id: 'es-populares', name: '⭐ Populares (ES)', extra: [{ name: 'search' }, { name: 'skip' }] },
      { type: 'movie', id: 'es-trakt', name: '📈 Trakt: tendencia', extra: [{ name: 'search' }, { name: 'skip' }] },
      { type: 'movie', id: 'es-aleatorio', name: '🎲 Aleatorio', extra: [{ name: 'search' }, { name: 'skip' }] },
      { type: 'series', id: 'es-trending-series', name: '🔥 Tendencias Series (ES)', extra: [{ name: 'search' }, { name: 'skip' }] },
      { type: 'series', id: 'es-populares-series', name: '⭐ Populares Series (ES)', extra: [{ name: 'search' }, { name: 'skip' }] },
      { type: 'series', id: 'es-trakt-series', name: '📈 Trakt: series tendencia', extra: [{ name: 'search' }, { name: 'skip' }] },
      { type: 'series', id: 'es-aleatorio-series', name: '🎲 Aleatorio Series', extra: [{ name: 'search' }, { name: 'skip' }] },
    ],
    behaviorHints: { configurable: true, configurationRequired: false },
    config: [
      { key: 'tmdbAccessToken', type: 'password', title: 'TMDB access token (Bearer eyJ... — preferido, temporal de 24h sirve para probar)' },
      { key: 'tmdbApiKey', type: 'password', title: 'TMDB API key v3 (alternativa si no tienes Bearer)' },
      { key: 'traktClientId', type: 'text', title: 'Trakt Client ID (opcional — solo catálogos 📈 Trakt)' },
      { key: 'torboxApiKey', type: 'password', title: 'Torbox API key (opcional — reservado para badge ES v2)' },
    ],
  };

  const builder = new addonBuilder(manifest);
  const stremioType = (t) => (t === 'series' ? 'tv' : 'movie');
  const pageFromSkip = (skip) => Math.floor((parseInt(skip || '0', 10) || 0) / PAGE_SIZE) + 1;

  async function handleSearch(type, query, skip, tokens) {
    const kind = stremioType(type);
    const page = pageFromSkip(skip);
    const key = `search:${kind}:${query.toLowerCase()}:${page}`;
    return catalogCache.getOrFetch(key, tokens.ttlSearch, async () => {
      const data = await tmdb.search(kind, query, page, tokens, tokens.ttlSearch);
      return tmdb.enrichList(kind, data.results || [], tokens, tokens.ttlMeta);
    });
  }

  async function handleListCatalog(catalogId, type, skip, tokens) {
    const kind = stremioType(type);
    const page = pageFromSkip(skip);
    const key = `cat:${catalogId}:${page}`;
    return catalogCache.getOrFetch(key, tokens.ttlCatalog, async () => {
      if (catalogId.startsWith('es-trending')) {
        const data = await tmdb.trending(kind, page, tokens);
        return tmdb.enrichList(kind, data.results || [], tokens, tokens.ttlMeta);
      }
      if (catalogId.startsWith('es-populares')) {
        const data = await tmdb.popular(kind, page, tokens);
        return tmdb.enrichList(kind, data.results || [], tokens, tokens.ttlMeta);
      }
      if (catalogId.startsWith('es-trakt')) {
        if (!tokens.traktClientId) return [];
        const entries = await trakt.listIds(
          type === 'movie' ? 'movies' : 'shows', 'trending',
          { clientId: tokens.traktClientId, limit: PAGE_SIZE, page }, tokens.ttlTrakt
        );
        // resolve every entry to a TMDB id, then enrich in Spanish
        const tmdbIds = (
          await Promise.all(
            entries.map(async (e) => {
              if (e.tmdb) return e.tmdb;
              try {
                const f = await tmdb.findTmdbByImdb(e.imdb, tokens, tokens.ttlMeta);
                return f ? f.tmdbId : null;
              } catch { return null; }
            })
          )
        ).filter(Boolean);
        return tmdb.enrichList(kind, tmdbIds.map((id) => ({ id })), tokens, tokens.ttlMeta);
      }
      if (catalogId.startsWith('es-aleatorio')) {
        // pseudo-random: 3 pages of popular, daily shuffle, paginate by skip
        const pages = await Promise.all([1, 2, 3].map((p) => tmdb.popular(kind, p, tokens)));
        const pool = pages.flatMap((d) => d.results || []);
        const order = tmdb.shuffled(pool, tmdb.dailySeed());
        const start = (parseInt(skip || '0', 10) || 0) % Math.max(order.length, 1);
        const slice = order.slice(start, start + PAGE_SIZE);
        return tmdb.enrichList(kind, slice, tokens, tokens.ttlMeta);
      }
      return [];
    });
  }

  builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    const tokens = resolveTokens(config);
    if (!hasTmdb(tokens)) {
      console.warn('[catalog] sin token TMDB (ni env ni URL config) — devuelvo vacío');
      return { metas: [] };
    }
    try {
      const skip = extra && extra.skip ? extra.skip : 0;
      let metas;
      if (extra && extra.search) {
        metas = await handleSearch(type, extra.search, skip, tokens);
      } else {
        metas = await handleListCatalog(id, type, skip, tokens);
      }
      return { metas, cacheMaxAge: tokens.ttlCatalog, staleRevalidate: 600, staleError: 86400 };
    } catch (e) {
      console.error('[catalog] error:', e.message);
      return { metas: [] };
    }
  });

  builder.defineMetaHandler(async ({ type, id, config }) => {
    const tokens = resolveTokens(config);
    if (!hasTmdb(tokens)) throw new Error('Falta token TMDB: configura TMDB_ACCESS_TOKEN o usa /configure');
    // Only serve our own `es:` ids — never compete with Cinemeta for bare `tt` ids.
    if (!id.startsWith(tmdb.META_PREFIX)) {
      console.warn(`[meta] ID fuera de alcance (instalación vieja con manifest tt?): ${id}`);
      throw new Error(`ID fuera de alcance: ${id}`);
    }
    const t0 = Date.now();
    const meta = await tmdb.getFullMeta(type, id, tokens, tokens.ttlMeta);
    if (!meta) throw new Error(`Sin metadatos ES para ${id}`);
    const ms = Date.now() - t0;
    const videos = meta.videos ? `${meta.videos.length} videos` : 'sin videos';
    console.log(`[meta ${type}/${id}] ${ms}ms videos=${videos}`);
    return { meta, cacheMaxAge: tokens.ttlMeta, staleRevalidate: 3600, staleError: 86400 };
  });

  return { interface: builder.getInterface(), env };
}

module.exports = { createAddon };
