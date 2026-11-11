'use strict';

const { createRateLimiter } = require('./http-util');

const USER_AGENT = 'Group935CalculatorPOC (http://localhost:8787; read-only; http-only-bot; no-gateway)';

// Allowlisted bot HTTP GET routes only. Official citations:
// https://docs.discord.com/developers/resources/guild
// https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent
// https://docs.discord.com/developers/events/gateway
//   GET /guilds/{guild.id}/members/{user.id}  — no GUILD_MEMBERS intent
//   GET /guilds/{guild.id}/members/search     — no GUILD_MEMBERS intent
//   GET /guilds/{guild.id}/roles              — no GUILD_MEMBERS intent, no listed permission bit
//   GET /guilds/{guild.id}/members            — requires GUILD_MEMBERS even over HTTP; never call it
// Live success with permissions=0 after guild install is not yet verified.
// Do not open a Gateway session. Privileged Gateway Intents stay off.

const ALLOWED_BOT_GET = [
  /^\/guilds\/[^/]+\/members\/[^/]+$/,
  /^\/guilds\/[^/]+\/members\/search$/,
  /^\/guilds\/[^/]+\/roles$/,
];

function isAllowlistedBotPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  const pathname = path.split('?')[0];
  if (/^\/guilds\/[^/]+\/members$/.test(pathname)) return false;
  return ALLOWED_BOT_GET.some((re) => re.test(pathname));
}

function createDiscordBotLookup(config, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch.bind(globalThis);
  const limiter = deps.limiter || createRateLimiter({ minIntervalMs: 250 });
  const logger = deps.logger;
  const configured = Boolean(config.discordBotToken && config.discordGuildId);

  async function botGet(path) {
    if (!isAllowlistedBotPath(path)) {
      return {
        ok: false,
        status: 403,
        reason: 'route_not_allowlisted',
        provider: 'discord_member_lookup',
      };
    }
    let res;
    try {
      await limiter.waitForSlot();
      res = await fetchImpl(`${config.discordApiBase}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bot ${config.discordBotToken}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      });
      limiter.noteHeaders(res.headers);
    } catch {
      return { ok: false, status: 502, reason: 'provider_error', provider: 'discord_member_lookup' };
    }
    if (res.status === 404) return { ok: false, status: 404, reason: 'not_found', provider: 'discord_member_lookup' };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const code = body && body.code != null ? body.code : undefined;
      const message = body && typeof body.message === 'string' ? body.message.replace(/[\r\n]/g, ' ').slice(0, 180) : '';
      const safePath = String(path || '').split('?')[0].slice(0, 180);
      if (logger && typeof logger.error === 'function') {
        logger.error('discord_api_error', { status: res.status, code, message, path: safePath });
      }
      return { ok: false, status: res.status, reason: 'provider_error', provider: 'discord_member_lookup', code, message };
    }
    try {
      return { ok: true, status: res.status, data: await res.json() };
    } catch {
      return { ok: false, status: 502, reason: 'provider_error', provider: 'discord_member_lookup' };
    }
  }

  return {
    isConfigured() {
      return configured;
    },
    unavailable(reason = 'not_configured') {
      return {
        ok: false,
        status: 503,
        error: 'provider_unavailable',
        provider: 'discord_member_lookup',
        reason,
      };
    },
    async getMember(userId) {
      if (!configured) return this.unavailable();
      if (!userId) return { ok: false, status: 400, reason: 'missing_user_id', provider: 'discord_member_lookup' };
      return botGet(`/guilds/${encodeURIComponent(config.discordGuildId)}/members/${encodeURIComponent(userId)}`);
    },
    async searchMembers(query) {
      if (!configured) return this.unavailable();
      const q = String(query || '').trim();
      if (q.length < 2) return { ok: false, status: 400, reason: 'query_too_short', provider: 'discord_member_lookup' };
      if (q.length > 32) return { ok: false, status: 400, reason: 'query_too_long', provider: 'discord_member_lookup' };
      const path = `/guilds/${encodeURIComponent(config.discordGuildId)}/members/search?query=${encodeURIComponent(q)}&limit=10`;
      return botGet(path);
    },
    async listRoles() {
      if (!configured) return this.unavailable();
      return botGet(`/guilds/${encodeURIComponent(config.discordGuildId)}/roles`);
    },
    // Test/inspection only: never used by HTTP routes.
    _botGet: botGet,
  };
}

module.exports = { createDiscordBotLookup, isAllowlistedBotPath };
