// A successful #order= import opens the cart sheet at the top.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'app', 'index.html');
const URL = 'file://' + FILE;
const OUT = process.env.OUT || path.join(__dirname, 'out', 'order-open');
const ART = '/opt/cursor/artifacts';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(ART, { recursive: true });

const fails = [];
function check(id, ok, detail) {
  if (!ok) fails.push({ id, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 700) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(browser, width, height) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FILE_NOT_FOUND/.test(m.text())) errors.push(m.text()); });
  await page.setViewport({ width, height: height || 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  return { page, errors };
}

async function settle(page) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(40);
}

function hashOf(linkOrPayload) {
  const s = String(linkOrPayload);
  const i = s.indexOf('#');
  return i >= 0 ? s.slice(i) : s;
}

async function openHash(page, hash) {
  await page.goto('about:blank');
  await page.goto(URL + hash, { waitUntil: 'load' });
  if (String(hash).startsWith('#order=')) {
    await page.waitForFunction(() => {
      const t = document.getElementById('toast');
      const text = t.textContent || '';
      return text === 'Order loaded' || text.indexOf('Order loaded') === 0 || text === 'Invalid code' || text === 'Paste a link or code first';
    }, { timeout: 5000 });
  }
  await settle(page);
}

function viewOf() {
  const body = document.getElementById('orderSheetBody');
  const cart = document.getElementById('buySummaryWrap');
  const roles = document.getElementById('rolesSection');
  const sheet = document.getElementById('orderSheet');
  const br = body.getBoundingClientRect();
  const cr = cart.getBoundingClientRect();
  const rr = roles ? roles.getBoundingClientRect() : { top: 9999 };
  const active = document.activeElement;
  return {
    open: document.body.classList.contains('code-open'),
    hash: location.hash,
    hrefHasHash: /#/.test(location.href),
    toast: document.getElementById('toast').textContent,
    scroll: body.scrollTop,
    cartTop: +(cr.top - br.top).toFixed(1),
    cartVisible: cr.top >= br.top - 2 && cr.top < br.bottom && cr.height > 20,
    rolesAtTop: rr.top < br.top + 30,
    header: document.querySelector('#buySummaryWrap .summary-header').textContent,
    names: [...document.querySelectorAll('#buySummary .summary-item .name')].map(n => n.textContent.replace(/\s+/g, ' ').trim()),
    kits: document.getElementById('kitSummaryBox') ? document.getElementById('kitSummaryBox').textContent.replace(/\s+/g, ' ').trim() : '',
    kitShown: (() => { const k = document.getElementById('kitSummaryBox'); return !!(k && getComputedStyle(k).display !== 'none'); })(),
    focusId: active && active.id,
    focusTag: active && active.tagName,
    tab: document.body.dataset.tab,
    cart: JSON.parse(JSON.stringify(buyCart)),
    kitCount: kitConfigs.length,
    navRows: document.querySelectorAll('#buyGrid .catstack > .catrow').length,
    rolesBtn: '',
    shareBtn: document.getElementById('shareOrderBtn').querySelector('.dock-act-label').textContent.trim(),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth
  };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none']
  });

  const { page, errors } = await boot(browser, 390, 844);
  await page.goto(URL, { waitUntil: 'load' });
  await settle(page);
  const built = await page.evaluate(() => {
    buyCart = {}; kitConfigs = [];
    addToCart('buy', 'M4A1', 2, 3500);
    addToCart('buy', 'Bandages', 2, 250);
    handleBuyItem({ name: 'Player Kit' });
    const w = document.querySelector('select[data-slot="weapon1"]');
    w.value = 'M4A1';
    w.dispatchEvent(new Event('change', { bubbles: true }));
    saveKit();
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    return { link: makeOrderShareLink(), base: url.toString() };
  });
  const link = built.link;
  const mixedHash = hashOf(link);
  check('built-link', mixedHash.startsWith('#order=') && link.startsWith(built.base + '#order=') && !link.includes('github.io'), link.slice(0, 120));

  await openHash(page, mixedHash);
  const opened = await page.evaluate(viewOf);
  check('fresh-mixed-opens-cart-top',
    opened.toast === 'Order loaded' && opened.open && opened.scroll === 0 && opened.cartVisible && opened.cartTop <= 16 && !opened.rolesAtTop &&
    opened.hash === '' && opened.hrefHasHash === false &&
    opened.cart.M4A1 && opened.cart.M4A1.qty === 2 && opened.cart.M4A1.base === 3500 &&
    opened.cart.Bandages && opened.cart.Bandages.qty === 2 && opened.cart.Bandages.base === 250 &&
    opened.cart['Player Kit 1'] && opened.cart['Player Kit 1'].base === 16000 && opened.kitCount === 1 &&
    /23,500/.test(opened.header) && /M4A1/.test(opened.kits) && opened.kitShown &&
    opened.focusId === 'orderSheet' && opened.focusTag !== 'INPUT' && opened.focusTag !== 'TEXTAREA' &&
    opened.tab === 'buy' && opened.navRows >= 1 && opened.shareBtn === 'Share order' &&
    opened.scrollW <= opened.clientW + 1,
    opened);
  await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  await page.screenshot({ path: path.join(OUT, 'cart-390.png') });
  fs.copyFileSync(path.join(OUT, 'cart-390.png'), path.join(ART, 'order-cart-390.png'));

  for (const width of [375, 430]) {
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await openHash(page, mixedHash);
    const view = await page.evaluate(viewOf);
    check(`cart-first@${width}`,
      view.open && view.scroll === 0 && view.cartVisible && view.cartTop <= 16 && !view.rolesAtTop &&
      view.cart.M4A1.qty === 2 && view.kitCount === 1 && /23,500/.test(view.header) &&
      view.focusTag !== 'INPUT' && view.scrollW <= view.clientW + 1,
      { scroll: view.scroll, cartTop: view.cartTop, header: view.header, focus: view.focusId, scrollW: view.scrollW });
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    const name = `order-cart-${width}.png`;
    await page.screenshot({ path: path.join(OUT, name) });
    fs.copyFileSync(path.join(OUT, name), path.join(ART, name));
  }

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const badHashes = {
    malformed: '#order=' + encodeURIComponent('%%%'),
    notJson: '#order=' + encodeURIComponent(btoa('hello')),
    unknown: '#order=' + encodeURIComponent(btoa(JSON.stringify({ 'Free Money': { qty: 1, base: 1, salePrice: null } }))),
    empty: '#order=',
    blank: '#order=' + encodeURIComponent(' '),
    nope: '#nope=abc'
  };
  const badViews = {};
  for (const [name, hash] of Object.entries(badHashes)) {
    await openHash(page, hash);
    badViews[name] = await page.evaluate(() => ({
      open: document.body.classList.contains('code-open'),
      keys: Object.keys(buyCart),
      kits: kitConfigs.length,
      toast: document.getElementById('toast').textContent,
      hash: location.hash
    }));
  }
  check('bad-links-fail-closed',
    Object.entries(badViews).every(([name, v]) => v.open === false && v.keys.length === 0 && v.kits === 0 && (name === 'nope' ? v.hash === '#nope=abc' : v.hash === '')),
    badViews);

  await page.goto('about:blank');
  await page.goto(URL, { waitUntil: 'load' });
  await settle(page);
  const plain = await page.evaluate(() => ({
    open: document.body.classList.contains('code-open'),
    keys: Object.keys(buyCart),
    cats: [...document.querySelectorAll('#buyGrid .cat-btn')].map(b => b.textContent.trim()).slice(0, 3),
    hash: location.hash
  }));
  check('plain-load-empty-browse', plain.open === false && plain.keys.length === 0 && plain.hash === '' && plain.cats.includes('Weapons'), plain);

  await openHash(page, mixedHash);
  await page.reload({ waitUntil: 'load' });
  await settle(page);
  const refreshed = await page.evaluate(() => ({
    open: document.body.classList.contains('code-open'),
    keys: Object.keys(buyCart),
    kits: kitConfigs.length,
    hash: location.hash,
    cats: document.querySelectorAll('#buyGrid .cat-btn').length
  }));
  check('refresh-after-link-is-empty', refreshed.open === false && refreshed.keys.length === 0 && refreshed.kits === 0 && refreshed.hash === '' && refreshed.cats > 0, refreshed);

  await page.goto(URL, { waitUntil: 'load' });
  await settle(page);
  const later = await page.evaluate(() => {
    addToCart('buy', 'M4A1', 4, 3500);
    document.body.classList.remove('code-open');
    const payload = encodeURIComponent(btoa(JSON.stringify({ v: 2, cart: { 'Trader Truck': { qty: 1, base: 1, salePrice: null } }, kits: [] })));
    history.pushState(null, '', location.href.split('#')[0] + '#order=' + payload);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return {
      qty: buyCart.M4A1 && buyCart.M4A1.qty,
      truck: buyCart['Trader Truck'] || null,
      open: document.body.classList.contains('code-open'),
      hash: location.hash
    };
  });
  check('later-hash-does-not-replace-or-open', later.qty === 4 && !later.truck && later.open === false && later.hash.startsWith('#order='), later);

  const v1 = '#order=' + encodeURIComponent(btoa(JSON.stringify({ M4A1: { qty: 3, base: 1, salePrice: null } })));
  await openHash(page, v1);
  const legacy1 = await page.evaluate(viewOf);
  check('legacy-v1-opens-repriced-cart',
    legacy1.toast.indexOf('Order loaded') === 0 && legacy1.open && legacy1.scroll === 0 && legacy1.cart.M4A1.qty === 3 && legacy1.cart.M4A1.base === 3500 && /10,500/.test(legacy1.header),
    { toast: legacy1.toast, open: legacy1.open, scroll: legacy1.scroll, cart: legacy1.cart.M4A1, header: legacy1.header });

  const v2 = '#order=' + encodeURIComponent(btoa(JSON.stringify({
    v: 2,
    cart: { 'Player Kit 1': { qty: 1, base: 1, salePrice: null } },
    kits: [{ name: 'Player Kit 1', token: false, weapon1: { item: 'KAM' } }]
  })));
  await openHash(page, v2);
  const legacy2 = await page.evaluate(viewOf);
  check('legacy-v2-opens-kit',
    legacy2.toast.indexOf('Order loaded') === 0 && legacy2.open && legacy2.scroll === 0 && legacy2.cart['Player Kit 1'].base === 16000 && legacy2.kitCount === 1 && /KAM/.test(legacy2.kits),
    { toast: legacy2.toast, base: legacy2.cart['Player Kit 1'], kits: legacy2.kits.slice(0, 180), scroll: legacy2.scroll });

  await page.goto(URL, { waitUntil: 'load' });
  await settle(page);
  const pasted = await page.evaluate(async (code) => {
    document.querySelector('.tab-btn[data-tab="sell"]').click();
    addToCart('sell', 'Cannabis', 2, 10);
    document.body.classList.remove('code-open');
    document.getElementById('orderCodeIn').focus();
    document.getElementById('orderCodeIn').value = code;
    document.getElementById('loadCodeBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const body = document.getElementById('orderSheetBody');
    const cart = document.getElementById('buySummaryWrap');
    return {
      open: document.body.classList.contains('code-open'),
      scroll: body.scrollTop,
      cartTop: +(cart.getBoundingClientRect().top - body.getBoundingClientRect().top).toFixed(1),
      tab: document.body.dataset.tab,
      qty: buyCart.M4A1 && buyCart.M4A1.qty,
      sell: sellCart.Cannabis && sellCart.Cannabis.qty,
      focusTag: document.activeElement && document.activeElement.tagName,
      toast: document.getElementById('toast').textContent
    };
  }, 'https://dayz-group-935.github.io/traderv3/' + v1);
  check('pasted-link-shows-cart-without-input-focus',
    pasted.toast.indexOf('Order loaded') === 0 && pasted.open && pasted.scroll === 0 && pasted.cartTop <= 16 &&
    pasted.tab === 'buy' && pasted.qty === 3 && pasted.sell === 2 && pasted.focusTag !== 'INPUT',
    pasted);

  const rejected = await page.evaluate(() => {
    document.getElementById('codeSheetClose').click();
    const before = JSON.stringify(buyCart);
    document.getElementById('orderCodeIn').value = 'https://dayz-group-935.github.io/traderv3/#order=' + encodeURIComponent(btoa('hello'));
    document.getElementById('loadCodeBtn').click();
    return {
      open: document.body.classList.contains('code-open'),
      same: JSON.stringify(buyCart) === before,
      toast: document.getElementById('toast').textContent
    };
  });
  check('bad-paste-does-not-open-or-mutate', rejected.open === false && rejected.same && rejected.toast === 'Invalid code', rejected);

  await page.evaluate(() => {
    buyCart = { M4A1: { qty: 4, base: 3500, salePrice: null } };
    document.body.classList.add('code-open');
    document.getElementById('orderSheetBody').scrollTop = 400;
  });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await settle(page);
  const restored = await page.evaluate(() => ({
    open: document.body.classList.contains('code-open'),
    keys: Object.keys(buyCart),
    hash: location.hash
  }));
  check('pageshow-without-hash-resets', restored.open === false && restored.keys.length === 0 && restored.hash === '', restored);

  const emptyShare = await page.evaluate(() => {
    document.getElementById('shareOrderBtn').click();
    document.getElementById('codeSheetBtn').click();
    const out = document.getElementById('orderCodeOut');
    return {
      toast: document.getElementById('toast').textContent,
      value: out.value,
      hidden: out.hidden,
      disabled: document.getElementById('genCodeBtn').disabled,
      copyGone: !document.getElementById('copyCodeBtn'),
      clearLabel: document.getElementById('clearAllBtn').textContent
    };
  });
  check('empty-cart-hides-share-link',
    emptyShare.toast === 'Cart is empty' && emptyShare.value === '' && emptyShare.hidden && emptyShare.disabled &&
    emptyShare.copyGone && emptyShare.clearLabel === 'Clear cart',
    emptyShare);

  check('order-console', errors.length === 0, errors.slice(0, 6));
  await page.close();
  await browser.close();
  const summary = { pass: fails.length === 0, fails };
  fs.writeFileSync(path.join(OUT, 'order-open.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(ART, 'order-open.json'), JSON.stringify(summary, null, 2));
  if (fails.length) {
    console.log('ORDER FAILS', fails.length);
    process.exit(1);
  }
  console.log('ORDER OK');
})().catch(err => { console.error(err); process.exit(1); });
