'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, publicStatus } = require('./lib/config');
const { createLogger } = require('./lib/log');
const { createSessionStore } = require('./lib/sessions');
const { createOAuthStateStore } = require('./lib/oauth-state');
const { createDiscordOAuth, applyTokenToSession } = require('./lib/discord-oauth');
const { createDiscordBotLookup } = require('./lib/discord-bot-lookup');
const { createKillfeedAdapter } = require('./lib/killfeed');
const { currentMembership, evaluateTraderAccess, selfPayload, accessPayload } = require('./lib/access');
const {
  parseCookies,
  cookieHeader,
  clearCookie,
  sendJson,
  sendHtml,
  sendRedirect,
  readUrl,
} = require('./lib/http-util');
const { canonicalFromRedirect, assessRequest, safeAuthorizeLocation } = require('./lib/request-guard');
const { loadBaseCatalog } = require('./lib/catalog-base');
const { openCatalogStoreFromEnv } = require('./lib/catalog-store');
const { handleCatalogRoutes } = require('./lib/catalog-routes');
const { pricingRoleNames } = require('./lib/role-rules');

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Hosted HTTPS (Render) must not boot with an ephemeral session secret or an
// insecure cookie. Loopback without COOKIE_SECURE keeps the local POC path.
function assertHostReady(config, host) {
  if (isLoopbackHost(host) && !config.cookieSecure) {
    const local = canonicalFromRedirect(config.discordRedirectUri);
    if (!local || local.mode !== 'local') {
      throw new Error('Local loopback requires an explicit http://localhost or http://127.0.0.1 DISCORD_REDIRECT_URI.');
    }
    return;
  }
  if (!config.cookieSecure) {
    throw new Error('COOKIE_SECURE=true is required when the process is not bound to loopback.');
  }
  if (config.sessionSecretGenerated || !config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error('A durable SESSION_SECRET of at least 32 characters is required when COOKIE_SECURE is true.');
  }
  const canon = canonicalFromRedirect(config.discordRedirectUri);
  if (!canon || canon.mode !== 'https') {
    throw new Error('DISCORD_REDIRECT_URI must be an explicit https callback on the public host. No hostname is guessed.');
  }
}

function calculatorDocument(config) {
  const file = path.join(config.root, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const inject = '<script>window.__935AccountGateway=window.location.origin;</script>';
  const marker = html.indexOf('<script>');
  if (marker < 0) throw new Error('calculator script tag missing');
  return html.slice(0, marker) + inject + html.slice(marker);
}

function cookieOpts(config, maxAge) {
  const opts = {
    httpOnly: true,
    sameSite: config.cookieSameSite || 'Lax',
    secure: Boolean(config.cookieSecure),
    path: '/',
  };
  if (maxAge != null) opts.maxAge = maxAge;
  return opts;
}

function ignoredCallerHints(url) {
  // Present so tests can prove these are never used for identity or roles.
  return {
    user_id: url.searchParams.get('user_id') || url.searchParams.get('discord_id'),
    is_trader: url.searchParams.get('is_trader'),
    roles: url.searchParams.get('roles'),
    role: url.searchParams.get('role'),
  };
}

function createApp(options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || createLogger(config);
  const sessions = options.sessions || createSessionStore();
  const oauthStates = options.oauthStates || createOAuthStateStore();
  const oauth = options.oauth || createDiscordOAuth(config, { fetch: options.fetch, logger });
  const botLookup = options.botLookup || createDiscordBotLookup(config, { fetch: options.fetch, logger });
  const killfeed = options.killfeed || createKillfeedAdapter(config, { fetch: options.fetch });
  const catalogStore = options.catalogStore || openCatalogStoreFromEnv();
  let baseCatalog = [];
  try {
    baseCatalog = options.baseCatalog || loadBaseCatalog();
  } catch (err) {
    logger.error('catalog_base', { message: err && err.message });
  }

  async function sessionFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[sessions.cookieName];
    const rec = sessions.touch(sid);
    if (!rec) return null;
    if (rec.tokenExpiresAt && rec.tokenExpiresAt < Date.now()) {
      if (!rec.refreshToken) {
        sessions.destroy(sid);
        return null;
      }
      try {
        const token = await oauth.refreshAccessToken(rec.refreshToken);
        applyTokenToSession(rec, token);
      } catch {
        sessions.destroy(sid);
        return null;
      }
    }
    return rec;
  }

  async function requireSession(req, res) {
    const session = await sessionFromRequest(req);
    if (!session) {
      sendJson(res, 401, { error: 'unauthorized' });
      return null;
    }
    return session;
  }

  function providerDown(err) {
    logger.error('discord_api_error', {
      status: err && err.status,
      code: err && err.discordCode,
      message: err && err.discordMessage,
      path: err && err.discordPath,
    });
    return {
      allowed: false,
      status: 503,
      error: 'provider_unavailable',
      reason: 'membership_unavailable',
    };
  }

  async function openTraderGate(session) {
    try {
      return await evaluateTraderAccess(session, oauth, config);
    } catch (err) {
      if (err && err.status === 401 && session.refreshToken) {
        try {
          const token = await oauth.refreshAccessToken(session.refreshToken);
          applyTokenToSession(session, token);
          session.membershipCache = null;
          return await evaluateTraderAccess(session, oauth, config);
        } catch (retryErr) {
          if (retryErr && retryErr.status === 401) {
            return { allowed: false, status: 401, error: 'unauthorized', reason: 'unauthorized' };
          }
          return providerDown(retryErr);
        }
      }
      if (err && err.status === 401) {
        return { allowed: false, status: 401, error: 'unauthorized', reason: 'unauthorized' };
      }
      return providerDown(err);
    }
  }

  function sendTraderGate(res, gate, logReq, session) {
    const status = gate.status === 401 || gate.status === 503 ? gate.status : 403;
    sendJson(res, status, {
      error: gate.error || 'forbidden',
      reason: gate.reason,
      provider: status === 503 ? 'discord_oauth' : undefined,
    });
    logger.request(logReq, status, { reason: gate.reason, user: session.discordUserId });
  }

  async function liveMembership(session) {
    try {
      return await currentMembership(session, oauth, config);
    } catch (err) {
      if (err && err.status === 401 && session.refreshToken) {
        const token = await oauth.refreshAccessToken(session.refreshToken);
        applyTokenToSession(session, token);
        return currentMembership(session, oauth, config);
      }
      throw err;
    }
  }

  async function handle(req, res) {
    const url = readUrl(req);
    const method = req.method || 'GET';
    if (!url) {
      sendJson(res, 400, { error: 'invalid_request' });
      logger.request({ method, url: '' }, 400, { reason: 'invalid_request' });
      return;
    }
    const path = url.pathname;
    const verdict = assessRequest(config, req, path, method);
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.error });
      logger.request({ method, url: path }, verdict.status, { reason: verdict.error });
      return;
    }
    const logReq = { method, url: path };

    if (path === '/health' || path === '/status') {
      sendJson(res, 200, publicStatus(config));
      logger.request(logReq, 200);
      return;
    }

    if (path === '/' && method === 'GET') {
      sendHtml(res, 200, calculatorDocument(config));
      logger.request(logReq, 200);
      return;
    }

    if (path === '/auth/discord/login' && method === 'GET') {
      if (!config.discordOAuthConfigured) {
        sendJson(res, 503, {
          error: 'provider_unavailable',
          provider: 'discord_oauth',
          reason: 'not_configured',
        });
        logger.request(logReq, 503);
        return;
      }
      const issued = oauthStates.issue();
      const location = safeAuthorizeLocation(oauth.authorizeUrl(issued.state, issued.challenge), config);
      if (!location) {
        sendJson(res, 500, { error: 'invalid_authorize_url' });
        logger.request(logReq, 500);
        return;
      }
      sendRedirect(res, location, {
        'Set-Cookie': cookieHeader(oauthStates.cookieName, issued.nonce, cookieOpts(config, 600)),
      });
      logger.request(logReq, 302);
      return;
    }

    if (path === '/auth/discord/callback' && method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code') || '';
      const cookies = parseCookies(req.headers.cookie);
      const nonce = cookies[oauthStates.cookieName] || '';
      const pending = oauthStates.consume(state, nonce);
      const clearOauth = clearCookie(oauthStates.cookieName, cookieOpts(config, 0));
      ignoredCallerHints(url);

      if (!pending || !code) {
        sendJson(res, 400, { error: 'invalid_state' }, { 'Set-Cookie': clearOauth });
        logger.request(logReq, 400, { reason: 'oauth_state_mismatch' });
        return;
      }

      try {
        const token = await oauth.exchangeCode(code, pending.verifier);
        const user = await oauth.getCurrentUser(token.access_token);
        if (!user || !user.id) {
          sendJson(res, 502, { error: 'identity_unavailable' }, { 'Set-Cookie': clearOauth });
          logger.request(logReq, 502);
          return;
        }
        const session = sessions.create({
          discordUserId: String(user.id),
          username: user.username || '',
          globalName: user.global_name || user.globalName || '',
          discriminator: user.discriminator || '',
        });
        applyTokenToSession(session, token);
        sendRedirect(res, '/', {
          'Set-Cookie': [
            cookieHeader(sessions.cookieName, session.id, cookieOpts(config, 8 * 60 * 60)),
            clearOauth,
          ],
        });
        logger.request(logReq, 302, { user: session.discordUserId });
        return;
      } catch {
        sendJson(res, 502, { error: 'oauth_exchange_failed' }, { 'Set-Cookie': clearOauth });
        logger.request(logReq, 502, { reason: 'oauth_exchange_failed' });
        return;
      }
    }

    if (path === '/auth/logout' && (method === 'POST' || method === 'GET')) {
      const cookies = parseCookies(req.headers.cookie);
      sessions.destroy(cookies[sessions.cookieName]);
      const headers = {
        'Set-Cookie': clearCookie(sessions.cookieName, cookieOpts(config, 0)),
      };
      if (method === 'GET') {
        sendRedirect(res, '/', headers);
      } else {
        sendJson(res, 200, { ok: true }, headers);
      }
      logger.request(logReq, method === 'GET' ? 302 : 200);
      return;
    }

    if (path === '/api/me' && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(logReq, 401);
        return;
      }
      ignoredCallerHints(url);
      const membership = await liveMembership(session);
      const balance = await killfeed.getBalance(session.discordUserId);
      const body = selfPayload(session, membership, config, {
        balance: sanitizeBalance(balance),
        customer_lookup: {
          configured: botLookup.isConfigured(),
          available: botLookup.isConfigured(),
        },
      });
      sendJson(res, 200, body);
      logger.request(logReq, 200, { user: session.discordUserId });
      return;
    }

    if (path === '/api/me/balance' && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(logReq, 401);
        return;
      }
      ignoredCallerHints(url);
      const balance = await killfeed.getBalance(session.discordUserId);
      sendJson(res, 200, sanitizeBalance(balance));
      logger.request(logReq, 200, { user: session.discordUserId });
      return;
    }

    if (path === '/api/me/roles' && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(logReq, 401);
        return;
      }
      ignoredCallerHints(url);
      const membership = await liveMembership(session);
      sendJson(res, 200, {
        in_guild: membership.inGuild,
        roles: membership.roles,
        trader_role_configured: Boolean(config.traderRoleConfigured),
        server_owner_role_configured: Boolean(config.serverOwnerRoleConfigured),
        high_level_staff_role_configured: Boolean(config.highLevelStaffRoleConfigured),
        is_trader: Boolean(accessPayload(config, membership).grants.trader),
        access: accessPayload(config, membership),
      });
      logger.request(logReq, 200, { user: session.discordUserId });
      return;
    }

    const traderPlayer = path.match(/^\/api\/trader\/players\/([^/]+)$/);
    if (traderPlayer && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(logReq, 401);
        return;
      }
      ignoredCallerHints(url);
      const gate = await openTraderGate(session);
      if (!gate.allowed) {
        sendTraderGate(res, gate, logReq, session);
        return;
      }
      if (!botLookup.isConfigured()) {
        sendJson(res, 503, botLookup.unavailable());
        logger.request(logReq, 503, { provider: 'discord_member_lookup', user: session.discordUserId });
        return;
      }
      const targetId = decodeURIComponent(traderPlayer[1]);
      if (!/^\d{17,20}$/.test(targetId)) {
        sendJson(res, 400, { error: 'invalid_user_id' });
        logger.request(logReq, 400);
        return;
      }
      const member = await botLookup.getMember(targetId);
      const balance = await killfeed.getBalance(targetId);
      const status = member.ok ? 200 : member.status || 503;
      sendJson(res, status, {
        lookup: member.ok
          ? { id: targetId, member: publicMember(member.data) }
          : { error: member.error || 'lookup_failed', reason: member.reason, provider: member.provider },
        balance: sanitizeBalance(balance),
        pricing_roles: member.ok ? pricingRoleNames((member.data && member.data.roles) || [], config.discordDiscountRoleMap) : [],
        live_customer_functionality: false,
      });
      logger.request(logReq, status, { user: session.discordUserId });
      return;
    }

    if (path === '/api/trader/search' && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(logReq, 401);
        return;
      }
      ignoredCallerHints(url);
      const gate = await openTraderGate(session);
      if (!gate.allowed) {
        sendTraderGate(res, gate, logReq, session);
        return;
      }
      if (!botLookup.isConfigured()) {
        sendJson(res, 503, botLookup.unavailable());
        logger.request(logReq, 503, { provider: 'discord_member_lookup', user: session.discordUserId });
        return;
      }
      const query = (url.searchParams.get('q') || '').trim();
      if (query.length < 2 || query.length > 32) {
        sendJson(res, 400, {
          error: 'invalid_query',
          provider: 'discord_member_lookup',
          reason: query.length < 2 ? 'query_too_short' : 'query_too_long',
        });
        logger.request(logReq, 400, { reason: 'invalid_query', user: session.discordUserId });
        return;
      }
      let result;
      try {
        result = await botLookup.searchMembers(query);
      } catch {
        result = { ok: false, status: 502, reason: 'provider_error', provider: 'discord_member_lookup' };
      }
      if (!result.ok) {
        const status = result.status === 400 ? 400 : 503;
        sendJson(res, status, {
          error: result.status === 400 ? 'invalid_query' : 'provider_unavailable',
          provider: 'discord_member_lookup',
          reason: result.reason === 'not_configured' ? 'not_configured' : (result.status === 400 ? result.reason : 'member_search_unavailable'),
          lookup_by_id: true,
          note: 'Discord name search is not available. A member can still be opened by user id.',
          live_customer_functionality: false,
          killfeed_search: killfeed.search(),
        });
        logger.request(logReq, status, { reason: result.reason, user: session.discordUserId });
        return;
      }
      const results = publicSearchResults(result.data).filter(Boolean);
      sendJson(res, 200, {
        results,
        live_customer_functionality: false,
        killfeed_search: killfeed.search(),
      });
      logger.request(logReq, 200, { user: session.discordUserId });
      return;
    }

    if (await handleCatalogRoutes({
      req,
      res,
      path,
      method,
      sendJson,
      logReq,
      logger,
      config,
      oauth,
      catalogStore,
      baseCatalog,
      sessionFromRequest,
    })) return;

    sendJson(res, 404, { error: 'not_found' });
    logger.request(logReq, 404);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const reqPath = typeof req.url === 'string' ? req.url.split('?')[0] : '';
      logger.error('unhandled', {
        message: err && err.message,
        status: err && err.status,
        code: err && err.discordCode,
        discordMessage: err && err.discordMessage,
        path: err && err.discordPath,
      });
      logger.request({ method: req.method || '', url: reqPath }, 500, { reason: err && err.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });

  function listen(port, host) {
    const bindPort = port == null ? config.port : port;
    const bindHost = host || '127.0.0.1';
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(bindPort, bindHost, () => {
        server.removeListener('error', reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    server,
    config,
    sessions,
    oauthStates,
    oauth,
    botLookup,
    killfeed,
    listen,
    close,
    assertHostReady,
  };
}

function sanitizeBalance(result) {
  if (!result) {
    return {
      available: false,
      mapped: false,
      provider: 'killfeed',
      reason: 'not_configured',
      write_access: false,
    };
  }
  const body = {
    ok: Boolean(result.ok),
    available: Boolean(result.available),
    mapped: Boolean(result.mapped),
    provider: result.provider || 'killfeed',
    reason: result.reason || 'not_configured',
    write_access: false,
    docs: result.docs,
    route: result.route,
    note: result.note,
    http_status: result.http_status,
  };
  if (result.mapped && result.available) {
    body.cash = result.cash;
    body.cash_str = result.cash_str;
    body.bank = result.bank;
    body.bank_str = result.bank_str;
  }
  return body;
}

function publicMember(data) {
  if (!data || typeof data !== 'object') return null;
  const user = data.user || {};
  return {
    id: user.id || data.id || null,
    username: user.username || null,
    global_name: user.global_name || null,
    nick: data.nick || null,
    roles: Array.isArray(data.roles) ? data.roles.map(String) : [],
  };
}

function publicSearchResults(data) {
  const list = Array.isArray(data) ? data : [];
  return list.map((row) => {
    if (!row || typeof row !== 'object') return null;
    const user = row.user || {};
    const id = String(user.id || row.id || '');
    if (!/^\d{17,20}$/.test(id)) return null;
    const username = typeof user.username === 'string' ? user.username.slice(0, 32) : null;
    const display = String(row.nick || user.global_name || user.username || '').replace(/[<>]/g, '').slice(0, 32);
    const avatarHash = typeof user.avatar === 'string' && /^[A-Za-z0-9_]+$/.test(user.avatar) ? user.avatar : '';
    return {
      id,
      username,
      display_name: display || null,
      avatar: avatarHash ? `https://cdn.discordapp.com/avatars/${id}/${avatarHash}.png` : null,
    };
  });
}

if (require.main === module) {
  const app = createApp();
  const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  try {
    assertHostReady(app.config, host);
  } catch (err) {
    console.error(err && err.message ? err.message : 'Host configuration refused.');
    process.exit(1);
  }
  app.listen(app.config.port, host).then((addr) => {
    const port = addr && addr.port ? addr.port : app.config.port;
    console.log(`Group 935 Calculator listening on http://${host}:${port}`);
  }).catch((err) => {
    console.error('Failed to start:', err && err.message);
    process.exit(1);
  });
}

module.exports = { createApp, sanitizeBalance, assertHostReady, calculatorDocument };
