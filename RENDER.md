# Render deploy contract

This file is the host contract for a later manual deploy. It does not create a Render service, spend money, or name a live public origin. Alex reports a card was added and the Render dashboard shows it on file. No charge has been made and no service has been created. The real tax-inclusive charge is still unknown, so this change does not accept that charge or create the service.

GitHub Pages on `main` stays the static calculator. That copy does not set an account gateway and does not run Node.

## Service shape

One Web Service. One instance. No autoscaling. No persistent disk. No database. Sessions stay in process memory and are lost on restart.

| Setting | Value |
| --- | --- |
| Root directory | repository root |
| Environment | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/health` |
| Bind | `0.0.0.0` and `PORT` (Render sets `PORT`) |

`npm start` runs `node server.js`. There are no npm dependencies. The build does not call Discord or Killfeed.

`GET /health` and `GET /status` return HTTP 200 JSON. They report configuration flags only. They do not return secrets, role-bearing session data, or balances.

## Same origin

`GET /` serves `index.html` and injects `window.__935AccountGateway = window.location.origin` into that response only. The file in git does not contain that assignment, so GitHub Pages keeps the offline “Sign-in is not configured” state and makes no account request.

The browser then calls only these same-origin routes, with `credentials: "include"` and no `Authorization` header:

- `GET /api/me`
- `GET /api/trader/search?q=`
- `GET /api/trader/players/{id}`
- `POST /auth/logout`
- `GET /auth/discord/login`

Trader mode is allowed only when `access.trader_mode_allowed` is true after a fresh membership check. The server grants that for the configured Trader, Server Owner, or High Lvl Staff role. The browser does not decide.

## Environment reference

Set these on the host. Do not commit values.

| Name | Host requirement |
| --- | --- |
| `PORT` | Set by Render. Do not hardcode it. |
| `COOKIE_SECURE` | `true` |
| `COOKIE_SAMESITE` | `Lax` |
| `SESSION_SECRET` | Required. At least 32 characters. Durable across restarts of the same instance. The process refuses a public bind without it. |
| `DISCORD_CLIENT_ID` | `1569978589556904077` |
| `DISCORD_CLIENT_SECRET` | Host secret. Not in git. |
| `DISCORD_BOT_TOKEN` | Host secret. Not in git. |
| `DISCORD_REDIRECT_URI` | Exact `https://<render-host>/auth/discord/callback` after the service URL exists. Register that URI on the existing Discord app. Do not invent the host in source. |
| `DISCORD_GUILD_ID` | `1213578527522431046` |
| `DISCORD_TRADER_ROLE_ID` | `1215060053191819324` |
| `DISCORD_SERVER_OWNER_ROLE_ID` | `1215040829186383912` |
| `DISCORD_HIGH_LEVEL_STAFF_ROLE_ID` | `1215042184764723251` (Discord label `High Lvl Staff`) |
| `KILLFEED_API_BASE` | `https://api.killfeed.xyz` |
| `KILLFEED_GUILD_ID` | `1213578527522431046` |
| `KILLFEED_USER_ID_SEMANTICS` | `discord_user_id` |
| `KILLFEED_API_KEY` or `KILLFEED_API_KEY_FILE` | Host secret. Prefer a Render secret file. Not in git. |

The process exits if it is asked to bind a non-loopback address without `COOKIE_SECURE=true`, a long `SESSION_SECRET`, and an explicit `https` callback. It does not guess a hostname.

When a service is created later, Auto-Deploy must be Off. A git push must not create or update a paid instance.

Catalog writes need a durable directory. The hosting note for the current single instance is a 1 GB disk mounted at `/var/data` (about US$0.25 per month). That disk is not approved and is not created here. It also turns off Render zero-downtime deploys. Until it is approved and mounted, leave `CATALOG_STORE` unset. Writes then fail closed and the calculator keeps the published prices, stock, and zero catalog discounts.

| Name | When durable storage is approved |
| --- | --- |
| `CATALOG_STORE` | `file` |
| `CATALOG_STORE_PATH` | `/var/data/catalog.json` |

The path must stay under `/var/data/`. Any other path, or a missing directory, refuses catalog saves. The process does not create the disk, the directory, or a git commit.

## Request boundary

The canonical origin is only the origin of `DISCORD_REDIRECT_URI`. Hosted mode accepts that value when it is `https`, has no userinfo, and its path is exactly `/auth/discord/callback`. The Host header must name that host (`:443` is the same host). A different Host gets HTTP 421 and the response does not echo it.

`X-Forwarded-Proto` is not a scheme, a cookie flag, or a redirect. On ordinary hosted routes a present value must be exactly `https`. A missing value is allowed, because normal browser navigation does not send it and the app does not need it. `/health` and `/status` ignore the header. Render terminates TLS at the edge and probes the process over plain HTTP; a probe that omits the header, or sends `http`, still gets HTTP 200 and is not redirected. Render sets the health-check Host to a verified custom domain when one exists, otherwise the service hostname. That host has to be the callback host. This repo does not read `RENDER_EXTERNAL_HOSTNAME`.

Origin is optional. A normal page load and the Discord callback often omit it. When Origin is present it must be the canonical origin. The callback may also carry the Discord authorize origin. Responses do not copy Origin, Host, or forwarded headers into `Location`, a cookie `Domain`, or the HTML. Login redirects only to the configured Discord authorize URL. Logout and a successful callback redirect to the relative path `/`.

The local mock path works only when the callback is explicitly `http://localhost` or `http://127.0.0.1` and `COOKIE_SECURE` is off. That path accepts those loopback names on any port and ignores `X-Forwarded-Proto`.

## Limits that stay in code

- Cash and bank are separate integers plus matching digit strings. Extra fields, a total, or a unit are rejected.
- Killfeed calls are GET only, at least 2 seconds apart, honoring `RateLimit-Policy: 30;w=60;gcra-burst=3`.
- The bot client may GET only guild member-by-id, member search, and guild roles. It never lists all members and never opens a Discord gateway.
- `balance.write_access` and `balance_writes` stay false. There is no cash-write or role-write route.
- Cookies `g935_sid` and `g935_oauth` are HttpOnly and SameSite=Lax, with no `Domain` attribute. `Secure` is on when `COOKIE_SECURE=true`.
