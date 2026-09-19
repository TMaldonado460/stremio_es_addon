// Central config: server .env defaults + per-install URL config override.
// Stremio SDK passes `config` (parsed JSON from /<config>/manifest.json URL)
// into every handler as { type, id, extra, config }. Tokens in URL let the
// user test a 24h temporal token and later "generate the manifest" with real
// tokens from /configure without redeploying. Server env is the fallback.
require('dotenv').config();

function readEnv() {
  return {
    port: parseInt(process.env.PORT || '7000', 10),
    tmdbAccessToken: (process.env.TMDB_ACCESS_TOKEN || '').trim(),
    tmdbApiKey: (process.env.TMDB_API_KEY || '').trim(),
    traktClientId: (process.env.TRAKT_CLIENT_ID || '').trim(),
    torboxApiKey: (process.env.TORBOX_API_KEY || '').trim(), // reserved for v2 stream badge
    addonId: (process.env.ADDON_ID || 'com.tomasm.stremio-es').trim(),
    addonName: (process.env.ADDON_NAME || 'Cine en Español (Privado)').trim(),
    // Short TTLs on purpose: long edge caches (hours) hide fixes behind
    // stale bodies. Personal-scale traffic makes frequent TMDB refetch cheap.
    ttlSearch: parseInt(process.env.CACHE_TTL_SEARCH || '600', 10),
    ttlCatalog: parseInt(process.env.CACHE_TTL_CATALOG || '600', 10),
    ttlMeta: parseInt(process.env.CACHE_TTL_META || '3600', 10),
    ttlTrakt: parseInt(process.env.CACHE_TTL_TRAKT || '1800', 10),
  };
}

// Merge order: URL config wins over env (lets temporal tokens override).
function resolveTokens(urlConfig) {
  const env = readEnv();
  const c = urlConfig && typeof urlConfig === 'object' ? urlConfig : {};
  const pick = (cfgVal, envVal) => {
    const v = (cfgVal ?? '').toString().trim();
    return v || envVal;
  };
  return {
    ...env,
    tmdbAccessToken: pick(c.tmdbAccessToken, env.tmdbAccessToken),
    tmdbApiKey: pick(c.tmdbApiKey, env.tmdbApiKey),
    traktClientId: pick(c.traktClientId, env.traktClientId),
    torboxApiKey: pick(c.torboxApiKey, env.torboxApiKey),
  };
}

function hasTmdb(tokens) {
  return Boolean(tokens.tmdbAccessToken || tokens.tmdbApiKey);
}

module.exports = { readEnv, resolveTokens, hasTmdb };
