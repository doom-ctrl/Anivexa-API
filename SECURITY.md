# Security

Anivexa was written for a trusted local network: anyone who could reach the port could read
everything, and the answers said a lot about the machine serving them. This file describes the
controls that make it safe to expose on a public URL, and how to prove each one works.

Read `docs/notes/anivexa-api.md` in the izel repo, or the "How to verify" section below, for the
commands.

## The controls

| Control | What it does |
|---|---|
| **Bearer token** | `API_TOKEN` is required on every request as `Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual`. Missing or wrong -> `401 {"error":{"code":"unauthorized","message":"..."}}` |
| **Fail closed** | With `API_TOKEN` unset and `ALLOW_ANONYMOUS` not exactly `"true"`, every data route answers `503 {"error":{"code":"not_configured","message":"..."}}`. A deployment that forgets the token refuses to serve rather than serving everyone |
| **Narrow CORS** | No `Access-Control-Allow-Origin` header at all unless `ALLOWED_ORIGIN` names one origin, which is then echoed. A browser cannot call this API cross-origin from another site |
| **Private caching** | `/watch/*` and `/stream/*` answer `Cache-Control: private, no-store`, because those responses carry signed stream URLs that expire. Everything else keeps `public, max-age=300` |
| **No stacks** | No response body contains a `stack` property or a filesystem path. Stacks go to `console.error` only, where they belong. This covers the inline route catches, the per-provider error objects in `core/episode-strategy.js` and the per-provider `/watch` handlers |
| **Provider allowlist** | `ALLOWED_PROVIDERS` (comma separated) narrows what can be asked for. A name outside the list is treated as unknown, so it cannot reach that provider's code path, on the filtered episodes route or on the direct `/watch` `/stream` routes |
| **Unfiltered route off** | `GET /episodes/:anilistId` fans out to all 14 providers (121 s cold, ~320 KB). It answers `403 {"error":{"code":"forbidden","message":"..."}}` unless `ALLOW_UNFILTERED_EPISODES=true` |
| **Captcha route off** | `GET /captcha/mkissa` is a captcha-solving helper with no business being public. `403` unless `ALLOW_MKISSA_CAPTCHA=true`, and even then it needs the token |
| **Rate limit** | With `RATE_LIMIT_PER_MINUTE` set to a positive integer, a fixed 60-second window applies, keyed by the bearer token (or the client IP when anonymous). Over the limit -> `429 {"error":{"code":"rate_limited","message":"..."}}` with `Retry-After`. Upstash is used when configured, otherwise an in-memory window |
| **Redacted logs** | Request logging strips the query string, because stream URLs keep signed tokens there |

Flags are read as the exact string `"true"`: `TRUE`, `True` and `1` are all treated as **off**, so a
typo cannot open a gate.

## Environment variables

| Variable | Default in `.env.example` | Notes |
|---|---|---|
| `API_TOKEN` | empty | The shared secret. Empty means no token is required, which combined with `ALLOW_ANONYMOUS=false` means 503 |
| `ALLOW_ANONYMOUS` | `false` | `"true"` serves requests with no token. Only for a trusted private network |
| `ALLOWED_ORIGIN` | empty | One origin, echoed in `Access-Control-Allow-Origin`. Empty sends no CORS header |
| `ALLOWED_PROVIDERS` | empty | Empty allows every provider. `reanime,anizone,aniwaves` is what izel needs |
| `ALLOW_UNFILTERED_EPISODES` | `false` | `"true"` re-enables the 14-provider route |
| `ALLOW_MKISSA_CAPTCHA` | `false` | `"true"` re-enables the captcha helper |
| `RATE_LIMIT_PER_MINUTE` | empty | Positive integer turns the limiter on |
| `CACHE_ENABLED`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `DEFAULT_REDIS_TTL` | — | Existing cache settings. On a serverless host the memory and disk tiers are unavailable (`process.env.VERCEL` is detected), so Upstash is the only working cache, and it is also what makes the rate limiter shared across instances |
| `MKISSA_WREQ_BROWSER`, `MKISSA_WREQ_OS`, `MKISSA_WREQ_REQUIRED`, `SENSHI_WREQ_BROWSER`, `SENSHI_WREQ_OS` | — | Existing wreq-js settings for MKissa and Senshi |

## What this does not do

- **The token is all-or-nothing.** There is no per-user identity, no scopes and no revocation beyond
  changing the variable. Anyone holding it has the whole API, including the right to ask for any
  allowed provider's stream URLs.
- **The rate limiter is per instance without Redis.** The in-memory window is one process's view, so
  a multi-instance deployment can allow up to `RATE_LIMIT_PER_MINUTE` per instance per minute. Set
  Upstash for a real limit.
- **Upstream failures still happen.** Providers go down, AniList rate-limits (30 requests/minute) and
  its identity layer is what this API is built on. Nothing here changes that; `/home` tells you the
  API is alive, not that its providers are.
- **An unknown path answers the version payload with 200**, as it always has. It exposes the version,
  the provider list and the route list, and nothing else.

## Deploying on Vercel

`vercel.json` deploys `api/index.js` as a **Node** function. The worker needs Node: it uses
`Buffer`, `process.env`, `node:fs` for the disk cache and the `wreq-js` native addon. The Edge
entrypoint (`api/handler.js`) was removed for that reason.

Two things to know:

1. The rewrites forward the original path in `__anivexa_path`, because a rewrite replaces the path a
   function sees. `api/index.js` restores it before handing the request to the worker.
2. `server.js` is not used on Vercel, so the four static paths it serves (`/`, `/docs`,
   `/style.css`, `/logo.svg`) do not exist there. `/` is answered by the worker with the version
   payload instead. The landing page is not served.

`CACHE_ENABLED=true` plus Upstash credentials are strongly recommended: without a cache every edge
request fans out to the providers, which is how an IP gets blocked, and without Redis the rate
limiter is per instance.

## How to verify

From a machine that is not the server (or with `curl` against a preview deployment):

```bash
# No token: refused
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/home                      # 401

# With the token: served
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $API_TOKEN" https://<host>/home   # 200

# Nothing leaks a stack or a path
curl -s -H "Authorization: Bearer $API_TOKEN" "https://<host>/watch/anizone/11061/dub/anizone-1" | grep -c stack   # 0

# Stream responses are private
curl -s -D - -o /dev/null -H "Authorization: Bearer $API_TOKEN" \
  "https://<host>/watch/anizone/11061/sub/anizone-1" | grep -i cache-control     # private, no-store

# The expensive and dangerous routes are closed
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $API_TOKEN" https://<host>/episodes/11061      # 403
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $API_TOKEN" https://<host>/captcha/mkissa     # 403

# No CORS header unless ALLOWED_ORIGIN is set
curl -s -D - -o /dev/null -H "Authorization: Bearer $API_TOKEN" https://<host>/home | grep -ci access-control   # 0
```

A throwaway harness kept outside both repos, `anivexa-secure-check.mjs`, runs these as one report with
raw evidence for every check. It is not part of this repo.

## Verified locally

On this machine, against an instance started from this code: 24 acceptance checks passed with 0
failures (401 without a token, malformed headers, the correct token, preflight, no stacks anywhere,
private caching on stream routes, no CORS by default, the unfiltered and captcha routes at 403, the
provider allowlist, and every response carrying its evidence). Rate limiting was verified on a
scratch instance at `RATE_LIMIT_PER_MINUTE=3`: three requests served, the fourth `429` with
`Retry-After: 60` and `error.code "rate_limited"`, an invalid token still returning `401` rather than
`429`, and the window resetting after 60 seconds. CORS was verified on a second scratch instance with
`ALLOWED_ORIGIN` set: `204` preflight and `200` response both echoing that one origin. izel was
checked end to end through the hardened API: `/api/title/:id`, `/api/episodes/:id`, `/api/play/:id/...`
and the home page all answer `200`, and with a deliberately wrong token the title page still renders
with readable per-part errors while `/api/play` fails in milliseconds with `anivexa_error`.
