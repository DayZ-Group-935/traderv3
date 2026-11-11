'use strict';

const { createRateLimiter } = require('./http-util');

const USER_AGENT = 'Group935CalculatorPOC (http://localhost:8787; read-only)';

function createDiscordOAuth(config, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch.bind(globalThis);
  const limiter = deps.limiter || createRateLimiter();

  function authorizeUrl(state, challenge) {
    const url = new URL(config.discordAuthorizeUrl);
    url.searchParams.set('client_id', config.discordClientId);
    url.searchParams.set('redirect_uri', config.discordRedirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', config.discordScopes);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  }

  async function tokenRequest(body) {
    await limiter.waitForSlot();
    const res = await fetchImpl(`${config.discordApiBase}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body,
    });
    limiter.noteHeaders(res.headers);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error('discord_token_exchange_failed');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function exchangeCode(code, verifier) {
    const body = new URLSearchParams({
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.discordRedirectUri,
      code_verifier: verifier,
    });
    return tokenRequest(body);
  }

  async function refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return tokenRequest(body);
  }

  async function authorizedGet(accessToken, path) {
    await limiter.waitForSlot();
    const res = await fetchImpl(`${config.discordApiBase}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    limiter.noteHeaders(res.headers);
    if (res.status === 401) {
      const err = new Error('discord_unauthorized');
      err.status = 401;
      throw err;
    }
    if (res.status === 404) return { status: 404, data: null };
    if (!res.ok) {
      const err = new Error('discord_api_error');
      err.status = res.status;
      throw err;
    }
    return { status: res.status, data: await res.json() };
  }

  async function getCurrentUser(accessToken) {
    const { data } = await authorizedGet(accessToken, '/users/@me');
    return data;
  }

  // Self-only: guilds.members.read. Cannot be used to read other members.
  async function getCurrentMember(accessToken, guildId) {
    const { status, data } = await authorizedGet(
      accessToken,
      `/users/@me/guilds/${encodeURIComponent(guildId)}/member`
    );
    if (status === 404 || !data) return null;
    return data;
  }

  return {
    authorizeUrl,
    exchangeCode,
    refreshAccessToken,
    getCurrentUser,
    getCurrentMember,
  };
}

function applyTokenToSession(session, token) {
  const expiresIn = Number(token.expires_in) || 0;
  session.accessToken = token.access_token;
  if (token.refresh_token) session.refreshToken = token.refresh_token;
  if (token.scope) session.scope = token.scope;
  session.tokenExpiresAt = Date.now() + Math.max(0, expiresIn - 30) * 1000;
  return session;
}

module.exports = { createDiscordOAuth, applyTokenToSession, USER_AGENT };
