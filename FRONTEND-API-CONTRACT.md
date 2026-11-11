# Group 935 Calculator — sanitized frontend API contract (local POC)

Date: 2026-11-11, America/Toronto (EST, UTC-5).

This file describes **only routes, shapes, and capabilities that are implemented** in `/workspace/935-balance-poc`. It is for the cloud frontend draft handoff. It does not invent unbuilt endpoints, cloud hostnames, CORS, or public HTTPS. It contains no credentials, secret names the frontend must hold, or token-handling requirements.

The running loopback process (PID 25370, started 12:21 America/Toronto) still serves the **previous** trader-only gate. A coordinated restart is required before these authorization fields and the Trader, Server Owner, and High Lvl Staff grants are live.

## Capabilities (implemented)

- Identity is server-owned. The browser never supplies the signed-in user’s Discord id, roles, or mode as authorization.
- Session after Discord OAuth is an HttpOnly, SameSite=Lax cookie (`g935_sid`). Tokens are not returned in HTML or JSON. The frontend does not send an `Authorization` header and does not need a client secret, bot token, or Killfeed key.
- Default account view is **My account**: the signed-in user’s identity, live guild roles, fail-closed discounts, and mapped cash/bank (when the Killfeed adapter is configured).
- **Trader mode** is an explicit UI mode, not a client-supplied privilege. It is allowed only when `GET /api/me` returns `access.trader_mode_allowed: true`, which the server sets after a fresh membership check if the user currently holds any **configured** elevated role: Trader, Server Owner, or High Level Staff.
- After a coordinated restart of this POC, all three elevated role IDs are configured: Trader (`1215060053191819324`, exact live name "Trader"), Server Owner (`1215040829186383912`, exact live name "Server Owner"), and High Lvl Staff (`1215042184764723251`). The High Level Staff grant is that unique verified Discord role. Alex's 12:24 phrase "High Level Staff" is a Design interpretation of that known abbreviation, not a claim that a literal role named "High Level Staff" exists, and not a fuzzy alias of any neighboring admin or staff role. Discord Administrator is not a grant. The frontend should use `access.trader_mode_allowed` and `access.grants`; it does not need to hard-code these IDs.
- Trader mode may look up a customer’s Discord member record and mapped cash/bank. That is scoped **read-only**. There are no cash-write or role-write routes (`balance.write_access` is always `false`; `/health` reports `balance_writes: false`).
- Query parameters such as `user_id`, `discord_id`, `is_trader`, `is_server_owner`, `is_high_level_staff`, `roles`, `role`, and `mode` are ignored for authorization and identity.
- This POC binds to `127.0.0.1:8787`. The persisted OAuth callback is `http://localhost:8787/auth/discord/callback`. A cloud origin is not implemented here and would need its own later-approved redirect URI.

## Frontend UI notes (not backend routes)

- Default the UI to My account (`GET /api/me`).
- Offer Trader mode only when `access.trader_mode_allowed` is true, and in that mode use a customer identity (search + player lookup). Do not treat a client toggle as authorization.
- Requested visual (not implemented in this POC): when Trader mode is active, put a highlighted border around the calculator.

## Public (no session)

### `GET /health` and `GET /status`

JSON, HTTP 200. Boolean configuration flags only. No secrets, role IDs, or tokens.

```json
{
  "ok": true,
  "service": "group-935-calculator-poc",
  "app_name": "Group 935 Calculator",
  "listen": "http://localhost:8787",
  "callback": "http://localhost:8787/auth/discord/callback",
  "scopes": ["identify", "guilds.members.read"],
  "guild_configured": true,
  "discord_oauth_configured": true,
  "trader_role_configured": true,
  "server_owner_role_configured": true,
  "high_level_staff_role_configured": true,
  "elevated_access_configured": true,
  "discount_roles_configured": false,
  "customer_lookup_configured": true,
  "killfeed_credentials_configured": true,
  "killfeed_credentials_source": "file",
  "killfeed_user_id_semantics_confirmed": true,
  "killfeed_response_mapped": true,
  "killfeed_balance_configured": true,
  "killfeed_search_configured": false,
  "killfeed_docs": "https://dayz-plus-plus-api.readme.io/",
  "killfeed_route": "GET /guilds/{guild_id}/economy/users/{user_id}",
  "balance_writes": false,
  "discord_gateway": false
}
```

`listen` uses the process port. `killfeed_credentials_source` is one of `file`, `env`, or `none`. After restart, `trader_role_configured`, `server_owner_role_configured`, `high_level_staff_role_configured`, and `elevated_access_configured` are expected true. The currently running PID 25370 does not yet include the newer role flags or the High Lvl Staff grant.

### `GET /`

HTML for the local POC page. Not the cloud frontend.

### `GET /auth/discord/login`

- 302 to Discord OAuth when Discord OAuth is configured, and sets HttpOnly cookie `g935_oauth` for CSRF/PKCE state.
- 503 `{ "error": "provider_unavailable", "provider": "discord_oauth", "reason": "not_configured" }` otherwise.

### `GET /auth/discord/callback`

Official OAuth callback. On success: 302 to `/` and sets `g935_sid`. On failure: 400 `{ "error": "invalid_state" }`, 502 `{ "error": "identity_unavailable" }`, or 502 `{ "error": "oauth_exchange_failed" }`. Query identity/role hints are ignored.

### `POST /auth/logout`

200 `{ "ok": true }` and clears `g935_sid`.

### `GET /auth/logout`

302 to `/` and clears `g935_sid`.

## Authenticated (session required)

Missing or expired session: **401** `{ "error": "unauthorized" }`.

### `GET /api/me` — My account (default)

Fresh membership check. Body:

```json
{
  "identity": { "id": "<discord user id>", "username": "", "global_name": "" },
  "guild": { "configured": true, "in_guild": true },
  "roles": {
    "current": ["<role id>", "..."],
    "trader_role_configured": true,
    "server_owner_role_configured": true,
    "high_level_staff_role_configured": true,
    "is_trader": false,
    "is_server_owner": true,
    "is_high_level_staff": false,
    "discounts": {
      "configured": false,
      "applied": [],
      "amounts_mapped": false,
      "reason": "discount_role_ids_unverified"
    }
  },
  "access": {
    "trader_mode_allowed": true,
    "grants": { "trader": false, "server_owner": true, "high_level_staff": false },
    "trader_role_configured": true,
    "server_owner_role_configured": true,
    "high_level_staff_role_configured": true,
    "writes": false,
    "source": "live_membership"
  },
  "balance": { "...": "see Balance object below" },
  "customer_lookup": { "configured": true, "available": true }
}
```

`is_trader` / `grants.trader` mean the user currently holds the Trader role, not “may open Trader mode.” Use `access.trader_mode_allowed` for the mode affordance. `customer_lookup.configured` / `available` follow whether the server-side Discord member lookup adapter is configured (they are the same boolean today).

When discounts later have a verified id→label map only, `discounts.applied` is `{ "role_id", "label" }[]`. Amounts stay unmapped (`amounts_mapped` is false) until a percentage policy is authorized.

### `GET /api/me/balance`

The Balance object only (the signed-in user).

### `GET /api/me/roles`

```json
{
  "in_guild": true,
  "roles": ["<role id>"],
  "trader_role_configured": true,
  "server_owner_role_configured": true,
  "high_level_staff_role_configured": true,
  "is_trader": false,
  "access": { "...": "same access object as /api/me" }
}
```

### `GET /api/trader/players/:id` — Trader mode, one customer

`:id` is a Discord user snowflake in the path (the customer). Gate: elevated role on the **session** user, freshly checked.

- 403 `{ "error": "forbidden", "reason": "elevated_role_not_configured" }` when no elevated role IDs are configured.
- 403 `{ "error": "forbidden", "reason": "elevated_role_required" }` when the signed-in user lacks a configured elevated role.
- 503 `{ "error": "provider_unavailable", "provider": "discord_member_lookup", "reason": "not_configured" }` when the bot lookup adapter is not configured (after the gate passes).
- Otherwise HTTP status follows the member lookup (200 if found). Body:

```json
{
  "lookup": {
    "id": "<requested discord user id>",
    "member": {
      "id": "<id>",
      "username": "",
      "global_name": "",
      "nick": "",
      "roles": ["<role id>"]
    }
  },
  "balance": { "...": "see Balance object; this is the customer's mapped cash/bank" },
  "live_customer_functionality": false
}
```

If member lookup fails, `lookup` is `{ "error", "reason", "provider" }` instead of `id`/`member`. `live_customer_functionality` is **currently always `false`** in this response even when lookup succeeds; the frontend should use the HTTP status plus `lookup` and `balance`, not this flag.

### `GET /api/trader/search?q=` — Trader mode, member search

Same session gate and 401/403/503 reasons as player lookup. `q` is required when the adapter is configured (400 `{ "reason": "missing_query", "provider": "discord_member_lookup" }` if empty).

Success:

```json
{
  "results": [
    { "id": "", "username": "", "global_name": "", "nick": "", "roles": [] }
  ],
  "live_customer_functionality": false,
  "killfeed_search": {
    "ok": false,
    "available": false,
    "status": 503,
    "provider": "killfeed_search",
    "reason": "not_configured",
    "write_access": false,
    "note": "No documented Killfeed customer-search route is available."
  }
}
```

There is no Killfeed search route. Search is Discord member search only.

## Balance object

Always present on `/api/me`, `/api/me/balance`, and trader player lookup. `write_access` is always false. Cash and bank are distinct integers plus matching digit strings. No unit, total, or spendability field is added.

When mapped and available:

```json
{
  "ok": true,
  "available": true,
  "mapped": true,
  "provider": "killfeed",
  "reason": "ok",
  "write_access": false,
  "docs": "https://dayz-plus-plus-api.readme.io/",
  "route": "GET /guilds/{guild_id}/economy/users/{user_id}",
  "cash": 0,
  "cash_str": "0",
  "bank": 0,
  "bank_str": "0"
}
```

`http_status` and `note` may also appear. If mapping or the adapter is not available, `cash` / `cash_str` / `bank` / `bank_str` are omitted, `available` and `mapped` are false, and `reason` explains the failure (for example `not_configured`).

## Errors used by these routes

| Status | Shape |
| --- | --- |
| 401 | `{ "error": "unauthorized" }` |
| 400 | `{ "error": "invalid_state" }` or lookup `{ "reason": "missing_query" \| "missing_user_id", "provider": "discord_member_lookup" }` |
| 403 | `{ "error": "forbidden", "reason": "elevated_role_required" \| "elevated_role_not_configured" }` |
| 404 | `{ "error": "not_found" }` |
| 502 | `{ "error": "identity_unavailable" }` or `{ "error": "oauth_exchange_failed" }` |
| 503 | `{ "error": "provider_unavailable", "provider": "...", "reason": "not_configured" }` |
| 500 | `{ "error": "internal_error" }` |

No other API routes are implemented.
