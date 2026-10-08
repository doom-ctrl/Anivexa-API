import { getMedia }                from "./core/anilist.js";
import { mapAnimeIds }             from "./core/mapper.js";
import mkissaHandler               from "./providers/mkissa.js";
import reanimeHandler              from "./providers/reanime.js";
import anikotoHandler              from "./providers/anikoto.js";
import animeggHandler              from "./providers/animegg.js";
import aninekoHandler              from "./providers/anineko.js";
import anidbappHandler             from "./providers/anidbapp.js";
import animenosubHandler           from "./providers/animenosub.js";
import anizoneHandler              from "./providers/anizone.js";
import aniwavesHandler             from "./providers/aniwaves.js";
import anibdHandler                from "./providers/anibd.js";
import senshiHandler               from "./providers/senshi.js";
import kaaHandler                  from "./providers/kickassanime.js";
import animedunyaHandler           from "./providers/animedunya.js";
import animeonsenHandler           from "./providers/animeonsen.js";
import { getEpisodesResponse, getFilteredEpisodesResponse } from "./core/episode-cache.js";
import { resolveProviders }         from "./core/episode-strategy.js";
import { getAsync, setAsync, isFresh, mapTTL, WATCH_TTL, _CACHE_ENABLED } from "./core/smartcache.js";
import {
  getConfig, authorize, preflightResponse, finalize, errorResponse,
  applyProviderAllowlist, isProviderAllowed,
} from "./core/security.js";
import { checkRateLimit, rateLimitResponse } from "./core/ratelimit.js";

// Extra headers are applied over the defaults; finalize() still owns CORS and
// the stream-route cache policy.
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      ...extraHeaders,
    },
  });
}

const PRIVATE_CACHE = { "Cache-Control": "private, no-store" };

function rewriteRequest(request, newPath) {
  const u = new URL(request.url);
  u.pathname = newPath;
  return new Request(u.toString(), { method: request.method, headers: request.headers });
}

const watchInflight = new Map();
const SIGNED_STREAM_WATCH_TTL = 60_000;

async function cachedWatch(cacheKey, handlerFn, ttl = WATCH_TTL) {
  const entry = await getAsync(cacheKey);
  if (entry && isFresh(entry)) return json(entry.data, 200, PRIVATE_CACHE);

  if (watchInflight.has(cacheKey)) {
    await watchInflight.get(cacheKey).catch(() => {});
    const warm = await getAsync(cacheKey);
    if (warm && isFresh(warm)) return json(warm.data, 200, PRIVATE_CACHE);
    return handlerFn();
  }

  const promise = (async () => {
    const response = await handlerFn();
    if (response.status === 200) {
      try {
        const data = await response.clone().json();
        await setAsync(cacheKey, data, ttl);
      } catch {}
    }
    return response;
  })();

  watchInflight.set(cacheKey, promise);
  try   { return await promise; }
  finally { watchInflight.delete(cacheKey); }
}

function homePayload() {
  return {
    name: "Anivexa API 2.2.1",
    cache: _CACHE_ENABLED,
    providers: [
      "mkissa",
      "reanime",
      "anikoto",
      "animegg",
      "anineko",
      "anidbapp",
      "animenosub",
      "anizone",
      "aniwaves",
      "anibd",
      "senshi",
      "kaa",
      "animedunya",
      "animeonsen",
    ],
    routes: [
      "/map/:anilistId",
      "/episodes/:anilistId",
      "/episodes/:provider[/:provider...]/:anilistId?map=true|false",
      "/watch/mkissa/:id/sub|dub/mkissa-:ep",
      "/watch/reanime/:id/sub|dub/reanime-:ep",
      "/stream/reanime/:id/sub|dub/:ep",
      "/watch/anikoto/:id/sub|dub/anikoto-:ep",
      "/watch/animegg/:id/sub|dub/animegg-:ep",
      "/watch/anineko/:id/sub|dub/anineko-:ep",
      "/watch/anidbapp/:id/sub|dub/anidbapp-:ep",
      "/watch/animenosub/:id/sub|dub/animenosub-:ep",
      "/watch/anizone/:id/sub|dub/anizone-:ep",
      "/watch/aniwaves/:id/sub|dub/aniwaves-:ep",
      "/watch/anibd/:id/sub|dub/anibd-:ep",
      "/watch/senshi/:id/sub|dub/senshi-:ep",
      "/watch/kaa/:id/sub|dub/kaa-:ep",
      "/watch/animedunya/:id/sub|dub/animedunya-:ep",
      "/watch/animeonsen/:id/sub|dub/animeonsen-:ep",
    ],
  };
}

async function route(request, env, cfg) {
  const url  = new URL(request.url);
  const path = url.pathname;

  let m = path.match(/^\/map\/(\d+)\/?$/);
  if (m) {
    const anilistId = m[1];
    const cacheKey  = `map:${anilistId}`;
    const entry     = await getAsync(cacheKey);
    if (entry && isFresh(entry)) return json(entry.data);

    try {
      const [data, media] = await Promise.all([
        mapAnimeIds(anilistId),
        getMedia(anilistId).catch(() => null),
      ]);
      await setAsync(cacheKey, data, mapTTL(media?.status ?? "RELEASING"));
      return json(data);
    } catch (e) {
      console.error("[map]", e.stack ?? e.message);
      if (entry) return json(entry.data);
      return json({ error: e.message }, 500);
    }
  }

  m = path.match(/^\/episodes\/((?:[\w-]+\/)+)(\d+)\/?$/i);
  if (m) {
    const rawNames  = m[1].replace(/\/$/, "").split("/");
    const anilistId = m[2];
    const includeMap = url.searchParams.get("map") !== "false";
    const { resolved, unknown } = resolveProviders(rawNames);
    applyProviderAllowlist(resolved, unknown, cfg);

    if (resolved.size === 0) {
      return json({ error: "No valid providers specified", unknown }, 400);
    }

    try {
      const data = await getFilteredEpisodesResponse(anilistId, resolved, includeMap);
      if (unknown.length) data._unknownProviders = unknown;
      return json(data);
    } catch (e) {
      console.error("[episodes:filtered]", e.stack ?? e.message);
      return json({ error: e.message }, 500);
    }
  }

  m = path.match(/^\/episodes\/(\d+)\/?$/);
  if (m) {
    if (!cfg.allowUnfiltered) {
      return errorResponse(
        403,
        "forbidden",
        "The unfiltered episodes route is disabled. Set ALLOW_UNFILTERED_EPISODES=true to enable it."
      );
    }
    const anilistId = m[1];
    try {
      return json(await getEpisodesResponse(anilistId, env));
    } catch (e) {
      console.error("[episodes:unfiltered]", e.stack ?? e.message);
      return json({ error: e.message }, 500);
    }
  }

  // ALLOWED_PROVIDERS also governs the direct watch/stream routes; otherwise an
  // allowlisted deployment could still be driven through them.
  const providerMatch = path.match(/^\/(?:watch|stream)\/([\w-]+)\//);
  if (providerMatch && !isProviderAllowed(providerMatch[1], cfg)) {
    return json({ error: "No valid providers specified", unknown: [providerMatch[1]] }, 400);
  }

  m = path.match(/^\/watch\/mkissa\/(\d+)\/(sub|dub)\/mkissa-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:mkissa:${id}:${audio}:${ep}`,
      () => mkissaHandler.fetch(request)
    );
  }

  if (path.match(/^\/captcha\/mkissa\/?$/)) {
    if (!cfg.allowMkissaCaptcha) {
      return errorResponse(
        403,
        "forbidden",
        "The mkissa captcha route is disabled. Set ALLOW_MKISSA_CAPTCHA=true to enable it."
      );
    }
    return mkissaHandler.fetch(request);
  }

  m = path.match(/^\/watch\/reanime\/(\d+)\/(sub|dub)\/reanime-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:reanime:${id}:${audio}:${ep}`,
      () => reanimeHandler.fetch(rewriteRequest(request, `/watch/${id}/${audio}/${ep}`))
    );
  }

  m = path.match(/^\/stream\/reanime\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return reanimeHandler.fetch(rewriteRequest(request, `/stream/${id}/${audio}/${ep}`));
  }

  m = path.match(/^\/watch\/anikoto\/(\d+)\/(sub|dub)\/anikoto-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:anikoto:${id}:${audio}:${ep}`,
      () => anikotoHandler.fetch(request),
      SIGNED_STREAM_WATCH_TTL
    );
  }

  m = path.match(/^\/watch\/animegg\/(\d+)\/(sub|dub)\/animegg-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:animegg:${id}:${audio}:${ep}`,
      () => animeggHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/anineko\/(\d+)\/(sub|dub)\/anineko-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:anineko:${id}:${audio}:${ep}`,
      () => aninekoHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/anidbapp\/(\d+)\/(sub|dub)\/anidbapp-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:anidbapp:${id}:${audio}:${ep}`,
      () => anidbappHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/animenosub\/(\d+)\/(sub|dub)\/animenosub-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:animenosub:${id}:${audio}:${ep}`,
      () => animenosubHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/anizone\/(\d+)\/(sub|dub)\/anizone-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:anizone:${id}:${audio}:${ep}`,
      () => anizoneHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/aniwaves\/(\d+)\/(sub|dub)\/aniwaves-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:aniwaves:${id}:${audio}:${ep}`,
      () => aniwavesHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/anibd\/(\d+)\/(sub|dub)\/anibd-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:anibd:${id}:${audio}:${ep}`,
      () => anibdHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/senshi\/(\d+)\/(sub|dub)\/senshi-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:senshi:${id}:${audio}:${ep}`,
      () => senshiHandler.fetch(request),
      SIGNED_STREAM_WATCH_TTL
    );
  }

  m = path.match(/^\/watch\/kaa\/(\d+)\/(sub|dub)\/kaa-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:kaa:${id}:${audio}:${ep}`,
      () => kaaHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/animedunya\/(\d+)\/(sub|dub)\/animedunya-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:animedunya:${id}:${audio}:${ep}`,
      () => animedunyaHandler.fetch(request)
    );
  }

  m = path.match(/^\/watch\/animeonsen\/(\d+)\/(sub|dub)\/animeonsen-(\d+)\/?$/);
  if (m) {
    const [, id, audio, ep] = m;
    return cachedWatch(
      `watch:animeonsen:${id}:${audio}:${ep}`,
      () => animeonsenHandler.fetch(request)
    );
  }

  if (path === "/" || path === "/home") return json(homePayload());

  return json(homePayload());
}

export default {
  async fetch(request, env) {
    const cfg = getConfig();
    const url = new URL(request.url);

    // OPTIONS is the only request served without a token, and it returns no data.
    if (request.method === "OPTIONS") return preflightResponse(cfg);

    const authFailure = authorize(request, cfg);
    if (authFailure) return finalize(authFailure, url.pathname, cfg);

    const retryAfter = await checkRateLimit(request, cfg);
    if (retryAfter !== null) return finalize(rateLimitResponse(retryAfter), url.pathname, cfg);

    let response;
    try {
      response = await route(request, env, cfg);
    } catch (e) {
      console.error("[unhandled]", e.stack ?? e.message);
      response = errorResponse(500, "upstream_failed", "Unexpected server error.");
    }
    return finalize(response, url.pathname, cfg);
  },
};
