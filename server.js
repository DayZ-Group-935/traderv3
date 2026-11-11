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

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Hosted HTTPS (Render) must not boot with an ephemeral session secret or an
// insecure cookie. Loopback without COOKIE_SECURE keeps the local POC path.
function assertHostReady(config, host) {
  if (isLoopbackHost(host) && !config.cookieSecure) return;
  if (!config.cookieSecure) {
    throw new Error('COOKIE_SECURE=true is required when the process is not bound to loopback.');
  }
  if (config.sessionSecretGenerated || !config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error('A durable SESSION_SECRET of at least 32 characters is required when COOKIE_SECURE is true.');
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
  const oauth = options.oauth || createDiscordOAuth(config, { fetch: options.fetch });
  const botLookup = options.botLookup || createDiscordBotLookup(config, { fetch: options.fetch });
  const killfeed = options.killfeed || createKillfeedAdapter(config, { fetch: options.fetch });

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
    const url = readUrl(req, 'localhost:8787');
    const path = url.pathname;
    const method = req.method || 'GET';

    if (path === '/health' || path === '/status') {
      sendJson(res, 200, publicStatus(config));
      logger.request(req, 200);
      return;
    }

    if (path === '/' && method === 'GET') {
      sendHtml(res, 200, calculatorDocument(config));
      logger.request(req, 200);
      return;
    }

    if (path === '/auth/discord/login' && method === 'GET') {
      if (!config.discordOAuthConfigured) {
        sendJson(res, 503, {
          error: 'provider_unavailable',
          provider: 'discord_oauth',
          reason: 'not_configured',
        });
        logger.request(req, 503);
        return;
      }
      const issued = oauthStates.issue();
      const location = oauth.authorizeUrl(issued.state, issued.challenge);
      sendRedirect(res, location, {
        'Set-Cookie': cookieHeader(oauthStates.cookieName, issued.nonce, cookieOpts(config, 600)),
      });
      logger.request(req, 302);
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
        logger.request(req, 400, { reason: 'oauth_state_mismatch' });
        return;
      }

      try {
        const token = await oauth.exchangeCode(code, pending.verifier);
        const user = await oauth.getCurrentUser(token.access_token);
        if (!user || !user.id) {
          sendJson(res, 502, { error: 'identity_unavailable' }, { 'Set-Cookie': clearOauth });
          logger.request(req, 502);
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
        logger.request(req, 302, { user: session.discordUserId });
        return;
      } catch {
        sendJson(res, 502, { error: 'oauth_exchange_failed' }, { 'Set-Cookie': clearOauth });
        logger.request(req, 502, { reason: 'oauth_exchange_failed' });
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
      logger.request(req, method === 'GET' ? 302 : 200);
      return;
    }

    if (path === '/api/me' && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(req, 401);
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
      logger.request(req, 200, { user: session.discordUserId });
      return;
    }

    if (path === '/api/me/balance' && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(req, 401);
        return;
      }
      ignoredCallerHints(url);
      const balance = await killfeed.getBalance(session.discordUserId);
      sendJson(res, 200, sanitizeBalance(balance));
      logger.request(req, 200, { user: session.discordUserId });
      return;
    }

    if (path === '/api/me/roles' && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(req, 401);
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
      logger.request(req, 200, { user: session.discordUserId });
      return;
    }

    const traderPlayer = path.match(/^\/api\/trader\/players\/([^/]+)$/);
    if (traderPlayer && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(req, 401);
        return;
      }
      ignoredCallerHints(url);
      const gate = await evaluateTraderAccess(session, oauth, config);
      if (!gate.allowed) {
        sendJson(res, 403, { error: gate.error, reason: gate.reason });
        logger.request(req, 403, { reason: gate.reason, user: session.discordUserId });
        return;
      }
      if (!botLookup.isConfigured()) {
        sendJson(res, 503, botLookup.unavailable());
        logger.request(req, 503, { provider: 'discord_member_lookup', user: session.discordUserId });
        return;
      }
      const targetId = decodeURIComponent(traderPlayer[1]);
      const member = await botLookup.getMember(targetId);
      const balance = await killfeed.getBalance(targetId);
      const status = member.ok ? 200 : member.status || 503;
      sendJson(res, status, {
        lookup: member.ok
          ? { id: targetId, member: publicMember(member.data) }
          : { error: member.error || 'lookup_failed', reason: member.reason, provider: member.provider },
        balance: sanitizeBalance(balance),
        live_customer_functionality: false,
      });
      logger.request(req, status, { user: session.discordUserId });
      return;
    }

    if (path === '/api/trader/search' && method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) {
        logger.request(req, 401);
        return;
      }
      ignoredCallerHints(url);
      const gate = await evaluateTraderAccess(session, oauth, config);
      if (!gate.allowed) {
        sendJson(res, 403, { error: gate.error, reason: gate.reason });
        logger.request(req, 403, { reason: gate.reason, user: session.discordUserId });
        return;
      }
      if (!botLookup.isConfigured()) {
        sendJson(res, 503, botLookup.unavailable());
        logger.request(req, 503, { provider: 'discord_member_lookup', user: session.discordUserId });
        return;
      }
      const query = url.searchParams.get('q') || '';
      const result = await botLookup.searchMembers(query);
      const status = result.ok ? 200 : result.status || 503;
      sendJson(res, status, {
        ...(result.ok ? { results: publicSearchResults(result.data) } : { error: result.error || 'lookup_failed', reason: result.reason, provider: result.provider }),
        live_customer_functionality: false,
        killfeed_search: killfeed.search(),
      });
      logger.request(req, status, { user: session.discordUserId });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
    logger.request(req, 404);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error('unhandled', { message: err && err.message });
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
  return list.map(publicMember);
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
