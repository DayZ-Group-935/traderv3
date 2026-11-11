# Group 935 Calculator — sanitized backend source and hosting prep

Date: 2026-11-11 12:54 America/Toronto (EST, UTC-5).

This is the nonsecret deployment contract for an existing cloud agent. It packages the local Node POC so it can be integrated with the traderv3 draft PR #4 UI into a **single-origin**, Render-deployable source tree. Public source is acceptable. **Secrets must never be added to this archive, a git repo, or the public calculator.**

This file does not create a Render account, service, DNS record, or purchase. It does not change Discord app settings. It does not claim a live HTTPS deploy.

## What this archive contains

Backend code, mock tests, nonsecret IDs, and contracts only:

- `server.js`, `package.json`, `lib/**`
- `test/mock-tests.js` (labeled MOCK only; not a live provider test)
- `runtime-ids.json` (nonsecret app, guild, and role IDs)
- `.env.example` (variable **names** and empty placeholders; no values)
- `.gitignore`, `README.md`, `SETUP.md`, `FRONTEND-API-CONTRACT.md`, this file
- `ALLOWLIST.txt`, `AUDIT-REPORT.md`

`package.json` has no npm dependencies. Node 18+ is required.

## What this archive must not contain

These were excluded by explicit allowlist, not glob:

- `secrets/` and `secrets/killfeed-api-key`
- any `.env` (none was present in the source tree; still excluded)
- `live/` (Get Roles / Get Member evidence responses, `server.pid`)
- `scripts/live-discord-verify.js` (live bot-token caller; not deploy source)
- logs, session stores, personal OAuth tokens, `node_modules/`

The box still holds `DISCORD_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` in process environment, and the Killfeed key at the existing `secrets/killfeed-api-key` path. Those were left **untouched** and are **not** in this archive. Existing Killfeed key 22 must never be viewed, used, or replaced.

## Intended later shape (not implemented in the packaged `server.js`)

Alex approved the $7/month Render recommendation on 2026-11-11 (“Ok lets do it”). The planned host is one Render **Web Service** on a Hobby workspace, always-on compute plan **`0.5c-512mb`**, official **`$7/month`**, single instance, no autoscaling, no persistent disk for sessions (see SETUP.md 12:37 research section and https://render.com/pricing). Public `onrender.com` URL plus managed TLS is enough to start; a custom domain is not required for the first deploy.

The cloud agent should make the **traderv3 PR #4** calculator UI and this Node backend one origin, so the browser can use the HttpOnly `g935_sid` cookie with `credentials: "include"` and no `Authorization` header. PR #4 leaves `window.__935AccountGateway` unset in production; after same-origin integration it should point at this host (same origin, for example `""` or the public HTTPS origin) so the page calls the implemented routes in `FRONTEND-API-CONTRACT.md`.

## Code and config the cloud agent must still change

The packaged server is the **loopback POC**. It is not Render-ready as-is:

1. **Bind address.** `server.js` currently listens on `127.0.0.1` and `config.port` (default 8787). A Render web service must bind `0.0.0.0` and `process.env.PORT` (Render default `10000`). Do not keep a loopback-only bind in the deployed process.
2. **GET `/` UI.** The POC serves `lib/page.js`, not the PR #4 calculator. Serve the draft PR #4 `index.html` (and its assets) from this same process. Keep calculator mechanics unchanged except for the account-mode UI already in that draft.
3. **OAuth redirect.** The packaged default is `http://localhost:8787/auth/discord/callback`. Discord requires HTTPS for non-localhost redirects. A later, exact public HTTPS callback must be set as `DISCORD_REDIRECT_URI` and added on the existing Discord app `1569978589556904077` (the localhost URI may be kept if still wanted). That portal change is not done in this prep.
4. **Cookies.** For HTTPS, set `COOKIE_SECURE=true` and keep `COOKIE_SAMESITE=Lax`. Set a durable `SESSION_SECRET` in the host environment. If it is unset, this POC generates a temporary per-process secret and sessions die on restart.
5. **Secrets on the host, never in git.** Supply as Render environment variables or Render secret files (`/etc/secrets/<filename>`), not in source:
   - `DISCORD_CLIENT_SECRET`
   - `DISCORD_BOT_TOKEN`
   - `SESSION_SECRET`
   - Killfeed API key via `KILLFEED_API_KEY_FILE` (preferred) or `KILLFEED_API_KEY`
   - Already nonsecret in `runtime-ids.json` / env: `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, role IDs, `KILLFEED_GUILD_ID=1213578527522431046`, `KILLFEED_USER_ID_SEMANTICS=discord_user_id`, `KILLFEED_API_BASE=https://api.killfeed.xyz`
6. **Do not invent routes.** Use only the implemented API in `FRONTEND-API-CONTRACT.md`. Authorization is `access.trader_mode_allowed` after a fresh membership check (Trader OR Server Owner OR High Lvl Staff). No cash or role writes. Honor Killfeed `RateLimit-Policy: 30;w=60;gcra-burst=3`.

## Verified nonsecret IDs (safe in public source)

- Discord app / client id: `1569978589556904077` (Group 935 Calculator)
- Guild: `1213578527522431046`
- Trader role: `1215060053191819324` (exact live name "Trader")
- Server Owner role: `1215040829186383912` (exact live name "Server Owner")
- High Lvl Staff role: `1215042184764723251` — Design interpretation of Alex’s 12:24 phrase “High Level Staff” as that unique verified Discord label, not a literal exact-name claim and not an alias of other staff/admin roles

## Known issues / do not claim

- No Render service, plugin install, account, or purchase was created in this prep.
- No public origin exists yet, so there is no live auth claim and no completed browser OAuth on HTTPS.
- Draft PR #4 is not merged. GitHub Pages (`https://dayz-group-935.github.io/traderv3/`) is static-only and cannot run this Node process.
- This POC has no CORS/credentialed cross-origin cookie support; same-origin is the intended fix, not a new cookie domain hack.
- In-memory sessions are lost on restart; stay on one always-on instance. Do not use Render Free (spin-down).
- A first elevated own-session test can use Alex’s Server Owner grant after real HTTPS OAuth. A separate Trader-role account is still needed for trader-gate coverage. Alex does not hold Trader.
- Do not restart or rely on the stopped local loopback server (former PID 25370). Localhost OAuth in the bot browser is an intentional block.

## Tests

From this archive root: `node test/mock-tests.js`. Results are MOCK only.
