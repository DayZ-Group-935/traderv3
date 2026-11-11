// Account modes against the local POC contract. Mock bodies live only in this harness.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = 'file://' + FILE;
const OUT = process.env.OUT || path.join(__dirname, 'out', 'account-mode');
const ART = '/opt/cursor/artifacts';
const GATEWAY = 'http://127.0.0.1:8787';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(ART, { recursive: true });

const fails = [];
function check(id, ok, detail) {
  if (!ok) fails.push({ id, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 800) : ''));
}

function balance(cash, bank) {
  return {
    ok: true, available: true, mapped: true, provider: 'killfeed', reason: 'ok', write_access: false,
    cash, cash_str: String(cash), bank, bank_str: String(bank)
  };
}
function unavailableBalance() {
  return { ok: false, available: false, mapped: false, provider: 'killfeed', reason: 'not_configured', write_access: false };
}

// Role names and is_* flags are present, but trader_mode_allowed is false.
// The page must not treat them as permission.
const DENIED = {
  identity: { id: '111', username: 'ServerOwner', global_name: 'Alex Rivera' },
  guild: { configured: true, in_guild: true },
  roles: {
    current: ['999001', '999002'],
    trader_role_configured: true,
    server_owner_role_configured: true,
    high_level_staff_role_configured: true,
    is_trader: true,
    is_server_owner: true,
    is_high_level_staff: true,
    discounts: { configured: false, applied: [], amounts_mapped: false, reason: 'discount_role_ids_unverified' }
  },
    access: {
    trader_mode_allowed: false,
    admin_mode_allowed: false,
    grants: { trader: true, server_owner: true, high_level_staff: true },
    trader_role_configured: true,
    server_owner_role_configured: true,
    high_level_staff_role_configured: true,
    writes: false,
    source: 'live_membership'
  },
  balance: balance(840, 100),
  customer_lookup: { configured: true, available: true },
  pricing_roles: []
};

// Server Owner grant is expressed only by trader_mode_allowed. is_trader is false.
const ALLOWED = {
  identity: { id: '222', username: 'riley', global_name: 'Riley Chen' },
  guild: { configured: true, in_guild: true },
  roles: {
    current: ['snowflake-server-owner'],
    trader_role_configured: true,
    server_owner_role_configured: true,
    high_level_staff_role_configured: false,
    is_trader: false,
    is_server_owner: true,
    is_high_level_staff: false,
    discounts: { configured: false, applied: [], amounts_mapped: false, reason: 'discount_role_ids_unverified' }
  },
    access: {
    trader_mode_allowed: true,
    admin_mode_allowed: false,
    grants: { trader: false, server_owner: true, high_level_staff: false },
    trader_role_configured: true,
    server_owner_role_configured: true,
    high_level_staff_role_configured: false,
    writes: false,
    source: 'live_membership'
  },
  balance: balance(80000, 0),
  customer_lookup: { configured: true, available: true },
  pricing_roles: ['Roadkill', 'Hotshot', 'Librarian', 'Mayweather']
};

const CUSTOMERS = {
  '333': {
    id: '333', username: 'jordan', global_name: 'Jordan Hale', nick: 'Jordan Hale', roles: ['role-customer'],
    balance: balance(4200, 800),
    pricing_roles: ['Deadshot', 'Dr. Greenthumb', 'Pathfinder', 'Kamikaze', 'Day One']
  },
  '444444444444444444': {
    id: '444444444444444444', username: 'jonah', global_name: 'Jonah Pike', nick: 'Jonah Pike', roles: ['role-customer'],
    balance: balance(10, 0),
    pricing_roles: null
  }
};

async function shot(page, name) {
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); });
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  fs.copyFileSync(file, path.join(ART, name + '.png'));
}

async function boot(browser, { gateway, me, width, failMe, lookupMs, delayMe, slowQuery, slowMs } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FILE_NOT_FOUND|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.evaluateOnNewDocument((opts) => {
    window.__935AccountCalls = [];
    const state = { me: opts.me };
    const customers = opts.customers;
    if (opts.gateway) {
      window.__935AccountGateway = opts.gateway;
      window.__935AccountFixture = true;
    }
    if (opts.lookupMs) window.__935AccountLookupMs = opts.lookupMs;
    const orig = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      const u = new URL(String(url), opts.gateway || 'http://127.0.0.1:8787');
      const method = ((init && init.method) || 'GET').toUpperCase();
      window.__935AccountCalls.push({
        method,
        path: u.pathname + u.search,
        authorization: !!(init && init.headers && (init.headers.Authorization || init.headers.authorization)),
        credentials: init && init.credentials
      });
      if (!opts.gateway || u.origin !== opts.gateway) return orig(url, init);
      const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (u.pathname === '/api/me' && method === 'GET') {
        if (opts.failMe === 'reject') throw new Error('network');
        if (opts.failMe === '500') return json(500, { error: 'internal_error' });
        if (opts.failMe === 'hang') await new Promise(() => {});
        if (opts.delayMe) await new Promise(resolve => { window.__935ReleaseMe = resolve; });
        if (!state.me) return json(401, { error: 'unauthorized' });
        return json(200, state.me);
      }
      if (u.pathname === '/api/catalog' && method === 'GET') {
        return json(200, { configured: false, revision: 0, changes: [] });
      }
      if (u.pathname === '/auth/logout' && method === 'POST') {
        state.me = null;
        return json(200, { ok: true });
      }
      const allowed = !!(state.me && state.me.access && state.me.access.trader_mode_allowed === true);
      if (!allowed && (u.pathname === '/api/trader/search' || u.pathname.indexOf('/api/trader/players/') === 0)) {
        return json(403, { error: 'forbidden', reason: 'elevated_role_required' });
      }
      if (u.pathname === '/api/trader/search' && method === 'GET') {
        const q = u.searchParams.get('q') || '';
        if (opts.slowQuery && q === opts.slowQuery) await new Promise(resolve => setTimeout(resolve, opts.slowMs || 600));
        if (!q) return json(400, { reason: 'missing_query', provider: 'discord_member_lookup' });
        const results = Object.values(customers).filter(c => {
          const hay = [c.username, c.global_name, c.nick].join(' ').toLowerCase();
          return hay.includes(q.toLowerCase());
        }).map(c => ({ id: c.id, username: c.username, global_name: c.global_name, nick: c.nick, roles: c.roles }));
        return json(200, {
          results,
          live_customer_functionality: false,
          killfeed_search: { ok: false, available: false, status: 503, provider: 'killfeed_search', reason: 'not_configured', write_access: false }
        });
      }
      if (u.pathname.indexOf('/api/trader/players/') === 0 && method === 'GET') {
        const id = decodeURIComponent(u.pathname.slice('/api/trader/players/'.length));
        const c = customers[id];
        if (!c) return json(404, { error: 'not_found' });
        const body = {
          lookup: { id, member: { id: c.id, username: c.username, global_name: c.global_name, nick: c.nick, roles: c.roles } },
          balance: c.balance,
          live_customer_functionality: false
        };
        if (Array.isArray(c.pricing_roles)) body.pricing_roles = c.pricing_roles;
        return json(200, body);
      }
      return json(404, { error: 'not_found' });
    };
    window.__935AccountTest = {
      setMe(next) { state.me = next; }
    };
  }, { gateway: gateway || null, me: me || null, customers: CUSTOMERS, failMe: failMe || '', lookupMs: lookupMs || 0, delayMe: !!delayMe, slowQuery: slowQuery || '', slowMs: slowMs || 0 });
  const wideViewport = (width || 375) >= 1000;
  await page.setViewport({
    width: width || 375,
    height: wideViewport ? 900 : 812,
    deviceScaleFactor: 1,
    isMobile: !wideViewport,
    hasTouch: !wideViewport
  });
  await page.goto(URL, { waitUntil: 'load' });
  return { page, errors };
}

function readBar() {
  const bar = document.getElementById('accountBar');
  const meta = document.getElementById('accountMeta');
  const trader = document.getElementById('modeTraderBtn');
  const admin = document.getElementById('modeAdminBtn');
  const self = document.getElementById('modeSelfBtn');
  const signIn = document.getElementById('accountSignIn');
  const app = document.querySelector('.app');
  return {
    status: document.getElementById('accountStatus').innerText.replace(/\s+/g, ' ').trim(),
    who: ((document.querySelector('#accountStatus .account-who') || {}).textContent || '').replace(/★/g, '').trim(),
    meta: meta.hidden ? '' : meta.textContent,
    fixture: document.getElementById('accountFixture').hidden ? '' : document.getElementById('accountFixture').textContent.trim(),
    traderMode: document.body.classList.contains('trader-mode'),
    traderHidden: !trader || trader.hidden,
    adminHidden: !admin || admin.hidden,
    adminMode: document.body.classList.contains('mode-admin'),
    selfPressed: self.getAttribute('aria-pressed'),
    searchOpen: !document.getElementById('accountSearch').hidden,
    signIn: signIn.hidden ? '' : signIn.getAttribute('href'),
    signOut: !document.getElementById('accountSignOut').hidden,
    outline: getComputedStyle(document.body).boxShadow,
    selfH: Math.round(self.getBoundingClientRect().height),
    traderH: Math.round(trader.getBoundingClientRect().height),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    barText: bar.innerText.replace(/\s+/g, ' ').trim(),
    nav: document.querySelectorAll('#buyGrid .catstack > .catrow').length,
    rolesUi: !!document.getElementById('rolesDockBtn') || !!document.getElementById('rolesGrid'),
    calls: (window.__935AccountCalls || []).map(c => c.method + ' ' + c.path + ' auth=' + c.authorization + ' cred=' + c.credentials)
  };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none']
  });

  const plain = await boot(browser, { width: 375 });
  await plain.page.waitForFunction(() => document.getElementById('accountStatus').textContent.includes('not configured'));
  const unconfigured = await plain.page.evaluate(readBar);
  check('unconfigured-stays-offline',
    unconfigured.status === 'Sign-in is not configured' && unconfigured.meta === '' && unconfigured.fixture === '' &&
    !unconfigured.traderMode && unconfigured.traderHidden && unconfigured.adminHidden && unconfigured.signIn === '' && !unconfigured.signOut &&
    unconfigured.calls.length === 0 && unconfigured.nav >= 1 && unconfigured.rolesUi === false &&
    unconfigured.selfH === 0 && unconfigured.scrollW <= unconfigured.clientW + 1 &&
    /255,\s*155,\s*61/.test(unconfigured.outline) &&
    !/Cash|Bank|Jordan|Riley|4200|80000/.test(unconfigured.barText),
    unconfigured);
  await plain.page.evaluate(() => {
    localStorage.setItem('935calc-capability', 'trader');
    localStorage.setItem('discord-role', 'ServerOwner');
    localStorage.setItem('username', 'HighLevelStaff');
  });
  await plain.page.reload({ waitUntil: 'load' });
  await plain.page.waitForFunction(() => document.getElementById('accountStatus').textContent.includes('not configured'));
  const stored = await plain.page.evaluate(readBar);
  check('local-storage-does-not-grant-trader-mode', !stored.traderMode && stored.traderHidden && stored.adminHidden && stored.calls.length === 0, stored);
  check('unconfigured-privileged-controls-stay-hidden', stored.traderHidden && stored.adminHidden && !stored.traderMode && !stored.adminMode, stored);
  check('plain-console', plain.errors.length === 0, plain.errors.slice(0, 4));
  await plain.page.close();

  const denied = await boot(browser, { gateway: GATEWAY, me: DENIED, width: 375 });
  await denied.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Alex Rivera'));
  const deniedView = await denied.page.evaluate(readBar);
  check('flags-and-username-do-not-allow-trader-mode',
    deniedView.who === 'Alex Rivera' && deniedView.traderHidden && deniedView.adminHidden && !deniedView.traderMode && !deniedView.adminMode &&
    deniedView.meta.indexOf('Cash 840') >= 0 && deniedView.meta.indexOf('Bank 100') >= 0 &&
    deniedView.meta.indexOf('Server Owner') >= 0 && deniedView.calls.some(c => c.indexOf('GET /api/me') === 0) &&
    deniedView.calls.every(c => c.indexOf('auth=false') >= 0 && c.indexOf('cred=include') >= 0),
    deniedView);
  const deniedAfter = await denied.page.evaluate(readBar);
  check('denied-click-does-not-search', deniedAfter.traderHidden && deniedAfter.adminHidden && !deniedAfter.traderMode && !deniedAfter.calls.some(c => c.indexOf('/api/trader/') >= 0), deniedAfter.calls);
  check('denied-console', denied.errors.length === 0, denied.errors.slice(0, 4));
  await denied.page.close();

  const desk = await boot(browser, { gateway: GATEWAY, me: ALLOWED, width: 375 });
  await desk.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Riley Chen'));
  const mine = await desk.page.evaluate(readBar);
  check('my-account-is-default',
    mine.who === 'Riley Chen' && mine.selfPressed === 'true' && !mine.traderMode && !mine.traderHidden && mine.adminHidden &&
    /255,\s*155,\s*61/.test(mine.outline) &&
    mine.fixture === 'Test fixture' && mine.meta.indexOf('Cash 80000') >= 0 && mine.meta.indexOf('Bank 0') >= 0 &&
    mine.meta.indexOf('Server Owner') >= 0 && mine.signOut && mine.scrollW <= mine.clientW + 1,
    mine);
  await shot(desk.page, 'account-my-375');

  await desk.page.click('#modeTraderBtn');
  await desk.page.waitForFunction(() => document.body.classList.contains('trader-mode') && document.getElementById('accountStatus').innerText.includes('Select a customer'));
  const picking = await desk.page.evaluate(readBar);
  check('trader-mode-uses-server-allowance',
    picking.traderMode && picking.status.indexOf('TRADER MODE') >= 0 && picking.who === 'Select a customer' &&
    picking.meta === '' && picking.searchOpen && /61,\s*220,\s*151/.test(picking.outline),
    picking);
  await shot(desk.page, 'account-trader-select-375');

  await desk.page.type('#customerSearch', 'jor');
  await desk.page.waitForFunction(() => [...document.querySelectorAll('#customerResults [role="option"]')].some(b => b.textContent === 'Jordan Hale'));
  const searched = await desk.page.evaluate(() => ({
    names: [...document.querySelectorAll('#customerResults [role="option"]')].map(b => b.textContent),
    box: document.getElementById('customerResults').innerText,
    calls: window.__935AccountCalls.map(c => c.method + ' ' + c.path)
  }));
  check('search-uses-contract-route',
    searched.names.join('|') === 'Jordan Hale' && !/4200|Cash|Bank/.test(searched.box) &&
    searched.calls.some(c => c === 'GET /api/trader/search?q=jor'),
    searched);

  await desk.page.click('#customerResults [role="option"]');
  await desk.page.waitForFunction(() => document.getElementById('accountMeta').textContent.includes('4200'));
  const selected = await desk.page.evaluate(readBar);
  check('customer-lookup-uses-player-route',
    selected.traderMode && selected.who === 'Jordan Hale' && selected.meta === 'Cash 4200 · Bank 800' &&
    !selected.searchOpen && selected.calls.some(c => c.indexOf('GET /api/trader/players/333') === 0) &&
    !/live_customer_functionality/.test(selected.barText) && selected.scrollW <= selected.clientW + 1,
    selected);
  await shot(desk.page, 'account-trader-375');

  await desk.page.click('#modeSelfBtn');
  const exited = await desk.page.evaluate(readBar);
  check('exit-clears-customer',
    !exited.traderMode && exited.who === 'Riley Chen' && exited.meta.indexOf('Cash 80000') >= 0 &&
    !/Jordan Hale|4200/.test(exited.barText),
    exited);

  await desk.page.click('#modeTraderBtn');
  await desk.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Select a customer'));
  await desk.page.type('#customerSearch', 'Hale');
  await desk.page.waitForSelector('#customerResults [role="option"]');
  await desk.page.click('#customerResults [role="option"]');
  await desk.page.waitForFunction(() => document.getElementById('accountMeta').textContent.includes('4200'));
  await desk.page.evaluate(deniedMe => {
    window.__935AccountTest.setMe(deniedMe);
    return window.__935AccountRefresh();
  }, DENIED);
  const revoked = await desk.page.evaluate(readBar);
  check('revoke-clears-customer-and-mode',
    !revoked.traderMode && revoked.traderHidden && revoked.adminHidden && !revoked.adminMode && revoked.who === 'Alex Rivera' &&
    !/Jordan Hale|4200|TRADER MODE/.test(revoked.barText),
    revoked);

  await desk.page.evaluate(() => {
    window.__935AccountTest.setMe(null);
    return document.getElementById('accountSignOut').click() || true;
  });
  await desk.page.waitForFunction(() => document.getElementById('accountStatus').textContent === 'Signed out');
  const loggedOut = await desk.page.evaluate(readBar);
  check('logout-posts-contract-and-clears-balance',
    loggedOut.status === 'Signed out' && loggedOut.meta === '' && !loggedOut.traderMode &&
    loggedOut.signIn === GATEWAY + '/auth/discord/login' &&
    loggedOut.calls.some(c => c.indexOf('POST /auth/logout') === 0) &&
    !/Cash|Bank|Jordan|Riley|4200|80000/.test(loggedOut.barText),
    loggedOut);

  await desk.page.evaluate(allowed => {
    window.__935AccountTest.setMe(allowed);
    return window.__935AccountRefresh();
  }, ALLOWED);
  await desk.page.click('#modeTraderBtn');
  await desk.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Select a customer'));
  await desk.page.type('#customerSearch', 'Jordan');
  await desk.page.waitForSelector('#customerResults [role="option"]');
  await desk.page.click('#customerResults [role="option"]');
  await desk.page.waitForFunction(() => document.getElementById('accountMeta').textContent.includes('4200'));
  await desk.page.reload({ waitUntil: 'load' });
  await desk.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Riley Chen'));
  const refreshed = await desk.page.evaluate(readBar);
  check('refresh-resets-customer',
    !refreshed.traderMode && refreshed.who === 'Riley Chen' && !/Jordan Hale|4200|TRADER MODE/.test(refreshed.barText) &&
    refreshed.nav >= 1 && refreshed.rolesUi === false,
    refreshed);
  const calc = await desk.page.evaluate(() => {
    addToCart('buy', 'M4A1', 1, 3500);
    return {
      total: document.querySelector('#totalChip .tc-value').textContent,
      weapons: [...document.querySelectorAll('#buyGrid .cat-btn')].some(b => b.textContent.trim() === 'Weapons')
    };
  });
  check('offline-calculator-still-works', calc.total.indexOf('3,500') >= 0 && calc.weapons, calc);
  check('trader-console', desk.errors.length === 0, desk.errors.slice(0, 6));
  await desk.page.close();

  const loading = await boot(browser, { gateway: GATEWAY, me: ALLOWED, delayMe: true, width: 390 });
  const early = await loading.page.evaluate(readBar);
  check('loading-hides-privileged-controls',
    early.traderHidden && early.adminHidden && early.selfH === 0 && !early.traderMode && !early.adminMode &&
    early.status === 'Checking account',
    early);
  await loading.page.evaluate(() => window.__935ReleaseMe && window.__935ReleaseMe());
  await loading.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Riley Chen'));
  const revealed = await loading.page.evaluate(readBar);
  check('loaded-trader-shows-admin-stays-hidden',
    !revealed.traderHidden && revealed.adminHidden && !revealed.adminMode && /255,\s*155,\s*61/.test(revealed.outline),
    revealed);
  await loading.page.close();

  for (const failMe of ['401', '500', 'reject', 'hang']) {
    const failed = await boot(browser, {
      gateway: GATEWAY,
      me: null,
      width: 390,
      failMe: failMe === '401' ? '' : failMe,
      lookupMs: failMe === 'hang' ? 200 : 0
    });
    await failed.page.waitForFunction(() => document.getElementById('accountStatus').textContent === 'Signed out', { timeout: 4000 });
    const settled = await failed.page.evaluate(readBar);
    check('me-' + failMe + '-resolves-signed-out',
      settled.status === 'Signed out' && settled.selfH === 0 && settled.traderHidden && settled.adminHidden &&
      settled.signIn === GATEWAY + '/auth/discord/login' && !settled.signOut,
      settled);
    await failed.page.close();
  }

  const burst = await boot(browser, { gateway: GATEWAY, me: ALLOWED, width: 390 });
  await burst.page.click('#modeTraderBtn');
  await burst.page.waitForFunction(() => document.body.classList.contains('mode-trader'));
  await burst.page.type('#customerSearch', 'jordan', { delay: 15 });
  await new Promise(resolve => setTimeout(resolve, 500));
  const burstCalls = await burst.page.evaluate(() => (window.__935AccountCalls || []).filter(c => c.path.indexOf('/api/trader/search') === 0).map(c => c.path));
  check('search-debounce-collapses-a-burst', burstCalls.length === 1 && burstCalls[0].indexOf('q=jordan') >= 0, burstCalls);
  await burst.page.close();

  const stale = await boot(browser, { gateway: GATEWAY, me: ALLOWED, width: 390, slowQuery: 'jo', slowMs: 700 });
  await stale.page.click('#modeTraderBtn');
  await stale.page.waitForFunction(() => document.body.classList.contains('mode-trader'));
  await stale.page.type('#customerSearch', 'jo', { delay: 10 });
  await new Promise(resolve => setTimeout(resolve, 400));
  await stale.page.type('#customerSearch', 'r', { delay: 0 });
  await stale.page.waitForFunction(() => {
    const text = document.getElementById('customerResults').innerText;
    return text.includes('Jordan Hale') && !text.includes('Jonah');
  });
  await new Promise(resolve => setTimeout(resolve, 900));
  const staleText = await stale.page.evaluate(() => document.getElementById('customerResults').innerText);
  check('search-ignores-stale-response', staleText.includes('Jordan Hale') && !staleText.includes('Jonah'), staleText);
  await stale.page.close();

  const ADMIN = JSON.parse(JSON.stringify(ALLOWED));
  ADMIN.access.admin_mode_allowed = true;
  ADMIN.access.trader_mode_allowed = true;
  const staff = await boot(browser, { gateway: GATEWAY, me: ADMIN, width: 390 });
  await staff.page.waitForFunction(() => !document.getElementById('modeAdminBtn').hidden && !document.getElementById('modeTraderBtn').hidden);
  const staffIdle = await staff.page.evaluate(readBar);
  check('staff-starts-in-my-account',
    staffIdle.selfPressed === 'true' && staffIdle.adminHidden === false && staffIdle.traderHidden === false &&
    !staffIdle.adminMode && /255,\s*155,\s*61/.test(staffIdle.outline),
    staffIdle);
  await staff.page.click('#modeAdminBtn');
  await staff.page.waitForFunction(() => document.body.classList.contains('mode-admin') && document.getElementById('managePanel') && !document.getElementById('managePanel').hidden);
  const adminView = await staff.page.evaluate(readBar);
  const manage = await staff.page.evaluate(() => ({
    title: document.querySelector('#managePanel h2').textContent,
    note: document.getElementById('manageNote').textContent,
    sample: document.body.innerText.includes('SAMPLE DATA') || document.body.innerText.includes('DESIGN PREVIEW'),
    purple: getComputedStyle(document.body).boxShadow
  }));
  check('admin-mode-purple-and-catalog-title',
    adminView.adminMode && adminView.status.indexOf('ADMIN MODE') >= 0 && adminView.traderMode === false &&
    manage.title === 'Manage catalog' && /226,\s*196,\s*255/.test(manage.purple) && !manage.sample &&
    /durable catalog store/.test(manage.note),
    { adminView, manage });
  await staff.page.evaluate(next => { window.__935AccountTest.setMe(next); return window.__935AccountRefresh(); }, ALLOWED);
  await staff.page.waitForFunction(() => document.getElementById('modeAdminBtn').hidden && document.getElementById('accountStatus').innerText.includes('Riley Chen'));
  const dropped = await staff.page.evaluate(readBar);
  check('admin-revoke-returns-my-account',
    dropped.adminHidden && !dropped.adminMode && !dropped.traderHidden && dropped.who === 'Riley Chen' &&
    !/ADMIN MODE/.test(dropped.barText),
    dropped);
  await staff.page.close();

  const roles = await boot(browser, { gateway: GATEWAY, me: ALLOWED, width: 390 });
  await roles.page.waitForFunction(() => document.getElementById('rolesBtn').textContent === 'Roles 4');
  await roles.page.evaluate(() => {
    const banner = document.createElement('div');
    banner.textContent = 'MOCK DATA';
    banner.style.cssText = 'position:fixed;top:0;left:0;z-index:80;background:#7a4a30;color:#f3e9d6;font:700 11px ui-monospace,monospace;letter-spacing:.12em;padding:4px 8px';
    document.body.appendChild(banner);
  });
  const mineBtn = await roles.page.evaluate(() => {
    const btn = document.getElementById('rolesBtn');
    const change = document.getElementById('customerChangeBtn');
    return {
      text: btn.textContent,
      quiet: btn.classList.contains('is-quiet'),
      disabled: btn.disabled,
      changeHidden: change.hidden,
      star: !!document.querySelector('.day-one-star'),
      beside: btn.parentElement === change.parentElement
    };
  });
  check('my-account-roles-button',
    mineBtn.text === 'Roles 4' && !mineBtn.quiet && !mineBtn.disabled && mineBtn.changeHidden && !mineBtn.star && mineBtn.beside,
    mineBtn);
  await roles.page.click('#rolesBtn');
  await roles.page.waitForFunction(() => document.body.classList.contains('roles-open') && document.querySelectorAll('#earnRolesGrid .earn-role').length === 22);
  const popup = await roles.page.evaluate(() => {
    const grid = document.getElementById('earnRolesGrid');
    const buttons = [...grid.querySelectorAll('.earn-role')];
    const road = buttons.find(row => row.textContent.includes('Roadkill'));
    const pop = document.getElementById('rolesPop').getBoundingClientRect();
    const view = document.documentElement.clientHeight;
    return {
      open: document.body.classList.contains('roles-open'),
      count: buttons.length,
      dayOne: buttons.some(row => row.textContent.includes('Day One')),
      road: road ? road.textContent.replace(/\s+/g, ' ').trim() : '',
      roadHeld: !!(road && road.classList.contains('is-held')),
      inputs: grid.querySelectorAll('input, select, textarea, [role="switch"]').length,
      detail: grid.querySelectorAll('.earn-role-detail').length,
      short: pop.height < view * 0.85
    };
  });
  check('roles-popup-names-only',
    popup.open && popup.count === 22 && !popup.dayOne && popup.roadHeld && popup.road === '✓Roadkill' &&
    popup.inputs === 0 && popup.detail === 0 && popup.short,
    popup);
  await roles.page.evaluate(() => [...document.querySelectorAll('#earnRolesGrid .earn-role')].find(item => item.textContent.includes('Roadkill')).click());
  const roleDetail = await roles.page.evaluate(() => {
    const detail = document.querySelector('#earnRolesGrid .earn-role-detail');
    return {
      text: detail ? detail.innerText.replace(/\s+/g, ' ').trim() : '',
      held: document.querySelectorAll('#earnRolesGrid .earn-role.is-held').length,
      label: document.getElementById('rolesBtn').textContent
    };
  });
  check('roles-popup-reveals-detail',
    /Flatten a player/.test(roleDetail.text) && /25% off car parts/.test(roleDetail.text) && roleDetail.held === 4 && roleDetail.label === 'Roles 4',
    roleDetail);
  await roles.page.evaluate(() => [...document.querySelectorAll('#earnRolesGrid .earn-role')].find(item => item.textContent.includes('Roadkill')).click());
  const collapsed = await roles.page.evaluate(() => document.querySelectorAll('#earnRolesGrid .earn-role-detail').length);
  check('roles-popup-collapses-detail', collapsed === 0, collapsed);
  await roles.page.click('#rolesPopClose');
  await roles.page.waitForFunction(() => !document.body.classList.contains('roles-open'));
  check('roles-popup-closes-to-my-account', await roles.page.evaluate(() => document.getElementById('accountStatus').innerText.includes('Riley Chen') && !document.querySelector('.day-one-star')));
  await roles.page.click('#modeTraderBtn');
  await roles.page.waitForFunction(() => document.body.classList.contains('mode-trader'));
  check('roles-button-hidden-until-customer', await roles.page.evaluate(() => document.getElementById('rolesBtn').hidden === true));
  await roles.page.type('#customerSearch', 'jor');
  await roles.page.waitForFunction(() => [...document.querySelectorAll('#customerResults [role="option"]')].some(b => b.textContent === 'Jordan Hale'));
  await roles.page.click('#customerResults [role="option"]');
  await roles.page.waitForFunction(() => document.getElementById('rolesBtn').textContent === 'Roles 4' && document.querySelector('.day-one-star'));
  const header = await roles.page.evaluate(() => {
    const rolesBtn = document.getElementById('rolesBtn');
    const change = document.getElementById('customerChangeBtn');
    const star = document.querySelector('.day-one-star');
    return {
      roles: rolesBtn.textContent,
      change: change.textContent,
      changeHidden: change.hidden,
      sameRow: rolesBtn.parentElement === change.parentElement && !change.hidden && !rolesBtn.hidden,
      star: star ? star.getAttribute('aria-label') : '',
      title: star ? star.title : '',
      heightGap: Math.abs(rolesBtn.getBoundingClientRect().height - change.getBoundingClientRect().height)
    };
  });
  check('trader-roles-beside-change-with-star',
    header.roles === 'Roles 4' && header.change === 'Change' && header.sameRow && header.star === 'Day One' && header.title === 'Day One' && header.heightGap < 2,
    header);
  await shot(roles.page, 'roles-trader-header-390-mock');
  await roles.page.click('#rolesBtn');
  await roles.page.waitForFunction(() => document.body.classList.contains('roles-open') && !document.querySelector('.earn-role-detail'));
  await shot(roles.page, 'roles-popup-390-mock');
  const customerPopup = await roles.page.evaluate(() => {
    const grid = document.getElementById('earnRolesGrid');
    const held = (name) => {
      const row = [...grid.querySelectorAll('.earn-role')].find(item => item.textContent.includes(name));
      return !!(row && row.classList.contains('is-held'));
    };
    return {
      deadshot: held('Deadshot'),
      roadkill: held('Roadkill'),
      dayOne: [...grid.querySelectorAll('.earn-role')].some(item => item.textContent.includes('Day One'))
    };
  });
  check('customer-roles-follow-server-list', customerPopup.deadshot && !customerPopup.roadkill && !customerPopup.dayOne, customerPopup);
  await roles.page.evaluate(() => [...document.querySelectorAll('#earnRolesGrid .earn-role')].find(item => item.textContent.includes('Deadshot')).click());
  await roles.page.waitForFunction(() => {
    const detail = document.querySelector('.earn-role-detail');
    return detail && detail.innerText.includes('50% off 7 items');
  });
  await shot(roles.page, 'roles-popup-detail-390-mock');
  await roles.page.click('#rolesPopClose');
  await roles.page.evaluate(() => document.getElementById('customerChangeBtn').click());
  await roles.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Select a customer'));
  await roles.page.evaluate(() => { document.getElementById('customerIdRow').hidden = false; document.getElementById('customerIdInput').value = '444444444444444444'; });
  await roles.page.click('#customerIdBtn');
  await roles.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Jonah Pike'));
  const unavailable = await roles.page.evaluate(() => ({
    chip: document.getElementById('rolesBtn').textContent,
    who: document.getElementById('accountStatus').innerText,
    meta: document.getElementById('accountMeta').textContent,
    dock: !!document.getElementById('calculateBtn')
  }));
  check('missing-role-lookup-keeps-the-order-panel',
    unavailable.chip === 'Roles unavailable' && /Jonah Pike/.test(unavailable.who) && /Cash 10/.test(unavailable.meta) && unavailable.dock,
    unavailable);
  check('roles-console', roles.errors.length === 0, roles.errors.slice(0, 4));
  await roles.page.close();

  const widePage = await boot(browser, { gateway: GATEWAY, me: ALLOWED, width: 1280 });
  await widePage.page.evaluate(() => {
    const banner = document.createElement('div');
    banner.textContent = 'MOCK DATA';
    banner.style.cssText = 'position:fixed;top:8px;left:8px;z-index:80;background:#7a4a30;color:#f3e9d6;font:700 11px ui-monospace,monospace;letter-spacing:.12em;padding:4px 8px';
    document.body.appendChild(banner);
  });
  await widePage.page.click('#modeTraderBtn');
  await widePage.page.waitForFunction(() => document.body.classList.contains('mode-trader'));
  await widePage.page.type('#customerSearch', 'jor');
  await widePage.page.waitForFunction(() => [...document.querySelectorAll('#customerResults [role="option"]')].some(b => b.textContent === 'Jordan Hale'));
  await widePage.page.click('#customerResults [role="option"]');
  await widePage.page.waitForFunction(() => document.getElementById('rolesBtn').textContent === 'Roles 4' && document.getElementById('accountStatus').innerText.includes('Jordan Hale'));
  await widePage.page.click('#rolesBtn');
  await widePage.page.waitForFunction(() => document.body.classList.contains('roles-open') && document.querySelectorAll('#earnRolesGrid .earn-role').length === 22);
  const wide = await widePage.page.evaluate(() => {
    const grid = document.getElementById('earnRolesGrid');
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const pop = document.getElementById('rolesPop').getBoundingClientRect();
    const deadshot = [...grid.querySelectorAll('.earn-role')].find(row => row.textContent.includes('Deadshot'));
    const a = grid.querySelector('.earn-role').getBoundingClientRect();
    const b = grid.querySelectorAll('.earn-role')[1].getBoundingClientRect();
    return {
      cols,
      width: Math.round(pop.width),
      height: Math.round(pop.height),
      open: document.body.classList.contains('roles-open'),
      deadshot: !!(deadshot && deadshot.classList.contains('is-held')),
      dayOne: [...grid.querySelectorAll('.earn-role')].some(row => row.textContent.includes('Day One')),
      equal: Math.abs(a.width - b.width) < 2
    };
  });
  check('roles-popup-two-columns-at-1280',
    wide.open && wide.cols === 2 && wide.width > 400 && wide.width < 700 && wide.height < 700 && wide.deadshot && !wide.dayOne && wide.equal,
    wide);
  await shot(widePage.page, 'roles-popup-1280-mock');
  check('roles-wide-console', widePage.errors.length === 0, widePage.errors.slice(0, 4));
  await widePage.page.close();

  await browser.close();
  const summary = { pass: fails.length === 0, failed: fails.length, fails };
  fs.writeFileSync(path.join(OUT, 'account-mode.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(ART, 'account-mode.json'), JSON.stringify(summary, null, 2));
  if (fails.length) {
    console.log('ACCOUNT FAILS', fails.length);
    process.exit(1);
  }
  console.log('ACCOUNT OK', summary.pass);
})().catch(err => { console.error(err); process.exit(1); });
