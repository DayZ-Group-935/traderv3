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
    grants: { trader: true, server_owner: true, high_level_staff: true },
    trader_role_configured: true,
    server_owner_role_configured: true,
    high_level_staff_role_configured: true,
    writes: false,
    source: 'live_membership'
  },
  balance: balance(840, 100),
  customer_lookup: { configured: true, available: true }
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
    grants: { trader: false, server_owner: true, high_level_staff: false },
    trader_role_configured: true,
    server_owner_role_configured: true,
    high_level_staff_role_configured: false,
    writes: false,
    source: 'live_membership'
  },
  balance: balance(80000, 0),
  customer_lookup: { configured: true, available: true }
};

const CUSTOMERS = {
  '333': {
    id: '333', username: 'jordan', global_name: 'Jordan Hale', nick: 'Jordan Hale', roles: ['role-customer'],
    balance: balance(4200, 800)
  }
};

async function shot(page, name) {
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); });
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  fs.copyFileSync(file, path.join(ART, name + '.png'));
}

async function boot(browser, { gateway, me, width } = {}) {
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
        if (!state.me) return json(401, { error: 'unauthorized' });
        return json(200, state.me);
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
        return json(200, {
          lookup: { id, member: { id: c.id, username: c.username, global_name: c.global_name, nick: c.nick, roles: c.roles } },
          balance: c.balance,
          live_customer_functionality: false
        });
      }
      return json(404, { error: 'not_found' });
    };
    window.__935AccountTest = {
      setMe(next) { state.me = next; }
    };
  }, { gateway: gateway || null, me: me || null, customers: CUSTOMERS });
  await page.setViewport({ width: width || 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'load' });
  return { page, errors };
}

function readBar() {
  const bar = document.getElementById('accountBar');
  const meta = document.getElementById('accountMeta');
  const trader = document.getElementById('modeTraderBtn');
  const self = document.getElementById('modeSelfBtn');
  const signIn = document.getElementById('accountSignIn');
  const app = document.querySelector('.app');
  return {
    status: document.getElementById('accountStatus').innerText.replace(/\s+/g, ' ').trim(),
    who: (document.querySelector('#accountStatus .account-who') || {}).textContent || '',
    meta: meta.hidden ? '' : meta.textContent,
    fixture: document.getElementById('accountFixture').hidden ? '' : document.getElementById('accountFixture').textContent.trim(),
    traderMode: document.body.classList.contains('trader-mode'),
    traderDisabled: trader.getAttribute('aria-disabled'),
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
    rolesCols: getComputedStyle(document.getElementById('rolesGrid')).gridTemplateColumns.trim().split(/\s+/).length,
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
    !unconfigured.traderMode && unconfigured.traderDisabled === 'true' && unconfigured.signIn === '' && !unconfigured.signOut &&
    unconfigured.calls.length === 0 && unconfigured.nav >= 1 && unconfigured.rolesCols === 2 &&
    unconfigured.selfH >= 44 && unconfigured.traderH >= 44 && unconfigured.scrollW <= unconfigured.clientW + 1 &&
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
  check('local-storage-does-not-grant-trader-mode', !stored.traderMode && stored.traderDisabled === 'true' && stored.calls.length === 0, stored);
  await plain.page.click('#modeTraderBtn');
  const refusedPlain = await plain.page.evaluate(() => ({
    toast: document.getElementById('toast').textContent,
    traderMode: document.body.classList.contains('trader-mode')
  }));
  check('unconfigured-trader-click-fails-closed', /unavailable until account sign-in is configured/.test(refusedPlain.toast) && !refusedPlain.traderMode, refusedPlain);
  check('plain-console', plain.errors.length === 0, plain.errors.slice(0, 4));
  await plain.page.close();

  const denied = await boot(browser, { gateway: GATEWAY, me: DENIED, width: 375 });
  await denied.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Alex Rivera'));
  const deniedView = await denied.page.evaluate(readBar);
  check('flags-and-username-do-not-allow-trader-mode',
    deniedView.who === 'Alex Rivera' && deniedView.traderDisabled === 'true' && !deniedView.traderMode &&
    deniedView.meta.indexOf('Cash 840') >= 0 && deniedView.meta.indexOf('Bank 100') >= 0 &&
    deniedView.meta.indexOf('Server Owner') >= 0 && deniedView.calls.some(c => c.indexOf('GET /api/me') === 0) &&
    deniedView.calls.every(c => c.indexOf('auth=false') >= 0 && c.indexOf('cred=include') >= 0),
    deniedView);
  await denied.page.click('#modeTraderBtn');
  await denied.page.waitForFunction(() => document.getElementById('toast').textContent.indexOf('not authorized') >= 0);
  const deniedAfter = await denied.page.evaluate(readBar);
  check('denied-click-does-not-search', !deniedAfter.traderMode && !deniedAfter.calls.some(c => c.indexOf('/api/trader/') >= 0), deniedAfter.calls);
  check('denied-console', denied.errors.length === 0, denied.errors.slice(0, 4));
  await denied.page.close();

  const desk = await boot(browser, { gateway: GATEWAY, me: ALLOWED, width: 375 });
  await desk.page.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Riley Chen'));
  const mine = await desk.page.evaluate(readBar);
  check('my-account-is-default',
    mine.who === 'Riley Chen' && mine.selfPressed === 'true' && !mine.traderMode && mine.traderDisabled === 'false' &&
    mine.fixture === 'Test fixture' && mine.meta.indexOf('Cash 80000') >= 0 && mine.meta.indexOf('Bank 0') >= 0 &&
    mine.meta.indexOf('Server Owner') >= 0 && mine.signOut && mine.scrollW <= mine.clientW + 1,
    mine);
  await shot(desk.page, 'account-my-375');

  await desk.page.click('#modeTraderBtn');
  await desk.page.waitForFunction(() => document.body.classList.contains('trader-mode') && document.getElementById('accountStatus').innerText.includes('Select a customer'));
  const picking = await desk.page.evaluate(readBar);
  check('trader-mode-uses-server-allowance',
    picking.traderMode && picking.status.indexOf('TRADER MODE') >= 0 && picking.who === 'Select a customer' &&
    picking.meta === '' && picking.searchOpen && /224,\s*122,\s*31/.test(picking.outline),
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
    !revoked.traderMode && revoked.traderDisabled === 'true' && revoked.who === 'Alex Rivera' &&
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
    refreshed.nav >= 1 && refreshed.rolesCols === 2,
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
