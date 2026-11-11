'use strict';

/**
 * MOCK TESTS — not live.
 * Catalog writes use a temporary file. They do not edit the published list,
 * call Discord, or create a Render disk.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildConfig } = require('../lib/config');
const { createApp } = require('../server');
const { openCatalogStore } = require('../lib/catalog-store');
const { catalogResult, payableUnit, dayOneTotal, catalogEditAllowed, OWNER_ROLE_ID, STAFF_ROLE_ID, TRADER_ROLE_ID, GUILD_ID } = require('../lib/catalog-rules');

const SECRET = 'super-secret-test-value-do-not-leak';
let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('PASS  [MOCK] ' + name);
    })
    .catch((err) => {
      failed += 1;
      console.error('FAIL  [MOCK] ' + name);
      console.error(err && err.stack ? err.stack : err);
    });
}

function staffConfig() {
  return buildConfig({
    PORT: '0',
    SESSION_SECRET: 'test-session-secret-not-used-as-token',
    DISCORD_CLIENT_ID: 'mock-client-id',
    DISCORD_CLIENT_SECRET: SECRET,
    DISCORD_REDIRECT_URI: 'http://localhost:8787/auth/discord/callback',
    DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_TRADER_ROLE_ID: TRADER_ROLE_ID,
    DISCORD_SERVER_OWNER_ROLE_ID: OWNER_ROLE_ID,
    DISCORD_HIGH_LEVEL_STAFF_ROLE_ID: STAFF_ROLE_ID,
  });
}

function oauthFor(roles) {
  return {
    authorizeUrl() { return 'https://discord.com/oauth2/authorize?state=x'; },
    async exchangeCode() { throw new Error('not used'); },
    async refreshAccessToken() { throw new Error('not used'); },
    async getCurrentUser() { return { id: '1', username: 'mock' }; },
    async getCurrentMember() { return { roles: roles.slice() }; },
  };
}

async function withApp(opts, fn) {
  const app = createApp({
    config: opts.config || staffConfig(),
    oauth: oauthFor(opts.roles || []),
    botLookup: opts.botLookup,
    logger: { info() {}, error() {}, request() {} },
    catalogStore: opts.catalogStore,
  });
  const addr = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(app, origin);
  } finally {
    await app.close();
  }
}

function cookie(app, id) {
  const rec = app.sessions.create({
    discordUserId: id,
    username: 'mock-user',
    globalName: '',
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    tokenExpiresAt: Date.now() + 3600000,
  });
  return `${app.sessions.cookieName}=${encodeURIComponent(rec.id)}`;
}

async function request(origin, target, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin) headers.Origin = options.origin;
  const res = await fetch(origin + target, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

async function run() {
  console.log('===== CATALOG MOCK TESTS (not live) =====');

  await test('catalog discount does not stack with a role percent', async () => {
    assert.equal(catalogResult(3500, null), 3500);
    assert.equal(catalogResult(3500, { type: 'percent', value: 0 }), 3500);
    assert.equal(catalogResult(3500, { type: 'percent', value: 10 }), 3150);
    assert.equal(catalogResult(3200, { type: 'fixed', value: 200 }), 3000);
    const both = payableUnit({ price: 2500, discount: { type: 'percent', value: 20 }, rolePercent: 50 });
    assert.equal(both, 1250);
    assert.notEqual(both, Math.round(2500 * 0.8 * 0.5));
    assert.equal(payableUnit({ price: 2500, discount: { type: 'percent', value: 20 }, bonus: 900 }), 900);
    const day = dayOneTotal([
      { total: 1000, catalogDiscount: false },
      { total: 500, catalogDiscount: true },
    ], true);
    assert.equal(day, 1400);
  });

  await test('production path stays closed unless it is under /var/data and present', async () => {
    const closed = openCatalogStore({ enabled: false, path: '/var/data/catalog.json' });
    assert.equal(closed.ready(), false);
    assert.equal(closed.reason(), 'catalog_store_unconfigured');
    const outside = openCatalogStore({ enabled: true, path: '/tmp/catalog.json' });
    assert.equal(outside.ready(), false);
    const missing = openCatalogStore({ enabled: true, path: '/var/data/catalog.json' });
    assert.equal(missing.ready(), false);
    assert.equal(missing.reason(), 'catalog_store_unavailable');
    assert.equal(catalogEditAllowed(staffConfig(), { inGuild: true, roles: [TRADER_ROLE_ID] }), false);
    assert.equal(catalogEditAllowed(staffConfig(), { inGuild: true, roles: [OWNER_ROLE_ID] }), true);
    assert.equal(catalogEditAllowed(staffConfig(), { inGuild: false, roles: [STAFF_ROLE_ID] }), false);
  });

  await test('file adapter reloads after a new process handle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g935-catalog-'));
    const file = path.join(dir, 'nested', 'catalog.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = openCatalogStore({ enabled: true, root: dir, path: file });
    assert.equal(first.ready(), true);
    const saved = first.save({ revision: 1, updated_at: '2026-11-11T00:00:00.000Z', changes: [{ side: 'buy', name: 'M4A1', price: 3500, in_stock: false, discount: null }], audit: [] });
    assert.equal(saved.ok, true);
    const second = openCatalogStore({ enabled: true, root: dir, path: file });
    const loaded = second.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.doc.revision, 1);
    assert.equal(loaded.doc.changes[0].in_stock, false);
    assert.equal(loaded.doc.changes[0].price, 3500);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g935-catalog-api-'));
  const file = path.join(dir, 'catalog.json');
  const store = openCatalogStore({ enabled: true, root: dir, path: file });

  await test('trader alone cannot edit and the file stays empty', async () => {
    await withApp({ roles: [TRADER_ROLE_ID], catalogStore: store }, async (app, origin) => {
      const me = await request(origin, '/api/me', { cookie: cookie(app, '111111111111111111') });
      assert.equal(me.json.access.trader_mode_allowed, true);
      assert.equal(me.json.access.admin_mode_allowed, false);
      assert.equal(me.json.access.writes, false);
      const post = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        cookie: cookie(app, '111111111111111111'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 0, changes: [{ side: 'buy', name: 'M4A1', price: 1, in_stock: true, discount: null }], roles: [OWNER_ROLE_ID] }),
      });
      assert.equal(post.status, 403);
      assert.equal(post.json.reason, 'catalog_edit_required');
      assert.equal(post.text.includes('M4A1'), false);
      assert.equal(fs.existsSync(file), false);
    });
  });

  await test('owner and high level staff can save, reload, and audit without secrets', async () => {
    await withApp({ roles: [OWNER_ROLE_ID, TRADER_ROLE_ID], catalogStore: store }, async (app, origin) => {
      const sid = cookie(app, '444444444444444444');
      const post = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        cookie: sid,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 0, changes: [{ side: 'buy', name: 'M4A1', price: 3500, in_stock: false, discount: { type: 'percent', value: 0 } }] }),
      });
      assert.equal(post.status, 200);
      assert.equal(post.json.saved, true);
      assert.equal(post.json.changes[0].in_stock, false);
      assert.equal(post.json.changes[0].discount, null);
      assert.equal(post.text.includes(SECRET), false);
    });
    const again = openCatalogStore({ enabled: true, root: dir, path: file });
    assert.equal(again.load().doc.changes[0].name, 'M4A1');
    await withApp({ roles: [STAFF_ROLE_ID], catalogStore: again }, async (app, origin) => {
      const stale = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        cookie: cookie(app, '555555555555555555'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 0, changes: [] }),
      });
      assert.equal(stale.status, 409);
      const hostile = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'https://evil.example',
        cookie: cookie(app, '555555555555555555'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: again.load().doc.revision, changes: [] }),
      });
      assert.equal(hostile.status, 403);
      const missing = await request(origin, '/api/catalog', {
        method: 'POST',
        cookie: cookie(app, '555555555555555555'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: again.load().doc.revision, changes: [] }),
      });
      assert.equal(missing.status, 403);
      const injected = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        cookie: cookie(app, '555555555555555555'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: again.load().doc.revision, changes: [{ side: 'buy', name: '<img>', price: 1, in_stock: true, discount: null }] }),
      });
      assert.equal(injected.status, 400);
      assert.equal(injected.text.includes('<img>'), false);
      const bible = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        cookie: cookie(app, '555555555555555555'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: again.load().doc.revision, changes: [{ side: 'sell', name: 'Bible', price: 1, in_stock: true, discount: null }] }),
      });
      assert.equal(bible.status, 400);
      assert.equal(bible.json.error, 'invalid_price');
    });
    const audit = again.load().doc.audit;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, '444444444444444444');
    assert.equal(JSON.stringify(audit).includes(SECRET), false);
    assert.equal(audit[0].changes[0].old, null);
    assert.equal(audit[0].changes[0].new.in_stock, false);
  });

  await test('ordinary member and a closed store cannot write', async () => {
    const closed = openCatalogStore({ enabled: true, path: '/var/data/catalog.json' });
    await withApp({ roles: [], catalogStore: closed }, async (app, origin) => {
      const post = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        cookie: cookie(app, '111111111111111111'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 0, changes: [] }),
      });
      assert.equal(post.status, 403);
      assert.equal(post.json.reason, 'catalog_edit_required');
      const anon = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 0, changes: [] }),
      });
      assert.equal(anon.status, 401);
    });
    await withApp({ roles: [OWNER_ROLE_ID], catalogStore: closed }, async (app, origin) => {
      const post = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        cookie: cookie(app, '444444444444444444'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 0, changes: [] }),
      });
      assert.equal(post.status, 503);
      assert.equal(post.json.configured, false);
    });
  });

  await test('role rules prefill the current calculator terms and do not invent ids', async () => {
    const { builtinRoleRules, pricingRoleNames } = require('../lib/role-rules');
    const rules = builtinRoleRules();
    const road = rules.find((rule) => rule.name === 'Roadkill');
    assert.equal(road.effects.find((effect) => effect.name === 'Car Battery').discount.value, 25);
    assert.equal(road.effects.some((effect) => effect.name === 'Trader Car' || effect.name === 'Trader Truck'), false);
    assert.equal(rules.find((rule) => rule.name === 'Dr. Greenthumb').effects.find((effect) => effect.name === 'Cannabis').price, 30);
    assert.equal(rules.find((rule) => rule.name === 'Day One').cart_percent, 10);
    assert.equal(rules.find((rule) => rule.name === 'All Your Base').effects.find((effect) => effect.name === 'Faction Flags').discount.value, 100);
    assert.deepEqual(pricingRoleNames(['1215040829186383912'], {}), []);
    const { roleSourceTable, resolveRole, buyLinePrice } = require('../lib/role-sources');
    const table = roleSourceTable(rules);
    const boom = table.find((row) => row.name === 'Click Click Boom');
    assert.equal(boom.source, 'calculator');
    assert.equal(boom.tag, 'calculator term');
    assert.equal(boom.discord_statement, '7% off everything');
    assert.equal(boom.applied_percent, null);
    assert.equal(rules.find((rule) => rule.name === 'Click Click Boom').effects.find((effect) => effect.name === 'Grenade').discount.value, 20);
    const day = table.find((row) => row.name === 'Day 1');
    assert.equal(day.source, 'calculator');
    assert.equal(day.calculator_name, 'Day One');
    assert.equal(day.applied_percent, null);
    assert.equal(table.some((row) => row.source === 'discord'), false);
    assert.equal(buyLinePrice('Grenade', 1000, ['Click Click Boom']), 800);
    assert.equal(buyLinePrice('M4A1', 3500, ['Click Click Boom']), 3500);
    assert.equal(buyLinePrice('Grenade', 1000, ['Kamikaze', 'Click Click Boom']), 750);
    assert.equal(buyLinePrice('Tundra', 2500, ['Deadshot', 'Hotshot']), 1250);
    const extra = { ExampleRole: { percent: 12, statement: '12% off everything' } };
    const filled = resolveRole('ExampleRole', rules, extra, {});
    assert.equal(filled.source, 'discord');
    assert.equal(filled.tag, 'from Discord');
    assert.equal(filled.applied_percent, 12);
    assert.equal(buyLinePrice('M4A1', 1000, ['ExampleRole'], extra), 880);
    const quiet = resolveRole('ExampleBonus', rules, {}, { ExampleBonus: { statement: 'ongoing bonuses, no %' } });
    assert.equal(quiet.source, 'none');
    assert.equal(quiet.tag, 'no defined terms');
    assert.equal(buyLinePrice('M4A1', 1000, ['ExampleBonus'], {}), 1000);
    const verified = { '123456789012345678': 'Day 1' };
    assert.deepEqual(pricingRoleNames(['123456789012345678'], verified), ['Day One']);
    assert.deepEqual(pricingRoleNames(['123456789012345679'], { '123456789012345679': 'Click Click Boom' }), ['Click Click Boom']);
    await withApp({ roles: [TRADER_ROLE_ID], catalogStore: store }, async (app, origin) => {
      const res = await request(origin, '/api/catalog');
      assert.equal(res.status, 200);
      assert.equal(res.json.pricing_map, 'unverified');
      assert.ok(res.json.role_rules.some((rule) => rule.name === 'Roadkill'));
      const me = await request(origin, '/api/me', { cookie: cookie(app, '333333333333333333') });
      assert.deepEqual(me.json.pricing_roles, []);
    });
  });

  await test('oversized catalog body is refused', async () => {
    await withApp({ roles: [OWNER_ROLE_ID], catalogStore: store }, async (app, origin) => {
      const huge = await request(origin, '/api/catalog', {
        method: 'POST',
        origin: 'http://localhost:8787',
        cookie: cookie(app, '444444444444444444'),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 1, changes: [{ side: 'buy', name: 'M4A1', price: 3500, in_stock: true, discount: null, pad: 'x'.repeat(70 * 1024) }] }),
      });
      assert.equal(huge.status, 413);
    });
  });

  await test('provider search failure is explained and is not an internal error', async () => {
    const botLookup = {
      isConfigured() { return true; },
      unavailable() { return { ok: false, status: 503, error: 'provider_unavailable', reason: 'not_configured' }; },
      async searchMembers() { return { ok: false, status: 500, reason: 'provider_error', provider: 'discord_member_lookup' }; },
      async getMember() { return { ok: false, status: 404, reason: 'not_found' }; },
    };
    await withApp({ roles: [TRADER_ROLE_ID], botLookup, catalogStore: store }, async (app, origin) => {
      const res = await request(origin, '/api/trader/search?q=ada', { cookie: cookie(app, '333333333333333333') });
      assert.equal(res.status, 503);
      assert.equal(res.json.reason, 'member_search_unavailable');
      assert.equal(res.json.lookup_by_id, true);
      assert.equal(res.json.error, 'provider_unavailable');
      assert.equal(res.text.includes('internal_error'), false);
    });
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  console.log('MOCK only — not a live catalog edit or provider call.');
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
