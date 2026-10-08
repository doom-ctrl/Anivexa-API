// Security controls for Anivexa: auth, fail-closed configuration, CORS,
// cache control, stack stripping and the provider allowlist.
//
// Every request passes through `authorize` / `checkRateLimit` in index.js
// before any route is matched, so no route can be reached without clearing
// these checks. This module runs on the Node.js runtime (server.js, api/index.js)
// because the constant-time comparison uses node:crypto.

import { timingSafeEqual } from "node:crypto";

// process may be undefined/limited on edge runtimes; read defensively.
export function readEnv(name) {
  try {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

// Exactly the string "true" turns a flag on. Anything else, including "TRUE"
// and "1", is treated as off so a typo can never open a gate.
export function isExactlyTrue(name) {
  return readEnv(name) === "true";
}

// Comma separated list -> lower-cased Set, or null when unset/empty.
export function parseCsv(name) {
  const raw = readEnv(name);
  if (!raw) return null;
  const set = new Set();
  for (const part of String(raw).split(",")) {
    const value = part.trim().toLowerCase();
    if (value) set.add(value);
  }
  return set.size ? set : null;
}

// Positive integer or null. Anything else means the feature is off.
export function parsePositiveInt(name) {
  const raw = readEnv(name);
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function getConfig() {
  return {
    token: readEnv("API_TOKEN") || "",
    allowAnonymous: isExactlyTrue("ALLOW_ANONYMOUS"),
    allowedOrigin: readEnv("ALLOWED_ORIGIN") || "",
    allowedProviders: parseCsv("ALLOWED_PROVIDERS"),
    allowUnfiltered: isExactlyTrue("ALLOW_UNFILTERED_EPISODES"),
    allowMkissaCaptcha: isExactlyTrue("ALLOW_MKISSA_CAPTCHA"),
    rateLimitPerMinute: parsePositiveInt("RATE_LIMIT_PER_MINUTE"),
  };
}

// Constant-time comparison. Length is checked first (and leaked, which is
// unavoidable) before the timing-safe comparison on equal-length buffers.
export function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function bearerToken(request) {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function clientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

// The pinned error envelope used by every control in this module.
export function errorResponse(status, code, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// Returns a Response when the request must be rejected, otherwise null.
export function authorize(request, cfg) {
  if (cfg.token) {
    const presented = bearerToken(request);
    if (!presented || !constantTimeEqual(presented, cfg.token)) {
      return errorResponse(
        401,
        "unauthorized",
        "Missing or invalid API token. Send Authorization: Bearer <API_TOKEN>."
      );
    }
    return null;
  }
  if (!cfg.allowAnonymous) {
    return errorResponse(
      503,
      "not_configured",
      "API_TOKEN is not set and anonymous access is disabled (ALLOW_ANONYMOUS is not \"true\")."
    );
  }
  return null;
}

// OPTIONS is the only request served without a token and must carry no data.
export function preflightResponse(cfg) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  };
  if (cfg.allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = cfg.allowedOrigin;
    headers["Vary"] = "Origin";
  }
  return new Response(null, { status: 204, headers });
}

const STREAM_PATH = /^\/(?:watch|stream)\//;

function stripStacks(value, seen) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) stripStacks(item, seen);
    return value;
  }
  if (Object.prototype.hasOwnProperty.call(value, "stack")) delete value.stack;
  for (const key of Object.keys(value)) stripStacks(value[key], seen);
  return value;
}

// Applies the response-level controls to whatever a route produced:
//   - CORS header only when ALLOWED_ORIGIN is set (echoing that one origin)
//   - "private, no-store" on stream-bearing routes
//   - no "stack" property in any JSON body
// Bodies without a stack key are passed through byte-for-byte.
export async function finalize(response, pathname, cfg) {
  const headers = new Headers(response.headers);

  if (cfg.allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", cfg.allowedOrigin);
    if (!headers.has("Vary")) headers.set("Vary", "Origin");
  } else {
    headers.delete("Access-Control-Allow-Origin");
  }

  if (STREAM_PATH.test(pathname)) {
    headers.set("Cache-Control", "private, no-store");
  }

  if (!response.body) {
    return new Response(null, { status: response.status, headers });
  }

  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return new Response(response.body, { status: response.status, headers });
  }

  let text = await response.text();
  if (text.includes('"stack"')) {
    try {
      const data = JSON.parse(text);
      stripStacks(data, new WeakSet());
      text = JSON.stringify(data, null, 2);
    } catch {
      // Not parseable after all; leave the body untouched.
    }
  }
  return new Response(text, { status: response.status, headers });
}

// Narrows a resolved provider set against ALLOWED_PROVIDERS. Disallowed names
// move into `unknown` so the caller's existing 400 shape still applies.
export function applyProviderAllowlist(resolved, unknown, cfg) {
  if (!cfg.allowedProviders) return;
  for (const name of [...resolved]) {
    if (!cfg.allowedProviders.has(String(name).toLowerCase())) {
      resolved.delete(name);
      unknown.push(name);
    }
  }
}

export function isProviderAllowed(name, cfg) {
  if (!cfg.allowedProviders) return true;
  return cfg.allowedProviders.has(String(name).toLowerCase());
}

// Strips the query string (signed stream tokens live there) before logging.
export function redactUrl(raw) {
  const text = String(raw ?? "");
  const query = text.indexOf("?");
  return query === -1 ? text : `${text.slice(0, query)}?<redacted>`;
}
