'use strict';

/**
 * MOCK TESTS — not live.
 * These tests inject mocked Discord and Killfeed adapters. They do not
 * contact Discord, Killfeed, or any production system, and they do not
 * prove live trader customer functionality or a live balance integration.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { buildConfig, publicStatus, loadRuntimeIds } = require('../lib/config');
const { redact } = require('../lib/redact');
const { createKillfeedAdapter } = require('../lib/killfeed');
const { mapEconomyBody } = require('../lib/killfeed-map');
const { createRateLimiter } = require('../lib/http-util');
const os = require('node:os');
const { mapDiscounts, parseVerifiedMap } = require('../lib/discounts');
const { createDiscordBotLookup, isAllowlistedBotPath } = require('../lib/discord-bot-lookup');
const { createApp, assertHostReady } = require('../server');
const { canonicalFromRedirect } = require('../lib/request-guard');
const fs = require('node:fs');
const path = require('node:path');

const PLAYER_ID = '111111111111111111';
const OTHER_ID = '222222222222222222';
const TRADER_ID = '333333333333333333';
const OWNER_ID = '444444444444444444';
const STAFF_ID = '555555555555555555';
const TRADER_ROLE = '1440000000000000001';
const OWNER_ROLE = '1440000000000000002';
const STAFF_ROLE = '1440000000000000003';
const NEARBY_STAFF_ROLE = '1440000000000000004';
const PLAYER_AT = 'mock_player_access_token';
const TRADER_AT = 'mock_trader_access_token';
const OWNER_AT = 'mock_owner_access_token';
const STAFF_AT = 'mock_staff_access_token';
const SECRET = 'super-secret-test-value-do-not-leak';

let passed = 0;
let failed = 0;
const results = [];

function label(name) {
  return `[MOCK] ${name}`;
}

async function test(name, fn) {
  const titled = label(name);
  try {
    await fn();
    passed += 1;
    results.push({ name: titled, ok: true });
    console.log(`PASS  ${titled}`);
  } catch (err) {
    failed += 1;
    results.push({ name: titled, ok: false, error: err && err.stack ? err.stack : String(err) });
    console.error(`FAIL  ${titled}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

function baseConfig(extra) {
  return buildConfig({
    PORT: '0',
    SESSION_SECRET: 'test-session-secret-not-used-as-token',
    DISCORD_CLIENT_ID: 'mock-client-id',
    DISCORD_CLIENT_SECRET: SECRET,
    DISCORD_REDIRECT_URI: 'http://localhost:8787/auth/discord/callback',
    DISCORD_GUILD_ID: '1213578527522431046',
    DISCORD_TRADER_ROLE_ID: TRADER_ROLE,
    ...extra,
  });
}

function mockOAuth(options = {}) {
  const memberByToken = options.memberByToken || {};
  return {
    authorizeUrl(state, challenge) {
      return `https://discord.com/oauth2/authorize?client_id=mock-client-id&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`;
    },
    async exchangeCode(code, verifier) {
      if (code !== 'mock-code' || !verifier) {
        const err = new Error('bad_code');
        err.status = 400;
        throw err;
      }
      return {
        access_token: PLAYER_AT,
        refresh_token: 'mock_refresh_token',
        expires_in: 3600,
        scope: 'identify guilds.members.read',
      };
    },
    async refreshAccessToken() {
      return {
        access_token: PLAYER_AT,
        refresh_token: 'mock_refresh_token',
        expires_in: 3600,
        scope: 'identify guilds.members.read',
      };
    },
    async getCurrentUser(accessToken) {
      if (accessToken === TRADER_AT) {
        return { id: TRADER_ID, username: 'trader', global_name: 'Trader' };
      }
      if (accessToken === OWNER_AT) {
        return { id: OWNER_ID, username: 'owner', global_name: 'Owner' };
      }
      if (accessToken === STAFF_AT) {
        return { id: STAFF_ID, username: 'staff', global_name: 'Staff' };
      }
      return { id: PLAYER_ID, username: 'player', global_name: 'Player' };
    },
    async getCurrentMember(accessToken) {
      if (typeof memberByToken[accessToken] === 'function') {
        return memberByToken[accessToken]();
      }
      if (memberByToken[accessToken] === undefined) {
        if (accessToken === TRADER_AT) return { roles: [TRADER_ROLE] };
        if (accessToken === OWNER_AT) return { roles: [OWNER_ROLE] };
        if (accessToken === STAFF_AT) return { roles: [STAFF_ROLE] };
        return { roles: [] };
      }
      return memberByToken[accessToken];
    },
  };
}

async function withApp(opts, fn) {
  const config = opts.config || baseConfig(opts.env);
  const app = createApp({
    config,
    oauth: opts.oauth || mockOAuth(opts),
    botLookup: opts.botLookup,
    killfeed: opts.killfeed,
    logger: opts.logger || { info() {}, error() {}, request() {} },
  });
  const addr = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(app, origin);
  } finally {
    await app.close();
  }
}

async function request(origin, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  const res = await fetch(`${origin}${path}`, {
    method: options.method || 'GET',
    headers,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: res.status,
    headers: res.headers,
    text,
    json,
    setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
  };
}

function sessionCookie(app, data) {
  const rec = app.sessions.create({
    discordUserId: data.discordUserId,
    username: data.username || 'user',
    globalName: data.globalName || '',
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || 'mock_refresh_token',
    tokenExpiresAt: Date.now() + 60 * 60 * 1000,
  });
  return `${app.sessions.cookieName}=${encodeURIComponent(rec.id)}`;
}

function containsSensitive(haystack, secrets) {
  const raw = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  return secrets.some((secret) => secret && raw.includes(secret));
}

async function run() {
  console.log('===== MOCK TESTS (not live) =====');
  console.log('These results used mocked Discord/Killfeed adapters.');
  console.log('They do not prove live API access or live trader customer functionality.');
  console.log('');

  await test('no auth -> 401', async () => {
    await withApp({}, async (_app, origin) => {
      for (const path of ['/api/me', '/api/me/balance', '/api/me/roles', `/api/trader/players/${OTHER_ID}`, '/api/trader/search?q=x']) {
        const res = await request(origin, path);
        assert.equal(res.status, 401, `${path} should be 401`);
        assert.equal(res.json.error, 'unauthorized');
      }
    });
  });

  await test('player self allowed', async () => {
    await withApp({}, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: PLAYER_ID,
        username: 'player',
        globalName: 'Player',
        accessToken: PLAYER_AT,
      });
      const me = await request(origin, '/api/me', { cookie });
      assert.equal(me.status, 200);
      assert.equal(me.json.identity.id, PLAYER_ID);
      assert.equal(me.json.identity.username, 'player');
      assert.equal(me.json.roles.is_trader, false);
      assert.equal(me.json.access.trader_mode_allowed, false);
      assert.equal(me.json.access.writes, false);
      assert.equal(me.json.roles.discounts.configured, false);
      assert.deepEqual(me.json.roles.discounts.applied, []);
      assert.equal(me.json.roles.discounts.reason, 'discount_role_ids_unverified');
      assert.equal(me.json.roles.discounts.amounts_mapped, false);
      assert.equal(me.json.balance.available, false);
      assert.equal(me.json.balance.write_access, false);
      assert.equal(me.json.balance.reason, 'not_configured');
      assert.ok(!containsSensitive(me.json, [PLAYER_AT, SECRET, 'mock_refresh_token']));

      const balance = await request(origin, '/api/me/balance', { cookie });
      assert.equal(balance.status, 200);
      assert.equal(balance.json.available, false);
      assert.equal(balance.json.reason, 'not_configured');

      const roles = await request(origin, '/api/me/roles', { cookie });
      assert.equal(roles.status, 200);
      assert.equal(roles.json.is_trader, false);
      assert.deepEqual(roles.json.roles, []);
    });
  });

  await test('player other denied', async () => {
    await withApp({}, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: PLAYER_ID,
        username: 'player',
        accessToken: PLAYER_AT,
      });
      const other = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
      assert.equal(other.status, 403);
      assert.equal(other.json.reason, 'elevated_role_required');
      assert.ok(!other.json.balance);
      assert.ok(!other.json.lookup);

      const search = await request(origin, `/api/trader/search?q=other`, { cookie });
      assert.equal(search.status, 403);

      const spoof = await request(origin, `/api/me?user_id=${OTHER_ID}`, { cookie });
      assert.equal(spoof.status, 200);
      assert.equal(spoof.json.identity.id, PLAYER_ID);
      assert.notEqual(spoof.json.identity.id, OTHER_ID);
    });
  });

  await test('trader access role gate', async () => {
    await withApp({ env: { DISCORD_TRADER_ROLE_ID: '' } }, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: TRADER_ID,
        username: 'trader',
        accessToken: TRADER_AT,
      });
      const res = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
      assert.equal(res.status, 403);
      assert.equal(res.json.reason, 'elevated_role_not_configured');
    });

    await withApp({}, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: TRADER_ID,
        username: 'trader',
        accessToken: TRADER_AT,
      });
      const res = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
      assert.equal(res.status, 503, 'trader with role still cannot look up customers without the bot adapter');
      assert.equal(res.json.error, 'provider_unavailable');
      assert.equal(res.json.provider, 'discord_member_lookup');
      assert.equal(res.json.reason, 'not_configured');
      assert.ok(!res.json.lookup);

      const search = await request(origin, '/api/trader/search?q=name', { cookie });
      assert.equal(search.status, 503);
      assert.equal(search.json.reason, 'not_configured');
    });
  });

  await test('member search is role-gated, limited, and returns only public fields', async () => {
    let called = '';
    const botLookup = {
      isConfigured() { return true; },
      unavailable() { return { ok: false, status: 503, error: 'provider_unavailable', reason: 'not_configured' }; },
      async searchMembers(query) {
        called = query;
        return {
          ok: true,
          status: 200,
          data: [{
            nick: 'Ada',
            roles: ['1215060053191819324'],
            user: { id: OTHER_ID, username: 'ada', global_name: 'Ada Lovelace', avatar: 'abc123' },
          }],
        };
      },
      async getMember() { return { ok: false, status: 404, reason: 'not_found' }; },
    };
    const anon = await (async () => {
      let status = 0;
      await withApp({ botLookup }, async (_app, origin) => {
        const res = await request(origin, '/api/trader/search?q=ad');
        status = res.status;
      });
      return status;
    })();
    assert.equal(anon, 401);

    await withApp({ botLookup }, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: TRADER_ID,
        username: 'trader',
        accessToken: TRADER_AT,
      });
      const short = await request(origin, '/api/trader/search?q=a', { cookie });
      assert.equal(short.status, 400);
      assert.equal(short.json.reason, 'query_too_short');
      const found = await request(origin, '/api/trader/search?q=ad', { cookie });
      assert.equal(found.status, 200);
      assert.equal(called, 'ad');
      assert.equal(found.json.results.length, 1);
      assert.deepEqual(Object.keys(found.json.results[0]).sort(), ['avatar', 'display_name', 'id', 'username']);
      assert.equal(found.json.results[0].id, OTHER_ID);
      assert.equal(found.json.results[0].display_name, 'Ada');
      assert.equal(found.json.results[0].avatar, `https://cdn.discordapp.com/avatars/${OTHER_ID}/abc123.png`);
      assert.equal(JSON.stringify(found.json).includes('1215060053191819324'), false);
      const none = await request(origin, '/api/trader/search?q=zz', { cookie });
      assert.equal(none.status, 200);
    });

    const lookup = createDiscordBotLookup({
      discordBotToken: 'test-bot-token-not-real',
      discordGuildId: '1213578527522431046',
      discordApiBase: 'https://discord.test',
    }, {
      limiter: { async waitForSlot() {}, noteHeaders() {} },
      fetch: async (url) => {
        called = String(url);
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          json: async () => [],
        };
      },
    });
    const empty = await lookup.searchMembers('al');
    assert.equal(empty.ok, true);
    assert.match(called, /\/guilds\/1213578527522431046\/members\/search\?query=al&limit=10$/);
    const tiny = await lookup.searchMembers('a');
    assert.equal(tiny.status, 400);
    assert.equal(tiny.reason, 'query_too_short');
  });

  await test('stale/revoked roles fail closed', async () => {
    let roles = [TRADER_ROLE];
    const oauth = mockOAuth({
      memberByToken: {
        [TRADER_AT]: () => ({ roles: [...roles] }),
      },
    });
    await withApp({ oauth }, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: TRADER_ID,
        username: 'trader',
        accessToken: TRADER_AT,
      });
      const before = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
      assert.equal(before.status, 503, 'gate should pass while the role is current, then fail closed on provider');
      roles = [];
      const after = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
      assert.equal(after.status, 403);
      assert.equal(after.json.reason, 'elevated_role_required');

      const me = await request(origin, '/api/me', { cookie });
      assert.equal(me.status, 200);
      assert.equal(me.json.roles.is_trader, false);
    });
  });

  await test('CSRF/state mismatch', async () => {
    await withApp({}, async (app, origin) => {
      const login = await request(origin, '/auth/discord/login');
      assert.equal(login.status, 302);
      const location = login.headers.get('location');
      assert.ok(location.includes('state='));
      const oauthCookie = (login.setCookie || []).find((c) => c.startsWith(`${app.oauthStates.cookieName}=`));
      assert.ok(oauthCookie, 'oauth nonce cookie should be set');

      const mismatch = await request(origin, '/auth/discord/callback?code=mock-code&state=forged-state', {
        cookie: oauthCookie.split(';')[0],
      });
      assert.equal(mismatch.status, 400);
      assert.equal(mismatch.json.error, 'invalid_state');

      const missing = await request(origin, '/auth/discord/callback?code=mock-code&state=whatever');
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error, 'invalid_state');

      const state = new URL(location).searchParams.get('state');
      const noCookie = await request(origin, `/auth/discord/callback?code=mock-code&state=${state}`);
      assert.equal(noCookie.status, 400);
    });
  });

  await test('tampered identity/role params ignored', async () => {
    await withApp({}, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: PLAYER_ID,
        username: 'player',
        accessToken: PLAYER_AT,
      });
      const path =
        `/api/me?user_id=${OTHER_ID}&discord_id=${OTHER_ID}&is_trader=true&roles=${TRADER_ROLE}&role=${TRADER_ROLE}`;
      const me = await request(origin, path, { cookie });
      assert.equal(me.status, 200);
      assert.equal(me.json.identity.id, PLAYER_ID);
      assert.equal(me.json.roles.is_trader, false);
      assert.ok(!me.json.roles.current.includes(TRADER_ROLE));

      const traderPath =
        `/api/trader/players/${OTHER_ID}?is_trader=true&roles=${TRADER_ROLE}&user_id=${TRADER_ID}`;
      const denied = await request(origin, traderPath, { cookie });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.reason, 'elevated_role_required');
    });
  });

  await test('elevated access each verified role allowed; normal and nearby staff denied', async () => {
    const elevatedEnv = {
      DISCORD_TRADER_ROLE_ID: TRADER_ROLE,
      DISCORD_SERVER_OWNER_ROLE_ID: OWNER_ROLE,
      DISCORD_HIGH_LEVEL_STAFF_ROLE_ID: STAFF_ROLE,
    };

    async function assertGatePasses(env, session) {
      await withApp({ env }, async (app, origin) => {
        const cookie = sessionCookie(app, session);
        const res = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
        assert.equal(res.status, 503, 'gate should pass, then fail closed on the unconfigured bot adapter');
        assert.equal(res.json.reason, 'not_configured');
        const me = await request(origin, '/api/me', { cookie });
        assert.equal(me.status, 200);
        assert.equal(me.json.access.trader_mode_allowed, true);
        assert.equal(me.json.access.writes, false);
        assert.equal(me.json.identity.id, session.discordUserId);
      });
    }

    await assertGatePasses(elevatedEnv, {
      discordUserId: TRADER_ID,
      username: 'trader',
      accessToken: TRADER_AT,
    });
    await assertGatePasses(elevatedEnv, {
      discordUserId: OWNER_ID,
      username: 'owner',
      accessToken: OWNER_AT,
    });
    await assertGatePasses(elevatedEnv, {
      discordUserId: STAFF_ID,
      username: 'staff',
      accessToken: STAFF_AT,
    });

    await withApp({ env: elevatedEnv }, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: PLAYER_ID,
        username: 'player',
        accessToken: PLAYER_AT,
      });
      const denied = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.reason, 'elevated_role_required');
      const me = await request(origin, '/api/me', { cookie });
      assert.equal(me.json.access.trader_mode_allowed, false);
    });

    // Fail closed when High Level Staff is unverified, even if the member
    // holds a nearby staff-like role ID.
    await withApp(
      {
        env: {
          DISCORD_TRADER_ROLE_ID: TRADER_ROLE,
          DISCORD_SERVER_OWNER_ROLE_ID: OWNER_ROLE,
          DISCORD_HIGH_LEVEL_STAFF_ROLE_ID: '',
        },
        oauth: mockOAuth({
          memberByToken: {
            [STAFF_AT]: { roles: [STAFF_ROLE, NEARBY_STAFF_ROLE] },
          },
        }),
      },
      async (app, origin) => {
        const cookie = sessionCookie(app, {
          discordUserId: STAFF_ID,
          username: 'staff',
          accessToken: STAFF_AT,
        });
        const denied = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
        assert.equal(denied.status, 403);
        assert.equal(denied.json.reason, 'elevated_role_required');
        const me = await request(origin, '/api/me', { cookie });
        assert.equal(me.json.access.trader_mode_allowed, false);
        assert.equal(me.json.access.high_level_staff_role_configured, false);
        assert.equal(me.json.access.grants.high_level_staff, false);
      }
    );

    // Neighboring admin/staff-like IDs are not aliases of the configured
    // High Lvl Staff grant. Only the exact configured staff role ID is allowed.
    await withApp(
      {
        env: {
          DISCORD_TRADER_ROLE_ID: TRADER_ROLE,
          DISCORD_SERVER_OWNER_ROLE_ID: OWNER_ROLE,
          DISCORD_HIGH_LEVEL_STAFF_ROLE_ID: STAFF_ROLE,
        },
        oauth: mockOAuth({
          memberByToken: {
            [STAFF_AT]: { roles: [NEARBY_STAFF_ROLE] },
          },
        }),
      },
      async (app, origin) => {
        const cookie = sessionCookie(app, {
          discordUserId: STAFF_ID,
          username: 'staff',
          accessToken: STAFF_AT,
        });
        const denied = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
        assert.equal(denied.status, 403);
        assert.equal(denied.json.reason, 'elevated_role_required');
        const me = await request(origin, '/api/me', { cookie });
        assert.equal(me.json.access.trader_mode_allowed, false);
        assert.equal(me.json.access.high_level_staff_role_configured, true);
        assert.equal(me.json.access.grants.high_level_staff, false);
      }
    );
  });

  await test('revoked elevated roles fail closed for each grant', async () => {
    for (const caseRow of [
      { at: TRADER_AT, id: TRADER_ID, username: 'trader', role: TRADER_ROLE, envKey: 'DISCORD_TRADER_ROLE_ID' },
      { at: OWNER_AT, id: OWNER_ID, username: 'owner', role: OWNER_ROLE, envKey: 'DISCORD_SERVER_OWNER_ROLE_ID' },
      { at: STAFF_AT, id: STAFF_ID, username: 'staff', role: STAFF_ROLE, envKey: 'DISCORD_HIGH_LEVEL_STAFF_ROLE_ID' },
    ]) {
      let roles = [caseRow.role];
      const oauth = mockOAuth({
        memberByToken: {
          [caseRow.at]: () => ({ roles: [...roles] }),
        },
      });
      await withApp(
        {
          oauth,
          env: {
            DISCORD_TRADER_ROLE_ID: TRADER_ROLE,
            DISCORD_SERVER_OWNER_ROLE_ID: OWNER_ROLE,
            DISCORD_HIGH_LEVEL_STAFF_ROLE_ID: STAFF_ROLE,
          },
        },
        async (app, origin) => {
          const cookie = sessionCookie(app, {
            discordUserId: caseRow.id,
            username: caseRow.username,
            accessToken: caseRow.at,
          });
          const before = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
          assert.equal(before.status, 503, `${caseRow.username} should pass the gate while the role is current`);
          roles = [];
          const after = await request(origin, `/api/trader/players/${OTHER_ID}`, { cookie });
          assert.equal(after.status, 403);
          assert.equal(after.json.reason, 'elevated_role_required');
          const me = await request(origin, '/api/me', { cookie });
          assert.equal(me.json.access.trader_mode_allowed, false);
        }
      );
    }
  });

  await test('query and client-mode tamper cannot grant trader mode', async () => {
    await withApp(
      {
        env: {
          DISCORD_TRADER_ROLE_ID: TRADER_ROLE,
          DISCORD_SERVER_OWNER_ROLE_ID: OWNER_ROLE,
          DISCORD_HIGH_LEVEL_STAFF_ROLE_ID: STAFF_ROLE,
        },
      },
      async (app, origin) => {
        const cookie = sessionCookie(app, {
          discordUserId: PLAYER_ID,
          username: 'player',
          accessToken: PLAYER_AT,
        });
        const hints = [
          `/api/trader/players/${OTHER_ID}?mode=trader&is_trader=true&is_server_owner=true&is_high_level_staff=true&roles=${OWNER_ROLE},${STAFF_ROLE},${TRADER_ROLE}`,
          `/api/trader/search?q=other&mode=trader&roles=${OWNER_ROLE}`,
          `/api/me?mode=trader&user_id=${OWNER_ID}&roles=${OWNER_ROLE}&is_server_owner=true`,
        ];
        const playerLookup = await request(origin, hints[0], { cookie });
        assert.equal(playerLookup.status, 403);
        assert.equal(playerLookup.json.reason, 'elevated_role_required');
        const search = await request(origin, hints[1], { cookie });
        assert.equal(search.status, 403);
        const me = await request(origin, hints[2], { cookie });
        assert.equal(me.status, 200);
        assert.equal(me.json.identity.id, PLAYER_ID);
        assert.equal(me.json.access.trader_mode_allowed, false);
        assert.equal(me.json.roles.is_server_owner, false);
        assert.ok(!me.json.roles.current.includes(OWNER_ROLE));
        assert.ok(!me.json.roles.current.includes(TRADER_ROLE));
      }
    );
  });


  await test('runtime-ids configures Trader, Server Owner, and High Lvl Staff exact IDs', async () => {
    const ids = loadRuntimeIds();
    assert.equal(ids.DISCORD_TRADER_ROLE_ID, '1215060053191819324');
    assert.equal(ids.DISCORD_SERVER_OWNER_ROLE_ID, '1215040829186383912');
    assert.equal(ids.DISCORD_HIGH_LEVEL_STAFF_ROLE_ID, '1215042184764723251');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runtime-ids.json'), 'utf8'));
    assert.equal(raw.high_level_staff.configured, true);
    assert.equal(raw.high_level_staff.verified_discord_label, 'High Lvl Staff');
    assert.equal(raw.high_level_staff.user_phrase, 'High Level Staff');
    assert.equal(raw.high_level_staff.literal_exact_name_match, false);
    assert.equal(raw.high_level_staff.other_aliases, false);
    assert.equal(raw.high_level_staff.discord_role_id, '1215042184764723251');
    assert.equal(raw.discord_guild_id, '1213578527522431046');
    assert.equal(raw.discount_role_map['1217087146838458378'], 'Roadkill');
    assert.equal(raw.discount_role_discord_labels['1217087146838458378'], 'Road Kill');
    assert.equal(raw.discount_role_map['1303434093941493821'], 'Day One');
    assert.equal(raw.discount_role_discord_labels['1303434093941493821'], 'Day 1');
    assert.equal(raw.discount_role_map['1511813956749234388'], 'Build-A-Bear');
    assert.equal(raw.discount_role_map['1217083405284675684'], 'Meet Your Beat');
    assert.equal(Object.values(raw.discount_role_map).includes('Julius Caesar'), false);
    assert.equal(Object.values(raw.discount_role_map).includes('The Milkman'), false);
    assert.equal(Object.values(raw.discount_role_map).includes('Rose Reaper'), false);
    assert.equal(Object.values(raw.discount_role_map).includes('The Vaccinator'), false);
    assert.equal(Object.values(raw.discount_role_map).includes('Without A Paddle'), false);
    assert.equal(Object.values(raw.discount_role_map).includes('Mayweather'), false);
    const { pricingRoleNames } = require('../lib/role-rules');
    const { loadConfig, buildConfig, loadDiscountRoleMap } = require('../lib/config');
    const mapped = loadDiscountRoleMap();
    assert.equal(mapped['1217086557127708702'], 'Click Click Boom');
    assert.deepEqual(
      pricingRoleNames(Object.keys(mapped), mapped).sort(),
      [...new Set(Object.values(mapped))].sort()
    );
    assert.deepEqual(pricingRoleNames(['1217087146838458378'], mapped), ['Roadkill']);
    assert.equal(loadConfig().discountRolesConfigured, true);
    assert.equal(loadConfig().discordDiscountRoleMap['1217083866955649158'], 'Kamikaze');
    assert.deepEqual(buildConfig().discordDiscountRoleMap, {});
  });

  await test('secret redaction', async () => {
    const redacted = redact(
      {
        access_token: SECRET,
        refresh_token: SECRET,
        client_secret: SECRET,
        Authorization: `Bearer ${SECRET}`,
        nested: { api_key: SECRET, note: `header ${SECRET} leaked` },
      },
      [SECRET]
    );
    const dumped = JSON.stringify(redacted);
    assert.ok(!dumped.includes(SECRET), 'redacted output must not contain the secret');
    assert.equal(redacted.access_token, '[REDACTED]');
    assert.equal(redacted.client_secret, '[REDACTED]');
    assert.equal(redacted.Authorization, '[REDACTED]');
    assert.equal(redacted.nested.api_key, '[REDACTED]');
    assert.ok(redacted.nested.note.includes('[REDACTED]'));

    const config = baseConfig({
      DISCORD_CLIENT_SECRET: SECRET,
      DISCORD_BOT_TOKEN: SECRET,
      KILLFEED_API_KEY: SECRET,
      KILLFEED_GUILD_ID: 'kf-guild',
    });
    const status = publicStatus(config);
    assert.ok(!containsSensitive(status, [SECRET, 'mock-client-id' === SECRET ? 'x' : SECRET]));
    assert.equal(status.discord_oauth_configured, true);
    assert.equal(status.killfeed_credentials_configured, true);
    assert.equal(status.killfeed_balance_configured, false);
    assert.equal(status.killfeed_search_configured, false);
    assert.equal(status.killfeed_response_mapped, true);
    assert.equal(status.killfeed_user_id_semantics_confirmed, false);
    assert.equal(status.balance_writes, false);
    assert.equal(status.discord_gateway, false);
    assert.ok(!Object.values(status).includes(SECRET));
    assert.ok(!JSON.stringify(status).includes(SECRET));

    await withApp({ config }, async (_app, origin) => {
      const res = await request(origin, '/status');
      assert.equal(res.status, 200);
      assert.ok(!containsSensitive(res.text, [SECRET]));
      assert.equal(res.json.killfeed_balance_configured, false);
      const health = await request(origin, '/health');
      assert.equal(health.status, 200);
      assert.ok(!containsSensitive(health.text, [SECRET]));
    });
  });

  await test('health/status expose no sensitive data', async () => {
    const config = baseConfig({
      DISCORD_CLIENT_SECRET: SECRET,
      DISCORD_BOT_TOKEN: 'bot-' + SECRET,
      KILLFEED_API_KEY: 'kf-' + SECRET,
    });
    await withApp({ config }, async (_app, origin) => {
      const res = await request(origin, '/health');
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      for (const key of Object.keys(res.json)) {
        assert.ok(!/secret|token|key|cookie|authorization/i.test(key), `status key looks sensitive: ${key}`);
      }
      assert.equal(res.json.trader_role_configured, true);
      assert.equal(res.json.server_owner_role_configured, false);
      assert.equal(res.json.high_level_staff_role_configured, false);
      assert.equal(res.json.elevated_access_configured, true);
      assert.ok(!containsSensitive(res.text, [SECRET, 'bot-' + SECRET, 'kf-' + SECRET, TRADER_ROLE, OWNER_ROLE, STAFF_ROLE]));
    });
  });

  await test('Killfeed stays unconfigured or unconfirmed without credentials/semantics', async () => {
    const isolated = baseConfig();
    assert.equal(isolated.killfeedApiKey, '');
    assert.equal(isolated.killfeedApiKeySource, 'none');
    assert.equal(isolated.killfeedUserIdSemantics, '');
    const unconfigured = createKillfeedAdapter(isolated);
    const none = await unconfigured.getBalance(PLAYER_ID);
    assert.equal(none.reason, 'not_configured');
    assert.equal(none.available, false);
    assert.equal(none.mapped, false);
    assert.equal(unconfigured.isSearchConfigured(), false);

    let fetched = false;
    const credsOnly = createKillfeedAdapter(
      baseConfig({
        KILLFEED_API_KEY: SECRET,
        KILLFEED_GUILD_ID: '1213578527522431046',
      }),
      {
        fetch: async () => {
          fetched = true;
          return { ok: true, status: 200, headers: new Map(), json: async () => ({ cash: 999, bank: 1000 }) };
        },
      }
    );
    const pending = await credsOnly.getBalance(PLAYER_ID);
    assert.equal(fetched, false, 'must not call Killfeed until user id semantics are confirmed');
    assert.equal(pending.reason, 'user_id_semantics_unconfirmed');
    assert.equal(pending.available, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(pending, 'cash'));
    assert.ok(!Object.prototype.hasOwnProperty.call(pending, 'bank'));
    assert.equal(credsOnly.isReady(), false);
  });

  await test('Killfeed strict mapper accepts exact cash/bank schema and keeps values distinct', async () => {
    const valid = { bank: 40, bank_str: '40', cash: 15, cash_str: '15' };
    const mapped = mapEconomyBody(valid);
    assert.equal(mapped.ok, true);
    assert.equal(mapped.available, true);
    assert.equal(mapped.mapped, true);
    assert.equal(mapped.write_access, false);
    assert.equal(mapped.cash, 15);
    assert.equal(mapped.cash_str, '15');
    assert.equal(mapped.bank, 40);
    assert.equal(mapped.bank_str, '40');
    assert.ok(!Object.prototype.hasOwnProperty.call(mapped, 'unit'));
    assert.ok(!Object.prototype.hasOwnProperty.call(mapped, 'currency'));
    assert.ok(!Object.prototype.hasOwnProperty.call(mapped, 'total'));
    assert.ok(!Object.prototype.hasOwnProperty.call(mapped, 'spendable'));
    assert.notEqual(mapped.cash, mapped.bank);

    const limiter = createRateLimiter({ minIntervalMs: 0 });
    let fetchedUrl = '';
    const adapter = createKillfeedAdapter(
      baseConfig({
        KILLFEED_API_KEY: SECRET,
        KILLFEED_GUILD_ID: '1213578527522431046',
        KILLFEED_USER_ID_SEMANTICS: 'discord_user_id',
      }),
      {
        limiter,
        fetch: async (url, opts) => {
          fetchedUrl = url;
          assert.equal(opts.redirect, 'manual');
          assert.equal(opts.headers['Api-Key'], SECRET);
          return {
            ok: true,
            status: 200,
            headers: { get: (name) => (String(name).toLowerCase() === 'ratelimit-limit' ? '30' : null) },
            json: async () => valid,
          };
        },
      }
    );
    assert.equal(adapter.isReady(), true);
    const result = await adapter.getBalance(PLAYER_ID);
    assert.match(fetchedUrl, /\/guilds\/1213578527522431046\/economy\/users\/111111111111111111$/);
    assert.equal(result.available, true);
    assert.equal(result.cash, 15);
    assert.equal(result.bank, 40);
    assert.equal(result.cash_str, '15');
    assert.equal(result.bank_str, '40');
    assert.equal(result.write_access, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'unit'));
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'total'));

    await withApp(
      {
        config: baseConfig({
          KILLFEED_API_KEY: SECRET,
          KILLFEED_GUILD_ID: '1213578527522431046',
          KILLFEED_USER_ID_SEMANTICS: 'discord_user_id',
        }),
        killfeed: adapter,
      },
      async (app, origin) => {
        const cookie = sessionCookie(app, {
          discordUserId: PLAYER_ID,
          username: 'player',
          accessToken: PLAYER_AT,
        });
        const res = await request(origin, '/api/me/balance', { cookie });
        assert.equal(res.status, 200);
        assert.equal(res.json.cash, 15);
        assert.equal(res.json.bank, 40);
        assert.equal(res.json.cash_str, '15');
        assert.equal(res.json.bank_str, '40');
        assert.equal(res.json.write_access, false);
        assert.ok(!containsSensitive(res.json, [SECRET]));
        assert.ok(!Object.prototype.hasOwnProperty.call(res.json, 'unit'));
        assert.ok(!Object.prototype.hasOwnProperty.call(res.json, 'total'));
        assert.equal(res.json.roles, undefined);
      }
    );
  });

  await test('Killfeed strict mapper rejects invalid schema, mismatches, and provider errors', async () => {
    assert.equal(mapEconomyBody({ cash: 15, bank: 40, cash_str: '15', bank_str: '40', extra: 1 }).reason, 'schema_invalid');
    assert.equal(mapEconomyBody({ cash: 15, bank: 40, cash_str: '15' }).reason, 'schema_invalid');
    assert.equal(mapEconomyBody({ cash: '15', bank: 40, cash_str: '15', bank_str: '40' }).reason, 'schema_invalid');
    assert.equal(mapEconomyBody({ cash: 15.5, bank: 40, cash_str: '15.5', bank_str: '40' }).reason, 'schema_invalid');
    assert.equal(mapEconomyBody({ cash: 15, bank: 40, cash_str: '16', bank_str: '40' }).reason, 'schema_mismatch');
    const rejected = mapEconomyBody({ cash: 15, bank: 40, cash_str: '16', bank_str: '40' });
    assert.equal(rejected.available, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(rejected, 'cash'));
    assert.ok(!Object.prototype.hasOwnProperty.call(rejected, 'bank'));

    const limiter = createRateLimiter({ minIntervalMs: 0 });
    function adapterFor(status, body) {
      return createKillfeedAdapter(
        baseConfig({
          KILLFEED_API_KEY: SECRET,
          KILLFEED_GUILD_ID: '1213578527522431046',
          KILLFEED_USER_ID_SEMANTICS: 'discord_user_id',
        }),
        {
          limiter,
          fetch: async () => ({
            ok: status === 200,
            status,
            headers: { get: () => null },
            json: async () => body,
          }),
        }
      );
    }

    const notFound = await adapterFor(404, { message: 'The specified user ID does not exist.' }).getBalance(PLAYER_ID);
    assert.equal(notFound.reason, 'not_found');
    assert.equal(notFound.available, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(notFound, 'cash'));

    const limited = await adapterFor(429, {}).getBalance(PLAYER_ID);
    assert.equal(limited.reason, 'rate_limited');
    assert.equal(limited.http_status, 429);

    const unauthorized = await adapterFor(401, {}).getBalance(PLAYER_ID);
    assert.equal(unauthorized.reason, 'unauthorized');

    const extras = await adapterFor(200, { cash: 15, bank: 40, cash_str: '15', bank_str: '40', bonus: 3 }).getBalance(PLAYER_ID);
    assert.equal(extras.reason, 'schema_invalid');
    assert.equal(extras.available, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(extras, 'cash'));
    assert.ok(!Object.prototype.hasOwnProperty.call(extras, 'bonus'));
    assert.equal(adapterFor(200, { cash: 15, bank: 40, cash_str: '15', bank_str: '40' }).search().reason, 'not_configured');
  });

  await test('Killfeed secret file reference is used server-side and redacted from status', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '935-kf-'));
    const file = path.join(dir, 'killfeed-api-key');
    const fileSecret = 'mock-file-secret-not-live';
    fs.writeFileSync(file, fileSecret + '\n', { mode: 0o600 });
    const config = baseConfig({
      KILLFEED_API_KEY_FILE: file,
      KILLFEED_GUILD_ID: '1213578527522431046',
      KILLFEED_USER_ID_SEMANTICS: 'discord_user_id',
    });
    assert.equal(config.killfeedApiKeySource, 'file');
    assert.equal(config.killfeedBalanceConfigured, true);
    assert.equal(config.killfeedApiKey, fileSecret);
    const status = publicStatus(config);
    assert.equal(status.killfeed_credentials_configured, true);
    assert.equal(status.killfeed_credentials_source, 'file');
    assert.equal(status.killfeed_balance_configured, true);
    assert.ok(!containsSensitive(status, [fileSecret]));
    assert.ok(!JSON.stringify(status).includes(fileSecret));
    assert.ok(!Object.keys(status).some((key) => /secret|token|api_key|apikey/i.test(key)));

    await withApp({ config }, async (_app, origin) => {
      const res = await request(origin, '/status');
      assert.equal(res.status, 200);
      assert.ok(!containsSensitive(res.text, [fileSecret]));
      assert.equal(res.json.killfeed_credentials_source, 'file');
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });


  await test('discount role mapping fails closed without verified IDs', async () => {
    const empty = mapDiscounts(['1215060053191819324', 'Hotshot', 'Deadshot'], {});
    assert.equal(empty.configured, false);
    assert.deepEqual(empty.applied, []);
    assert.equal(empty.amounts_mapped, false);
    assert.equal(empty.reason, 'discount_role_ids_unverified');

    const namesAreNotIds = parseVerifiedMap({ Hotshot: 'Hotshot', Deadshot: 'Deadshot' });
    assert.deepEqual(namesAreNotIds, {});

    const invalidJson = parseVerifiedMap('{not json');
    assert.deepEqual(invalidJson, {});

    await withApp({}, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: PLAYER_ID,
        username: 'player',
        accessToken: PLAYER_AT,
      });
      const me = await request(
        origin,
        '/api/me?roles=Hotshot&role=Deadshot&is_trader=true',
        { cookie }
      );
      assert.equal(me.status, 200);
      assert.equal(me.json.roles.discounts.configured, false);
      assert.deepEqual(me.json.roles.discounts.applied, []);
      assert.equal(me.json.roles.discounts.reason, 'discount_role_ids_unverified');
    });
  });

  await test('discount mapper applies only injected verified snowflakes, never names or amounts', async () => {
    const verifiedId = '1999999999999999999';
    const mapped = mapDiscounts(
      [verifiedId, 'Hotshot', '1215060053191819324'],
      { [verifiedId]: 'Mock Label Only' }
    );
    assert.equal(mapped.configured, true);
    assert.deepEqual(mapped.applied, [{ role_id: verifiedId, label: 'Mock Label Only' }]);
    assert.equal(mapped.amounts_mapped, false);
    assert.ok(!mapped.applied.some((row) => Object.prototype.hasOwnProperty.call(row, 'percent')));

    const oauth = mockOAuth({
      memberByToken: {
        [PLAYER_AT]: () => ({ roles: [verifiedId, '1215060053191819324'] }),
      },
    });
    const config = baseConfig();
    config.discordDiscountRoleMap = { [verifiedId]: 'Mock Label Only' };
    config.discountRolesConfigured = true;
    await withApp({ config, oauth }, async (app, origin) => {
      const cookie = sessionCookie(app, {
        discordUserId: PLAYER_ID,
        username: 'player',
        accessToken: PLAYER_AT,
      });
      const me = await request(origin, '/api/me?roles=Hotshot', { cookie });
      assert.equal(me.status, 200);
      assert.equal(me.json.roles.is_trader, false);
      assert.equal(me.json.roles.discounts.configured, true);
      assert.deepEqual(me.json.roles.discounts.applied, [
        { role_id: verifiedId, label: 'Mock Label Only' },
      ]);
      assert.equal(me.json.roles.discounts.amounts_mapped, false);
    });
  });

  await test('bot lookup adapter never calls List Guild Members', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/discord-bot-lookup.js'), 'utf8');
    assert.match(src, /\/members\/\$\{encodeURIComponent\(userId\)\}/);
    assert.match(src, /\/members\/search\?/);
    assert.match(src, /\/roles`/);
    assert.match(src, /requires GUILD_MEMBERS even over HTTP; never call it/);
    assert.equal(isAllowlistedBotPath('/guilds/1213578527522431046/members/413495850313187350'), true);
    assert.equal(isAllowlistedBotPath('/guilds/1213578527522431046/members/search?query=ab'), true);
    assert.equal(isAllowlistedBotPath('/guilds/1213578527522431046/roles'), true);
    assert.equal(isAllowlistedBotPath('/guilds/1213578527522431046/members'), false);
    assert.equal(isAllowlistedBotPath('/guilds/1213578527522431046/members?limit=100'), false);
    assert.equal(isAllowlistedBotPath('/gateway/bot'), false);

    let fetched = false;
    const bot = createDiscordBotLookup(
      baseConfig({ DISCORD_BOT_TOKEN: 'mock-bot-token-not-live' }),
      { fetch: async () => { fetched = true; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ([]) }; } }
    );
    const denied = await bot._botGet('/guilds/1213578527522431046/members');
    assert.equal(fetched, false);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'route_not_allowlisted');
  });

    await test('valid OAuth callback stores tokens server-side only', async () => {
    await withApp({}, async (app, origin) => {
      const login = await request(origin, '/auth/discord/login');
      const location = login.headers.get('location');
      const state = new URL(location).searchParams.get('state');
      const oauthCookie = (login.setCookie || []).find((c) => c.startsWith(`${app.oauthStates.cookieName}=`));
      const callback = await request(origin, `/auth/discord/callback?code=mock-code&state=${state}&user_id=${OTHER_ID}&is_trader=true`, {
        cookie: oauthCookie.split(';')[0],
      });
      assert.equal(callback.status, 302);
      const sidCookie = (callback.setCookie || []).find((c) => c.startsWith(`${app.sessions.cookieName}=`));
      assert.ok(sidCookie);
      assert.ok(!containsSensitive(callback.text, [PLAYER_AT, SECRET, 'mock_refresh_token']));
      const cookieHeader = sidCookie.split(';')[0];
      const me = await request(origin, '/api/me', { cookie: cookieHeader });
      assert.equal(me.status, 200);
      assert.equal(me.json.identity.id, PLAYER_ID);
      assert.ok(!containsSensitive(me.json, [PLAYER_AT, SECRET, 'mock_refresh_token']));
      const rec = [...app.sessions._map.values()][0];
      assert.equal(rec.accessToken, PLAYER_AT);
    });
  });

  await test('GET / serves the calculator on the same origin only', async () => {
    const disk = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.equal(disk.includes('window.__935AccountGateway='), false);
    assert.equal(disk.includes('onrender.com'), false);
    await withApp({ config: baseConfig({ DISCORD_CLIENT_SECRET: SECRET }) }, async (_app, origin) => {
      const res = await request(origin, '/');
      assert.equal(res.status, 200);
      assert.ok(res.text.includes('window.__935AccountGateway=window.location.origin'));
      assert.ok(res.text.includes('Sign-in is not configured'));
      assert.ok(res.text.includes('My account'));
      assert.ok(!res.text.includes(SECRET));
      assert.ok(!res.text.includes('onrender.com'));
    });
  });

  await test('a public bind requires COOKIE_SECURE and a durable SESSION_SECRET', async () => {
    const open = baseConfig({});
    assert.doesNotThrow(() => assertHostReady(open, '127.0.0.1'));
    assert.throws(() => assertHostReady(open, '0.0.0.0'), /COOKIE_SECURE/);
    const secureShort = baseConfig({ COOKIE_SECURE: 'true', SESSION_SECRET: 'too-short' });
    assert.throws(() => assertHostReady(secureShort, '0.0.0.0'), /SESSION_SECRET/);
    const secureLocal = baseConfig({ COOKIE_SECURE: 'true', SESSION_SECRET: 'x'.repeat(32) });
    assert.throws(() => assertHostReady(secureLocal, '0.0.0.0'), /https callback/);
    const hosted = baseConfig({
      COOKIE_SECURE: 'true',
      SESSION_SECRET: 'x'.repeat(32),
      DISCORD_REDIRECT_URI: 'https://calc.example/auth/discord/callback',
    });
    assert.equal(hosted.sessionSecretGenerated, false);
    assert.equal(hosted.cookieSecure, true);
    assert.doesNotThrow(() => assertHostReady(hosted, '0.0.0.0'));
    assert.equal(canonicalFromRedirect('https://localhost/auth/discord/callback'), null);
    assert.equal(canonicalFromRedirect('http://calc.example/auth/discord/callback'), null);
  });

  function hostedConfig() {
    return baseConfig({
      COOKIE_SECURE: 'true',
      SESSION_SECRET: 'h'.repeat(32),
      DISCORD_REDIRECT_URI: 'https://calc.example/auth/discord/callback',
    });
  }

  function rawRequest(origin, target, options = {}) {
    const u = new URL(origin);
    return new Promise((resolve, reject) => {
      const headers = { ...(options.headers || {}) };
      if (options.cookie) headers.Cookie = options.cookie;
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: target,
        method: options.method || 'GET',
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          const setCookie = res.headers['set-cookie']
            ? (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']])
            : [];
          resolve({
            status: res.statusCode,
            location: res.headers.location || '',
            text,
            json,
            setCookie,
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  function bareRequest(origin, raw) {
    const u = new URL(origin);
    return new Promise((resolve, reject) => {
      const socket = net.connect(Number(u.port), u.hostname, () => socket.write(raw));
      const chunks = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = Number((text.match(/^HTTP\/\d(?:\.\d)? (\d+)/) || [])[1] || 0);
        const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        resolve({ status, text: body, raw: text });
      });
      socket.on('error', reject);
    });
  }

  await test('hostile Host is rejected and not reflected', async () => {
    await withApp({}, async (_app, origin) => {
      const res = await rawRequest(origin, '/health', { headers: { Host: 'evil.example' } });
      assert.equal(res.status, 421);
      assert.equal(res.json.error, 'invalid_host');
      assert.equal(res.text.includes('evil.example'), false);
      assert.equal(res.location, '');
    });
    await withApp({ config: hostedConfig() }, async (_app, origin) => {
      const res = await rawRequest(origin, '/', { headers: { Host: 'evil.example' } });
      assert.equal(res.status, 421);
      assert.equal(res.json.error, 'invalid_host');
      assert.equal(res.text.includes('evil.example'), false);
      assert.equal(res.location, '');
      const sneaky = await rawRequest(origin, 'http://evil.example/auth/logout', {
        headers: { Host: 'calc.example' },
      });
      assert.equal(sneaky.status, 302);
      assert.equal(sneaky.location, '/');
    });
  });

  await test('hostile Origin is rejected and a missing Origin still works', async () => {
    await withApp({}, async (_app, origin) => {
      const hostile = await request(origin, '/auth/logout', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      });
      assert.equal(hostile.status, 403);
      assert.equal(hostile.json.error, 'invalid_origin');
      assert.equal(hostile.text.includes('evil.example'), false);
      const plain = await request(origin, '/auth/logout', { method: 'POST' });
      assert.equal(plain.status, 200);
      assert.equal(plain.json.ok, true);
    });
    await withApp({ config: hostedConfig() }, async (_app, origin) => {
      const page = await rawRequest(origin, '/', { headers: { Host: 'calc.example' } });
      assert.equal(page.status, 200);
      const hostile = await rawRequest(origin, '/', {
        headers: { Host: 'calc.example', Origin: 'https://evil.example' },
      });
      assert.equal(hostile.status, 403);
      assert.equal(hostile.text.includes('evil.example'), false);
      const same = await rawRequest(origin, '/', {
        headers: { Host: 'calc.example', Origin: 'https://calc.example' },
      });
      assert.equal(same.status, 200);
    });
  });

  await test('forwarded proto cannot spoof scheme or redirects', async () => {
    await withApp({ config: hostedConfig() }, async (app, origin) => {
      const downgrade = await rawRequest(origin, '/auth/discord/login', {
        headers: { Host: 'calc.example', 'X-Forwarded-Proto': 'http' },
      });
      assert.equal(downgrade.status, 400);
      assert.equal(downgrade.json.error, 'invalid_forwarded_proto');
      assert.equal(downgrade.location, '');
      const chain = await rawRequest(origin, '/', {
        headers: { Host: 'calc.example', 'X-Forwarded-Proto': 'https, http' },
      });
      assert.equal(chain.status, 400);
      const login = await rawRequest(origin, '/auth/discord/login', {
        headers: { Host: 'calc.example', 'X-Forwarded-Proto': 'https' },
      });
      assert.equal(login.status, 302);
      assert.equal(new URL(login.location).origin, 'https://discord.com');
      const state = new URL(login.location).searchParams.get('state');
      const oauthCookie = login.setCookie.find((c) => c.startsWith(`${app.oauthStates.cookieName}=`));
      const callback = await rawRequest(origin, `/auth/discord/callback?code=mock-code&state=${state}`, {
        headers: { Host: 'calc.example', 'X-Forwarded-Proto': 'https' },
        cookie: oauthCookie.split(';')[0],
      });
      assert.equal(callback.status, 302);
      assert.equal(callback.location, '/');
    });
  });

  await test('hosted health and navigation tolerate Render TLS termination', async () => {
    await withApp({ config: hostedConfig() }, async (_app, origin) => {
      const health = await rawRequest(origin, '/health', { headers: { Host: 'calc.example' } });
      assert.equal(health.status, 200);
      assert.equal(health.text.includes('calc.example'), false);
      const probeProto = await rawRequest(origin, '/health', {
        headers: { Host: 'calc.example', 'X-Forwarded-Proto': 'http' },
      });
      assert.equal(probeProto.status, 200);
      const portHost = await rawRequest(origin, '/status', { headers: { Host: 'calc.example:443' } });
      assert.equal(portHost.status, 200);
      const page = await rawRequest(origin, '/', { headers: { Host: 'calc.example' } });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('window.__935AccountGateway=window.location.origin'));
      const noHost = await bareRequest(origin, 'GET /health HTTP/1.0\r\n\r\n');
      assert.equal(noHost.status, 200);
      const noHostPage = await bareRequest(origin, 'GET / HTTP/1.0\r\n\r\n');
      assert.equal(noHostPage.status, 421);
      const callback = await rawRequest(origin, '/auth/discord/callback?code=x&state=y', {
        headers: { Host: 'calc.example', Origin: 'https://discord.com' },
      });
      assert.equal(callback.status, 400);
      assert.equal(callback.json.error, 'invalid_state');
      const foreignCallback = await rawRequest(origin, '/auth/discord/callback', {
        headers: { Host: 'calc.example', Origin: 'https://evil.example' },
      });
      assert.equal(foreignCallback.status, 403);
      assert.equal(foreignCallback.text.includes('evil.example'), false);
    });
  });

  console.log('');
  console.log('-----');
  console.log(`${passed} passed, ${failed} failed`);
  console.log('MOCK only — not a live Discord or Killfeed test.');
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
