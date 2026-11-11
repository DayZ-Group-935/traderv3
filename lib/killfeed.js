'use strict';

const { DEFAULT_KILLFEED_BASE, KILLFEED_DOCS, KILLFEED_ECONOMY_ROUTE } = require('./config');
const { createRateLimiter } = require('./http-util');
const { mapEconomyBody, providerError } = require('./killfeed-map');

// Read-only adapter for the official DayZ++ / Killfeed route:
//   GET https://api.killfeed.xyz/guilds/{guild_id}/economy/users/{user_id}
//   Header: Api-Key
// Strict mapping uses the 2026-11-11 12:15 America/Toronto verified schema.
// No search. No writes. No extra live calls from tests.
const USER_AGENT = 'Group935CalculatorPOC (http://localhost:8787; read-only)';
const REQUEST_TIMEOUT_MS = 15000;
// Observed live policy: RateLimit-Policy 30;w=60;gcra-burst=3
const KILLFEED_MIN_INTERVAL_MS = 2000;

function createKillfeedAdapter(config, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch.bind(globalThis);
  const limiter = deps.limiter || createRateLimiter({ minIntervalMs: KILLFEED_MIN_INTERVAL_MS });
  const base = (config.killfeedApiBase || DEFAULT_KILLFEED_BASE).replace(/\/+$/, '');
  const credentialsConfigured = Boolean(config.killfeedApiKey && config.killfeedGuildId);
  const semanticsConfirmed = config.killfeedUserIdSemantics === 'discord_user_id';
  const responseMapped = config.killfeedResponseMapped === true;

  function notConfigured() {
    return {
      ok: false,
      available: false,
      mapped: false,
      provider: 'killfeed',
      reason: 'not_configured',
      write_access: false,
      docs: KILLFEED_DOCS,
      route: KILLFEED_ECONOMY_ROUTE,
    };
  }

  function baseMeta(extra) {
    return {
      provider: 'killfeed',
      write_access: false,
      docs: KILLFEED_DOCS,
      route: KILLFEED_ECONOMY_ROUTE,
      ...extra,
    };
  }

  return {
    name: 'killfeed',
    docs: KILLFEED_DOCS,
    route: KILLFEED_ECONOMY_ROUTE,
    isConfigured() {
      return credentialsConfigured;
    },
    isSearchConfigured() {
      return false;
    },
    isMapped() {
      return responseMapped;
    },
    isReady() {
      return credentialsConfigured && semanticsConfirmed && responseMapped;
    },
    search() {
      return {
        ok: false,
        available: false,
        status: 503,
        provider: 'killfeed_search',
        reason: 'not_configured',
        write_access: false,
        note: 'No documented Killfeed customer-search route is available.',
      };
    },
    economyUrl(userId) {
      if (!config.killfeedGuildId || !userId) return null;
      return `${base}/guilds/${encodeURIComponent(config.killfeedGuildId)}/economy/users/${encodeURIComponent(userId)}`;
    },
    async getEconomyUser(userId) {
      if (!credentialsConfigured) return notConfigured();
      if (!semanticsConfirmed) {
        return baseMeta({
          ok: false,
          available: false,
          mapped: false,
          reason: 'user_id_semantics_unconfirmed',
          note: 'Killfeed {user_id} semantics are not confirmed. Discord user ids will not be sent until configured as discord_user_id.',
        });
      }
      if (!userId) {
        return baseMeta({
          ok: false,
          available: false,
          mapped: false,
          reason: 'missing_user_id',
        });
      }

      await limiter.waitForSlot();
      let res;
      try {
        res = await fetchImpl(this.economyUrl(userId), {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            'Api-Key': config.killfeedApiKey,
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
        });
      } catch {
        return baseMeta({
          ok: false,
          available: false,
          mapped: false,
          reason: 'provider_error',
        });
      }
      limiter.noteHeaders(res.headers);

      if (!res.ok) {
        return baseMeta(providerError(res.status));
      }
      if (!responseMapped) {
        return baseMeta({
          ok: true,
          available: false,
          mapped: false,
          reason: 'response_mapping_pending_sanitized_test',
          http_status: res.status,
        });
      }

      let body;
      try {
        body = await res.json();
      } catch {
        return baseMeta({
          ok: false,
          available: false,
          mapped: false,
          reason: 'schema_invalid',
          http_status: res.status,
        });
      }

      const mapped = mapEconomyBody(body);
      return baseMeta({ ...mapped, http_status: res.status });
    },
    async getBalance(userId) {
      return this.getEconomyUser(userId);
    },
  };
}

module.exports = { createKillfeedAdapter, KILLFEED_MIN_INTERVAL_MS, REQUEST_TIMEOUT_MS };
