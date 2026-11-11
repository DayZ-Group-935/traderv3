# Render deploy contract

This file is the host contract for a later manual deploy. It does not create a Render service, spend money, or name a live public origin. Payment is not ready: Render does not take PayPal, and no card has been entered. Do not start a paid instance from this change.

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

The process exits if it is asked to bind a non-loopback address without `COOKIE_SECURE=true` and a long `SESSION_SECRET`.

## Limits that stay in code

- Cash and bank are separate integers plus matching digit strings. Extra fields, a total, or a unit are rejected.
- Killfeed calls are GET only, at least 2 seconds apart, honoring `RateLimit-Policy: 30;w=60;gcra-burst=3`.
- The bot client may GET only guild member-by-id, member search, and guild roles. It never lists all members and never opens a Discord gateway.
- `balance.write_access` and `balance_writes` stay false. There is no cash-write or role-write route.
- Cookies `g935_sid` and `g935_oauth` are HttpOnly and SameSite=Lax. `Secure` is on when `COOKIE_SECURE=true`.
