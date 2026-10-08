// Rate limiting for Anivexa. Fixed 60-second window.
//
// Enabled only when RATE_LIMIT_PER_MINUTE is a positive integer. The key is the
// bearer token (or the client IP when running anonymously). Upstash is used
// when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are configured; with no
// Redis the limiter falls back to a per-instance in-memory window. The
// in-memory window is NOT shared across instances, so a multi-instance
// deployment can let through up to `limit` requests per instance.

import { clientIp, bearerToken, errorResponse } from "./security.js";
import { redisCommand, REDIS_ENABLED } from "./smartcache.js";

const WINDOW_MS = 60_000;
const MAX_MEMORY_KEYS = 5_000;

const windows = new Map();

function prune(now) {
  if (windows.size <= MAX_MEMORY_KEYS) return;
  for (const [key, entry] of windows) {
    if (now - entry.start >= WINDOW_MS) windows.delete(key);
    if (windows.size <= MAX_MEMORY_KEYS) return;
  }
}

// Returns Retry-After seconds when over the limit, otherwise null.
function checkMemory(key, limit, now) {
  let entry = windows.get(key);
  if (!entry || now - entry.start >= WINDOW_MS) {
    entry = { start: now, count: 0 };
    windows.set(key, entry);
    prune(now);
  }
  entry.count += 1;
  if (entry.count > limit) {
    return Math.max(1, Math.ceil((entry.start + WINDOW_MS - now) / 1000));
  }
  return null;
}

// Returns Retry-After seconds, null when allowed, or undefined when Redis is
// unusable and the caller should fall back to the in-memory window.
async function checkRedis(key, limit) {
  const raw = await redisCommand(["INCR", key]);
  if (raw === null || raw === undefined) return undefined;
  const count = Number(raw);
  if (!Number.isFinite(count)) return undefined;
  if (count === 1) await redisCommand(["EXPIRE", key, Math.ceil(WINDOW_MS / 1000)]);
  if (count <= limit) return null;
  const ttl = Number(await redisCommand(["TTL", key]));
  return Number.isFinite(ttl) && ttl > 0 ? ttl : Math.ceil(WINDOW_MS / 1000);
}

// Returns Retry-After seconds when over the limit, otherwise null.
// A null return means the request is allowed.
export async function checkRateLimit(request, cfg) {
  if (!cfg.rateLimitPerMinute) return null;

  const token = bearerToken(request);
  const identity = token || clientIp(request);
  const key = `rl:${identity}`;

  if (REDIS_ENABLED) {
    const redisResult = await checkRedis(key, cfg.rateLimitPerMinute);
    if (redisResult !== undefined) return redisResult;
  }
  return checkMemory(key, cfg.rateLimitPerMinute, Date.now());
}

export function rateLimitResponse(retryAfterSeconds) {
  return errorResponse(
    429,
    "rate_limited",
    "Rate limit exceeded. Retry after the number of seconds in the Retry-After header.",
    { "Retry-After": String(retryAfterSeconds) }
  );
}
