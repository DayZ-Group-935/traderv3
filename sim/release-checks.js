'use strict';

// Focused release checks. Mock membership only. No live provider calls and no catalog save.
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { buildConfig } = require('../lib/config');

const OUT = '/opt/cursor/artifacts';
fs.mkdirSync(OUT, { recursive: true });
const fails = [];
function check(id, ok, detail) {
  if (!ok) fails.push({ id, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''));
}

const STAFF = {
  identity: { id: '222222222222222222', username: 'riley', global_name: 'Riley Chen' },
  roles: { is_server_owner: true, is_high_level_staff: true, is_trader: false, discounts: { configured: false, applied: [], amounts_mapped: false, reason: 'discount_role_ids_unverified' } },
  access: { trader_mode_allowed: true, admin_mode_allowed: true, writes: false },
  balance: { available: true, mapped: true, cash: 80000, cash_str: '80000', bank: 0, bank_str: '0', write_access: false }
};
const TRADER = {
  identity: { id: '333333333333333333', username: 'trader', global_name: 'Trader' },
  roles: { is_trader: true, is_server_owner: false, is_high_level_staff: false, discounts: { configured: false, applied: [], amounts_mapped: false, reason: 'discount_role_ids_unverified' } },
  access: { trader_mode_allowed: true, admin_mode_allowed: false, writes: false },
  balance: { available: true, mapped: true, cash: 10, cash_str: '10', bank: 0, bank_str: '0', write_access: false }
};
const CUSTOMER_ID = '444444444444444444';

function installFetch(page, me, opts = {}) {
  return page.evaluateOnNewDocument((me, opts, customerId) => {
    window.__935AccountFixture = true;
    const orig = window.fetch.bind(window);
    let release;
    const gate = opts.delayMe ? new Promise((resolve) => { release = resolve; window.__935ReleaseMe = resolve; }) : null;
    window.fetch = async (url, init) => {
      const u = new URL(String(url), window.location.origin);
      if (u.origin !== window.location.origin) return orig(url, init);
      const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (u.pathname === '/api/me') {
        if (gate) await gate;
        return json(200, me);
      }
      if (u.pathname === '/api/catalog') return json(200, { configured: false, revision: 0, changes: [] });
      if (u.pathname === '/api/trader/search') {
        window.__935SearchCalls = (window.__935SearchCalls || 0) + 1;
        return json(503, { error: 'provider_unavailable', reason: 'member_search_unavailable', lookup_by_id: true });
      }
      if (u.pathname === '/api/trader/players/' + customerId) {
        window.__935IdCalls = (window.__935IdCalls || 0) + 1;
        return json(200, {
          lookup: { id: customerId, member: { id: customerId, username: 'ada', global_name: 'Ada' } },
          balance: { available: true, mapped: true, cash: 5, cash_str: '5', bank: 1, bank_str: '1', write_access: false }
        });
      }
      return orig(url, init);
    };
    if (release) window.__935ReleaseMe = release;
  }, me, opts, CUSTOMER_ID);
}

async function overlaps(page, selector) {
  return page.evaluate((selector) => {
    const bad = [];
    document.querySelectorAll(selector).forEach((row) => {
      const icon = row.querySelector('.ic');
      const name = row.querySelector('.nm');
      if (!icon || !name || name.getClientRects().length === 0) return;
      const a = icon.getBoundingClientRect();
      const b = name.getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const clipped = name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1;
      if (w > 0.5 && h > 0.5) bad.push({ name: name.textContent, overlap: true });
      else if (clipped) bad.push({ name: name.textContent, clipped: true, sw: name.scrollWidth, cw: name.clientWidth });
    });
    return bad.slice(0, 8);
  }, selector);
}

(async () => {
  const app = createApp({
    config: buildConfig({
      PORT: '0',
      SESSION_SECRET: 'test-session-secret-not-used-as-token',
      DISCORD_CLIENT_ID: 'mock-client-id',
      DISCORD_CLIENT_SECRET: 'mock-secret',
      DISCORD_REDIRECT_URI: 'http://127.0.0.1:9/auth/discord/callback',
      DISCORD_GUILD_ID: '1213578527522431046',
      DISCORD_TRADER_ROLE_ID: '1215060053191819324',
      DISCORD_SERVER_OWNER_ROLE_ID: '1215040829186383912',
      DISCORD_HIGH_LEVEL_STAFF_ROLE_ID: '1215042184764723251'
    }),
    logger: { info() {}, error() {}, request() {} }
  });
  const addr = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${addr.port}`;
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    await page.goto(origin + '/', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('accountStatus').textContent === 'Signed out');
    const signed = await page.evaluate(() => ({
      status: document.getElementById('accountStatus').textContent,
      injected: window.__935AccountGateway === window.location.origin,
      configuredPhrase: document.body.innerText.includes('Sign-in is not configured'),
      items: [...document.querySelectorAll('#buyGrid .item-btn .nm')].slice(0, 4).map(n => n.textContent),
      trader: document.getElementById('modeTraderBtn').hidden,
      admin: document.getElementById('modeAdminBtn').hidden
    }));
    check('hosted-gateway-says-signed-out', signed.status === 'Signed out' && signed.injected && !signed.configuredPhrase && signed.items.includes('Aug AX') && signed.trader && signed.admin, signed);
    async function signInBar() {
      return page.evaluate(() => {
        const bar = document.getElementById('accountBar');
        const btn = document.getElementById('accountSignIn');
        const svg = btn.querySelector('svg.discord-mark');
        const label = btn.querySelector('span');
        const modes = document.querySelector('.account-modes').getBoundingClientRect();
        const icon = svg.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        const btnBox = btn.getBoundingClientRect();
        return {
          label: label.textContent,
          name: btn.getAttribute('aria-label'),
          svgHidden: svg.getAttribute('aria-hidden'),
          iconH: Math.round(icon.height),
          centered: Math.abs(((icon.top + icon.bottom) / 2) - ((text.top + text.bottom) / 2)) <= 1.5,
          textClear: text.left >= icon.right - 0.5,
          noPageScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          modesInside: modes.right <= bar.getBoundingClientRect().right + 1 && modes.height <= 52,
          btnInside: btnBox.right <= document.documentElement.clientWidth + 1
        };
      });
    }
    const bar390 = await signInBar();
    check('signin-discord-mark-390', bar390.label === 'Sign in' && bar390.name === 'Sign in with Discord' && bar390.svgHidden === 'true' && bar390.iconH >= 16 && bar390.iconH <= 18 && bar390.centered && bar390.textClear && bar390.noPageScroll && bar390.modesInside && bar390.btnInside, bar390);
    await page.screenshot({ path: path.join(OUT, 'signed-out-390.png') });
    await page.screenshot({ path: path.join(OUT, 'badlands-weapons-390.png') });

    for (const width of [390, 320]) {
      await page.setViewport({ width, height: 844, deviceScaleFactor: 1, isMobile: true });
      const itemOverlap = await overlaps(page, '#buyGrid .item-btn');
      check('weapons-no-overlap-' + width, itemOverlap.length === 0, itemOverlap);
    }
    const bar320 = await signInBar();
    check('signin-discord-mark-320', bar320.label === 'Sign in' && bar320.iconH >= 16 && bar320.iconH <= 18 && bar320.centered && bar320.noPageScroll && bar320.modesInside && bar320.btnInside, bar320);
    await page.screenshot({ path: path.join(OUT, 'signed-out-320.png') });
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false });
    await page.waitForFunction(() => {
      const btn = document.getElementById('accountSignIn');
      const svg = btn && btn.querySelector('svg.discord-mark');
      return btn && !btn.hidden && svg && svg.getBoundingClientRect().height >= 16 && document.getElementById('accountStatus').textContent === 'Signed out';
    });
    const bar1280 = await signInBar();
    check('signin-discord-mark-1280', bar1280.noPageScroll && bar1280.modesInside && bar1280.btnInside && bar1280.iconH >= 16 && bar1280.iconH <= 18, bar1280);
    await page.screenshot({ path: path.join(OUT, 'badlands-weapons-1280.png') });

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#buyGrid .cat-btn')].find(b => (b.querySelector('.nm') || b).textContent.trim().startsWith('Optics'));
      if (btn) btn.click();
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#buyGrid .cat-btn')].some(b => b.textContent.includes('Short')));
    check('optics-no-overlap-390', (await overlaps(page, '#buyGrid .cat-btn, #buyGrid .item-btn')).length === 0);
    await page.screenshot({ path: path.join(OUT, 'badlands-optics-390.png') });

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#buyGrid .cat-btn')].find(b => (b.querySelector('.nm') || b).textContent.trim().startsWith('Player'));
      if (btn) btn.click();
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#buyGrid .nm')].some(n => n.textContent === 'Player Kit'));
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => (b.querySelector('.nm') || {}).textContent === 'Player Kit');
      if (btn) btn.click();
    });
    await page.waitForSelector('#kitTokenToggle');
    await page.click('#kitTokenToggle');
    await page.click('.kit-save');
    await page.waitForFunction(() => /TOKEN/.test(document.getElementById('buySummary').innerText));
    const token = await page.evaluate(() => ({
      text: document.getElementById('buySummary').innerText,
      total: document.querySelector('#totalChip .tc-value').textContent
    }));
    check('kit-token-price-is-zero', /TOKEN/.test(token.text) && /^0 Cr/.test(token.total.trim()), token);

    check('player-has-no-role-controls', await page.evaluate(() => !document.getElementById('rolesDockBtn') && !document.getElementById('rolesGrid') && !document.getElementById('clearRolesBtn')));
    const legacy = await page.evaluate(() => {
      applyPricingRoles(['Roadkill', 'All Your Base', 'Dr. Greenthumb']);
      const priced = {
        flagSell: lineUnit('Faction Flag', 2500, null),
        flagsBuy: lineUnit('Faction Flags', 500, null),
        battery: lineUnit('Car Battery', 200, null),
        car: lineUnit('Trader Car', 75000, null),
        truck: lineUnit('Trader Truck', 250000, null),
        bonus: lineUnit('Cannabis', 10, null)
      };
      applyPricingRoles([]);
      return priced;
    });
    check('legacy-flag-roadkill-bonus',
      legacy.flagSell === 2500 && legacy.flagsBuy === 0 && legacy.battery === 150 &&
      legacy.car === 75000 && legacy.truck === 250000 && legacy.bonus === 30,
      legacy);

    await page.evaluate(() => { document.body.classList.add('code-open'); });
    check('order-no-overlap-390', (await overlaps(page, '.summary-item')).length === 0);
    await page.screenshot({ path: path.join(OUT, 'badlands-order-390.png') });
    await page.setViewport({ width: 320, height: 844, deviceScaleFactor: 1, isMobile: true });
    check('order-no-overlap-320', (await overlaps(page, '.summary-item')).length === 0);
    check('plain-console', errors.length === 0, errors.slice(0, 4));

    const staff = await browser.newPage();
    await installFetch(staff, STAFF);
    await staff.setViewport({ width: 390, height: 1500, deviceScaleFactor: 2, isMobile: true });
    await staff.goto(origin + '/', { waitUntil: 'networkidle0' });
    await staff.waitForFunction(() => !document.getElementById('modeAdminBtn').hidden && !document.getElementById('modeTraderBtn').hidden && document.getElementById('accountStatus').innerText.includes('ADMIN MODE') === false);
    const both = await staff.evaluate(() => ({
      trader: !document.getElementById('modeTraderBtn').hidden,
      admin: !document.getElementById('modeAdminBtn').hidden,
      mode: document.body.classList.contains('mode-self'),
      status: document.getElementById('accountStatus').innerText
    }));
    check('owner-or-staff-sees-both-modes', both.trader && both.admin && both.mode && /Riley Chen/.test(both.status), both);
    await staff.click('#modeAdminBtn');
    await staff.waitForFunction(() => document.body.classList.contains('mode-admin') && document.getElementById('accountStatus').innerText.includes('ADMIN MODE'));
    await staff.evaluate(() => {
      document.getElementById('manageSearch').value = 'M4A1';
      document.getElementById('manageSearch').dispatchEvent(new Event('input'));
    });
    await staff.waitForFunction(() => document.querySelectorAll('.manage-row').length === 1);
    await staff.click('.manage-row');
    await staff.waitForFunction(() => document.getElementById('manageItemName').textContent === 'M4A1' && document.getElementById('manageResult').textContent.includes('3,500'));
    const editor = await staff.evaluate(() => ({
      price: document.getElementById('managePrice').value,
      discount: document.getElementById('manageDiscount').value,
      result: document.getElementById('manageResult').textContent,
      top: document.getElementById('accountStatus').getBoundingClientRect().top,
      header: document.querySelector('h1').getBoundingClientRect().top
    }));
    check('admin-editor-defaults', editor.price === '3500' && editor.discount === '0' && editor.result === '3,500 Cr' && editor.header >= 0, editor);
    const fit = await staff.evaluate(() => {
      const editor = document.getElementById('manageEditor');
      const save = document.getElementById('manageSave');
      const cancel = document.getElementById('manageCancel');
      const er = editor.getBoundingClientRect();
      const sr = save.getBoundingClientRect();
      const cr = cancel.getBoundingClientRect();
      return {
        saveInside: sr.right <= er.right + 1 && sr.left >= er.left - 1,
        cancelInside: cr.left >= er.left - 1,
        scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        mode: document.getElementById('accountStatus').innerText.includes('ADMIN MODE')
      };
    });
    check('admin-editor-fits-390', fit.saveInside && fit.cancelInside && fit.scroll && fit.mode, fit);
    check('admin-list-no-overlap-390', (await overlaps(staff, '.manage-row')).length === 0);
    const accordion = await staff.evaluate(() => {
      const click = () => [...document.querySelectorAll('.manage-row')].find(row => (row.querySelector('.nm') || {}).textContent === 'M4A1').click();
      const before = document.getElementById('manageEditor').hidden === false;
      const inline = document.getElementById('manageEditor').previousElementSibling.classList.contains('manage-row');
      click();
      const shut = document.getElementById('manageEditor').hidden === true;
      click();
      const open = document.getElementById('manageEditor').hidden === false;
      return { before, inline, shut, open };
    });
    check('admin-accordion-toggles', accordion.before && accordion.inline && accordion.shut && accordion.open, accordion);
    await staff.evaluate(() => {
      const search = document.getElementById('manageSearch');
      search.value = '';
      search.dispatchEvent(new Event('input'));
      const rows = [...document.querySelectorAll('.manage-row')];
      const row = rows[Math.floor(rows.length / 2)];
      if (row && row.getAttribute('aria-expanded') !== 'true') row.click();
      const editor = document.getElementById('manageEditor');
      editor.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -80);
    });
    await staff.screenshot({ path: path.join(OUT, 'badlands-admin-accordion-390.png') });
    await staff.setViewport({ width: 320, height: 1100, deviceScaleFactor: 2, isMobile: true });
    await staff.evaluate(() => {
      const editor = document.getElementById('manageEditor');
      editor.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -64);
    });
    await staff.screenshot({ path: path.join(OUT, 'badlands-admin-accordion-320.png') });
    await staff.setViewport({ width: 390, height: 1500, deviceScaleFactor: 2, isMobile: true });
    await staff.click('#adminRolesTab');
    await staff.waitForFunction(() => !document.getElementById('adminRoles').hidden && document.getElementById('adminRoleSelect').options.length > 10);
    const prefill = await staff.evaluate(() => {
      document.getElementById('adminRoleSelect').value = 'Roadkill';
      document.getElementById('adminRoleSelect').dispatchEvent(new Event('change'));
      const box = document.getElementById('adminRoleEffects');
      const battery = [...box.querySelectorAll('.role-edit')].find(row => row.textContent.includes('Car Battery'));
      const value = battery && battery.querySelector('input');
      document.getElementById('adminRoleSelect').value = 'Big Game Hunter';
      document.getElementById('adminRoleSelect').dispatchEvent(new Event('change'));
      const pelt = [...document.querySelectorAll('.role-edit')].find(row => row.textContent.includes('Bear Pelt'));
      return {
        battery: value && value.value,
        editable: !!battery && battery.querySelectorAll('button').length >= 4,
        add: !!document.getElementById('roleAddSearch'),
        pelt: pelt ? pelt.textContent : '',
        saveDisabled: document.getElementById('adminRoleSave').disabled,
        notes: document.querySelectorAll('#adminRoles .manage-note, #manageNote:not([hidden])').length,
        noRolesButton: !document.getElementById('rolesDockBtn')
      };
    });
    check('admin-roles-prefill-roadkill', prefill.battery === '25' && prefill.editable && prefill.add && /not in catalog/.test(prefill.pelt) && prefill.saveDisabled && prefill.notes === 1 && prefill.noRolesButton, prefill);
    const discordRef = await staff.evaluate(() => {
      const select = document.getElementById('adminRoleSelect');
      const read = (name) => {
        select.value = name;
        select.dispatchEvent(new Event('change'));
        return {
          tag: (document.querySelector('.role-source') || {}).textContent || '',
          discord: (document.querySelector('.role-ref') || {}).textContent || '',
          caution: (document.querySelector('.role-caution') || {}).textContent || '',
          battery: (document.querySelector('.role-edit input') || {}).value || ''
        };
      };
      const road = read('Roadkill');
      const quiet = read('Big Game Hunter');
      const missing = read('Julius Caesar');
      const paddle = read('Without A Paddle');
      select.value = 'Roadkill';
      select.dispatchEvent(new Event('change'));
      return { road, quiet, missing, paddle };
    });
    check('admin-roles-discord-reference',
      discordRef.road.discord === 'Discord: 5% off' &&
      discordRef.road.caution.includes('25%') && discordRef.road.caution.includes('5% off') &&
      discordRef.road.battery === '25' &&
      discordRef.quiet.discord === 'Discord: ongoing bonuses, no % listed' &&
      discordRef.quiet.caution === '' &&
      discordRef.missing.tag === 'no Discord role' &&
      discordRef.paddle.tag === 'no Discord role',
      discordRef);
    const precedence = await staff.evaluate(() => {
      applyPricingRoles(['Click Click Boom']);
      const grenade = Math.round(getDiscountedPrice('Grenade', 1000, 'buy'));
      const rifle = Math.round(getDiscountedPrice('M4A1', 3500, 'buy'));
      const tag = document.querySelector('.role-source') && document.querySelector('.role-source').textContent;
      applyPricingRoles(['Kamikaze', 'Click Click Boom']);
      const both = Math.round(getDiscountedPrice('Grenade', 1000, 'buy'));
      applyPricingRoles(['Deadshot', 'Hotshot']);
      const tundra = Math.round(getDiscountedPrice('Tundra', 2500, 'buy'));
      applyPricingRoles(['Day One']);
      const cart = roles['Day One'].cartPercent;
      applyPricingRoles([]);
      return { grenade, rifle, both, tundra, cart, tag };
    });
    check('role-precedence-calculator-master', precedence.grenade === 800 && precedence.rifle === 3500 && precedence.both === 750 && precedence.tundra === 1250 && precedence.cart === 10 && precedence.tag === 'calculator term', precedence);
    await staff.evaluate(() => {
      document.getElementById('adminRoleSelect').value = 'Roadkill';
      document.getElementById('adminRoleSelect').dispatchEvent(new Event('change'));
    });
    await staff.screenshot({ path: path.join(OUT, 'badlands-admin-roles-390.png'), fullPage: true });
    await staff.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false });
    await staff.evaluate(() => { if (!document.body.classList.contains('mode-admin')) document.getElementById('modeAdminBtn').click(); });
    await staff.waitForFunction(() => document.body.classList.contains('mode-admin'));
    await staff.evaluate(() => document.getElementById('adminRolesTab').click());
    await staff.screenshot({ path: path.join(OUT, 'badlands-admin-1280.png') });
    await staff.setViewport({ width: 320, height: 900, deviceScaleFactor: 2, isMobile: true });
    await staff.evaluate(() => {
      const admin = document.getElementById('modeAdminBtn');
      if (!document.body.classList.contains('mode-admin') && admin && !admin.hidden) admin.click();
      const tab = document.getElementById('adminRolesTab');
      if (tab) tab.click();
      const select = document.getElementById('adminRoleSelect');
      if (select && [...select.options].some((opt) => opt.value === 'Roadkill')) {
        select.value = 'Roadkill';
        select.dispatchEvent(new Event('change'));
      }
    });
    await staff.screenshot({ path: path.join(OUT, 'badlands-admin-roles-320.png'), fullPage: true });
    await staff.setViewport({ width: 320, height: 1600, deviceScaleFactor: 1, isMobile: true });
    await staff.evaluate(() => { if (!document.body.classList.contains('mode-admin')) document.getElementById('modeAdminBtn').click(); });
    const fit320 = await staff.evaluate(() => {
      document.getElementById('adminCatalogTab').click();
      const search = document.getElementById('manageSearch');
      search.value = 'M4A1';
      search.dispatchEvent(new Event('input'));
      const names = [...document.querySelectorAll('.manage-row .nm')].map(n => n.textContent);
      const row = [...document.querySelectorAll('.manage-row')].find(btn => (btn.querySelector('.nm') || {}).textContent === 'M4A1');
      if (row && document.getElementById('manageEditor').hidden) row.click();
      const editor = document.getElementById('manageEditor');
      editor.scrollIntoView({ block: 'nearest' });
      const save = document.getElementById('manageSave');
      const er = editor.getBoundingClientRect();
      const sr = save.getBoundingClientRect();
      return {
        saveInside: !editor.hidden && sr.right <= er.right + 1 && sr.left >= er.left - 1 && sr.width > 40,
        scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        er: [Math.round(er.left), Math.round(er.right)],
        sr: [Math.round(sr.left), Math.round(sr.right), Math.round(sr.width)],
        hidden: editor.hidden,
        names
      };
    });
    check('admin-editor-fits-320', fit320.saveInside && fit320.scroll, fit320);
    check('admin-list-no-overlap-320', (await overlaps(staff, '.manage-row')).length === 0);
    await staff.screenshot({ path: path.join(OUT, 'badlands-admin-320.png'), fullPage: false });
    await staff.evaluate(() => document.getElementById('manageEditor').scrollIntoView({ block: 'nearest' }));
    await staff.screenshot({ path: path.join(OUT, 'badlands-admin-editor-320.png') });

    const trader = await browser.newPage();
    await installFetch(trader, TRADER, { delayMe: true });
    await trader.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true });
    await trader.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await trader.waitForFunction(() => document.getElementById('accountStatus').textContent === 'Checking account');
    const early = await trader.evaluate(() => ({
      trader: document.getElementById('modeTraderBtn').hidden,
      admin: document.getElementById('modeAdminBtn').hidden,
      traderW: document.getElementById('modeTraderBtn').getBoundingClientRect().width
    }));
    check('loading-shows-no-privileged-controls', early.trader && early.admin && early.traderW === 0, early);
    await trader.evaluate(() => window.__935ReleaseMe());
    await trader.waitForFunction(() => !document.getElementById('modeTraderBtn').hidden && document.getElementById('modeAdminBtn').hidden);
    await trader.click('#modeTraderBtn');
    await trader.waitForFunction(() => document.body.classList.contains('mode-trader'));
    await trader.type('#customerSearch', 'ada');
    await trader.waitForFunction(() => document.getElementById('customerSearchNote').textContent.includes('not available'));
    const still = await trader.evaluate(() => ({
      trader: document.body.classList.contains('mode-trader'),
      searches: window.__935SearchCalls || 0,
      note: document.getElementById('customerIdRow').hidden
    }));
    check('failed-name-search-keeps-trader-open', still.trader && still.searches >= 1 && still.note === false, still);
    await trader.type('#customerIdInput', CUSTOMER_ID);
    await trader.click('#customerIdBtn');
    await trader.waitForFunction(() => document.getElementById('accountStatus').innerText.includes('Ada'));
    const looked = await trader.evaluate(() => ({
      who: document.getElementById('accountStatus').innerText,
      meta: document.getElementById('accountMeta').textContent,
      calls: window.__935IdCalls || 0,
      trader: document.body.classList.contains('mode-trader')
    }));
    check('id-lookup-selects-customer', looked.trader && looked.calls === 1 && /Ada/.test(looked.who) && /Cash 5/.test(looked.meta), looked);
    await trader.screenshot({ path: path.join(OUT, 'badlands-trader-390.png') });
    await trader.setViewport({ width: 320, height: 844, deviceScaleFactor: 1, isMobile: true });
    const traderScroll = await trader.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    check('trader-no-x-scroll-320', traderScroll);
    await trader.screenshot({ path: path.join(OUT, 'badlands-trader-320.png') });
    await trader.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    await trader.click('#modeSelfBtn');
    await trader.waitForFunction(() => document.body.classList.contains('mode-self') && !document.body.classList.contains('mode-trader'));
    await trader.screenshot({ path: path.join(OUT, 'badlands-my-account-390.png') });
    await trader.setViewport({ width: 320, height: 844, deviceScaleFactor: 1, isMobile: true });
    await trader.screenshot({ path: path.join(OUT, 'badlands-my-account-320.png') });
  } finally {
    await browser.close();
    await app.close();
  }
  if (fails.length) {
    console.log('RELEASE CHECKS FAILED ' + fails.length);
    process.exitCode = 1;
  } else {
    console.log('RELEASE CHECKS OK');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
