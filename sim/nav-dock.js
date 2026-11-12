// Targeted checks for stacked category rows and the dock Roles / Share order actions.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = 'file://' + FILE;
const OUT = process.env.OUT || path.join(__dirname, 'out', 'nav-dock');
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
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await sleep(40);
  return { page, errors };
}

async function shot(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  fs.copyFileSync(file, path.join(ART, name + '.png'));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none']
  });

  const { page, errors } = await boot(browser, 390, 844);

  const root = await page.evaluate(() => {
    const weapons = [...document.querySelectorAll('#buyGrid .cat-btn')].find(b => b.textContent.trim() === 'Weapons');
    const cats = [...document.querySelectorAll('#buyGrid .cat-btn')];
    return {
      text: weapons && weapons.textContent.trim(),
      icon: !!(weapons && weapons.querySelector('.ic, svg')),
      rows: document.querySelectorAll('#buyGrid .catstack > .catrow').length,
      iconCats: cats.filter(b => b.querySelector('.ic, svg')).map(b => b.textContent.trim()),
      labels: cats.map(b => b.textContent.trim())
    };
  });
  check('weapons-is-text', root.text === 'Weapons' && root.icon === false && root.rows === 1 && root.iconCats.length === 0, root);

  const drilled = await page.evaluate(async () => {
    const clickLast = (name) => {
      const all = [...document.querySelectorAll('#buyGrid .cat-btn')].filter(b => b.textContent.trim() === name);
      if (!all.length) return false;
      all[all.length - 1].click();
      return true;
    };
    const cartBefore = JSON.stringify(buyCart);
    if (!clickLast('Weapons') || !clickLast('Optics') || !clickLast('Short Range')) return { ok: false };
    const rows = [...document.querySelectorAll('#buyGrid .catstack > .catrow')].map(nav => ({
      level: nav.dataset.level,
      on: [...nav.querySelectorAll('.cat-btn.is-on')].map(b => b.textContent.trim()),
      pressed: [...nav.querySelectorAll('.cat-btn[aria-pressed="true"]')].map(b => b.textContent.trim())
    }));
    const item = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => (b.querySelector('.nm') || b).textContent.replace(/\*/g, '').trim() === 'BUIS Optic' || (b.querySelector('.nm') || {}).textContent);
    const names = [...document.querySelectorAll('#buyGrid .item-btn .nm')].map(n => n.textContent.trim());
    const wide = document.querySelectorAll('#buyGrid .item-btn .ic').length;
    return { path: buyPath.slice(), rows, names, wide, cartSame: JSON.stringify(buyCart) === cartBefore };
  });
  check('stacked-ancestor-rows',
    drilled.path.join(' / ') === 'Weapons / Optics / Short Range' &&
    drilled.rows.length === 3 &&
    drilled.rows[0].on.join() === 'Weapons' && drilled.rows[0].pressed.join() === 'Weapons' &&
    drilled.rows[1].on.join() === 'Optics' &&
    drilled.rows[2].on.join() === 'Short Range' &&
    drilled.names.length > 0 && drilled.wide > 0 && drilled.cartSame,
    drilled);

  await shot(page, 'nav-390-optics');

  const parentSwitch = await page.evaluate(() => {
    const before = JSON.stringify(buyCart);
    const clothing = [...document.querySelectorAll('#buyGrid .catrow[data-level="0"] .cat-btn')].find(b => b.textContent.trim() === 'Clothing');
    clothing.click();
    const child = [...document.querySelectorAll('#buyGrid .catrow[data-level="1"] .cat-btn')].map(b => b.textContent.trim());
    const stale = [...document.querySelectorAll('#buyGrid .cat-btn')].some(b => b.textContent.trim() === 'Short Range' || b.textContent.trim() === 'Optics');
    return {
      path: buyPath.slice(),
      on: [...document.querySelectorAll('#buyGrid .cat-btn.is-on')].map(b => b.textContent.trim()),
      levels: [...document.querySelectorAll('#buyGrid .catstack > .catrow')].map(n => n.dataset.level),
      child, stale, cartSame: JSON.stringify(buyCart) === before
    };
  });
  check('parent-switch-drops-stale-path',
    parentSwitch.path.join(' / ') === 'Clothing' &&
    parentSwitch.on.join() === 'Clothing' &&
    parentSwitch.levels.join() === '0,1' &&
    parentSwitch.child.includes('Headgear') && parentSwitch.child.includes('Ghillie') &&
    !parentSwitch.stale && parentSwitch.cartSame,
    parentSwitch);

  const cartNav = await page.evaluate(() => {
    buyPath = ['Weapons', 'Weapons']; render();
    const m4 = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => (b.querySelector('.nm') || b).textContent.replace(/\*/g, '').trim() === 'M4A1');
    if (!m4) return { missing: true };
    m4.click();
    const qty = buyCart.M4A1 && buyCart.M4A1.qty;
    const clothing = [...document.querySelectorAll('#buyGrid .catrow[data-level="0"] .cat-btn')].find(b => b.textContent.trim() === 'Clothing');
    clothing.click();
    const head = [...document.querySelectorAll('#buyGrid .cat-btn')].filter(b => b.textContent.trim() === 'Headgear').pop();
    head.click();
    document.querySelector('.tab-btn[data-tab="sell"]').click();
    document.querySelector('.tab-btn[data-tab="buy"]').click();
    return { qty, after: buyCart.M4A1 && buyCart.M4A1.qty, base: buyCart.M4A1 && buyCart.M4A1.base, path: buyPath.slice() };
  });
  check('cart-survives-nav-and-tab', cartNav.qty === 1 && cartNav.after === 1 && cartNav.base === 3500 && cartNav.path.join(' / ') === 'Clothing / Headgear', cartNav);

  const kit = await page.evaluate(() => {
    buyPath = []; render();
    const cat = [...document.querySelectorAll('#buyGrid .cat-btn')].filter(b => b.textContent.trim() === 'Player Kit').pop();
    cat.click();
    const rows = document.querySelectorAll('#buyGrid .catstack > .catrow').length;
    const on = [...document.querySelectorAll('#buyGrid .cat-btn.is-on')].map(b => b.textContent.trim());
    const items = [...document.querySelectorAll('#buyGrid .item-btn .nm')].map(n => n.textContent.trim());
    const before = Object.keys(buyCart).slice();
    const item = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => (b.querySelector('.nm') || b).textContent.trim() === 'Player Kit');
    item.click();
    const open = document.getElementById('kitPanel').style.display === 'flex';
    closeKitPanel();
    const closed = document.getElementById('kitPanel').style.display === 'none';
    return { rows, on, items, open, closed, before, after: Object.keys(buyCart), path: buyPath.slice() };
  });
  check('kits-use-same-rows', kit.rows === 1 && kit.on.join() === 'Player Kit' && kit.items.includes('Player Kit') && kit.items.includes('Ghillie Kit') && kit.path.join() === 'Player Kit', kit);
  check('kit-open-cancel-keeps-cart', kit.open && kit.closed && kit.after.join() === kit.before.join() && !kit.after.some(n => n === 'Player Kit'), kit);

  const back = await page.evaluate(() => {
    buyPath = ['Weapons', 'Optics', 'Short Range']; render();
    document.querySelector('#buyGrid .back-btn').click();
    const mid = buyPath.slice();
    const shortOn = [...document.querySelectorAll('#buyGrid .cat-btn.is-on')].map(b => b.textContent.trim());
    document.querySelector('#buyGrid .back-btn').click();
    const one = buyPath.slice();
    return { mid, shortOn, one, rows: document.querySelectorAll('#buyGrid .catstack > .catrow').length };
  });
  check('back-pops-one-level', back.mid.join(' / ') === 'Weapons / Optics' && !back.shortOn.includes('Short Range') && back.one.join() === 'Weapons' && back.rows === 2, back);

  const ied = await page.evaluate(() => {
    buyPath = []; render();
    [...document.querySelectorAll('#buyGrid .cat-btn')].find(b => b.textContent.trim() === 'Explosives').click();
    const iedBtn = [...document.querySelectorAll('#buyGrid .cat-btn')].find(b => b.textContent.trim() === 'IED');
    iedBtn.click();
    return { path: buyPath.slice(), toast: document.getElementById('toast').textContent, struck: getComputedStyle(iedBtn).textDecorationLine.includes('line-through') || iedBtn.style.textDecoration.includes('line-through') };
  });
  check('ied-stays-out-of-stock', ied.path.join() === 'Explosives' && ied.toast === 'OUT OF STOCK' && ied.struck, ied);

  const sell = await page.evaluate(() => {
    document.querySelector('.tab-btn[data-tab="sell"]').click();
    const rootLabels = [...document.querySelectorAll('#sellGrid .cat-btn')].map(b => b.textContent.trim());
    const rootRows = document.querySelectorAll('#sellGrid .catstack > .catrow').length;
    [...document.querySelectorAll('#sellGrid .cat-btn')].find(b => b.textContent.trim() === 'General').click();
    return {
      keys: Object.keys(sellitems),
      rootLabels, rootRows,
      path: sellPath.slice(),
      rows: document.querySelectorAll('#sellGrid .catstack > .catrow').length,
      on: [...document.querySelectorAll('#sellGrid .cat-btn.is-on')].map(b => b.textContent.trim()),
      items: document.querySelectorAll('#sellGrid .row').length
    };
  });
  check('sell-real-categories', sell.keys.join('|') === sell.rootLabels.join('|') && sell.rootRows === 1 && sell.rows === 1 && sell.on.join() === 'General' && sell.path.join() === 'General' && sell.items > 0, sell);

  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const dock375 = await page.evaluate(() => {
    document.querySelector('.tab-btn[data-tab="buy"]').click();
    buyPath = ['Weapons', 'Optics', 'Short Range']; render();
    const box = el => {
      const r = el.getBoundingClientRect();
      return { t: el.id || el.className, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) };
    };
    const roles = document.getElementById('rolesDockBtn');
    const share = document.getElementById('shareOrderBtn');
    const calc = document.getElementById('calculateBtn');
    const open = document.getElementById('codeSheetBtn');
    const note = share.querySelector('.note');
    const overlap = (a, b) => {
      const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
      return !(A.right <= B.left + 0.5 || A.left >= B.right - 0.5 || A.bottom <= B.top + 0.5 || A.top >= B.bottom - 0.5);
    };
    const cs = getComputedStyle(share);
    const cc = getComputedStyle(calc);
    return {
      roles: box(roles), share: box(share), calc: box(calc), open: box(open),
      label: share.querySelector('.dock-act-label').textContent.trim(),
      rolesText: roles.childNodes[0].textContent.trim(),
      noteDisplay: getComputedStyle(note).display,
      shareBg: cs.backgroundColor, calcBg: cc.backgroundColor,
      overlaps: {
        rolesShare: overlap(roles, share),
        shareCalc: overlap(share, calc),
        rolesCalc: overlap(roles, calc),
        openCalc: overlap(open, calc)
      },
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      dockRight: document.querySelector('.dock').getBoundingClientRect().right
    };
  });
  const fit = (b) => b.w >= 44 && b.h >= 43.5 && b.x >= -0.5 && b.r <= 375.5;
  await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  check('dock-375-labels-and-targets',
    dock375.rolesText === 'Roles' && dock375.label === 'Share order' && dock375.noteDisplay === 'none' &&
    fit(dock375.roles) && fit(dock375.share) && fit(dock375.calc) && dock375.open.h >= 43.5 &&
    !dock375.overlaps.rolesShare && !dock375.overlaps.shareCalc && !dock375.overlaps.rolesCalc && !dock375.overlaps.openCalc &&
    dock375.scrollW <= dock375.clientW + 1 && dock375.dockRight <= 375.5 &&
    dock375.shareBg !== dock375.calcBg,
    dock375);
  await shot(page, 'nav-375-optics');

  await page.setViewport({ width: 430, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.evaluate(() => { buyPath = ['Weapons', 'Optics', 'Short Range']; currentTab = 'buy'; render(); });
  await shot(page, 'nav-430-optics');

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const rolesOpen = await page.evaluate(async () => {
    document.querySelector('.tab-btn[data-tab="buy"]').click();
    activeRoles.clear(); render();
    document.getElementById('rolesDockBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const body = document.getElementById('orderSheetBody');
    const block = document.getElementById('rolesSection');
    const grid = document.getElementById('rolesGrid');
    const br = body.getBoundingClientRect();
    const rr = block.getBoundingClientRect();
    const gr = grid.getBoundingClientRect();
    const cols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
    const focused = document.activeElement && document.activeElement.id;
    const btns = [...grid.querySelectorAll('.role-btn')];
    btns[0].click();
    btns[1].click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const count = document.getElementById('roleCount');
    const selected = [...document.querySelectorAll('#rolesGrid .role-btn.active')].map(b => b.textContent.trim());
    const widths = [...document.querySelectorAll('#rolesGrid .role-btn')].map(b => +b.getBoundingClientRect().width.toFixed(1));
    return {
      open: document.body.classList.contains('code-open'),
      focused,
      sectionDelta: +(rr.top - br.top).toFixed(1),
      gridVisible: gr.top >= br.top - 1 && gr.top < br.bottom,
      cols,
      count: count.textContent,
      countHidden: count.hidden,
      aria: document.getElementById('rolesDockBtn').getAttribute('aria-label'),
      selected,
      widthSpan: widths.length ? +(Math.max(...widths) - Math.min(...widths)).toFixed(2) : null,
      small: [...document.querySelectorAll('#rolesGrid .role-btn')].filter(b => b.getBoundingClientRect().height < 43.5 || b.getBoundingClientRect().width < 43.5).length
    };
  });
  await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  check('roles-opens-grid',
    rolesOpen.open && rolesOpen.cols === 2 && rolesOpen.sectionDelta >= -2 && rolesOpen.sectionDelta <= 12 &&
    rolesOpen.gridVisible && rolesOpen.widthSpan <= 1.5 && rolesOpen.small === 0 &&
    rolesOpen.selected.length === 2 && rolesOpen.count === '2' && rolesOpen.countHidden === false &&
    /2 selected/.test(rolesOpen.aria),
    rolesOpen);
  await shot(page, 'roles-390-dock');

  const shareEmpty = await page.evaluate(() => {
    document.getElementById('codeSheetClose').click();
    buyCart = {}; sellCart = {}; kitConfigs = [];
    const out = document.getElementById('orderCodeOut');
    out.value = 'stale';
    render();
    document.getElementById('shareOrderBtn').click();
    document.getElementById('codeSheetBtn').click();
    return {
      toast: document.getElementById('toast').textContent,
      open: document.body.classList.contains('code-open'),
      value: out.value,
      hidden: out.hidden,
      disabled: document.getElementById('genCodeBtn').disabled,
      duplicateCopy: !!document.getElementById('copyCodeBtn'),
      clearLink: !!document.getElementById('clearCodeBtn'),
      clearLabel: document.getElementById('clearAllBtn').textContent
    };
  });
  check('share-empty-cart',
    shareEmpty.toast === 'Cart is empty' && shareEmpty.value === '' && shareEmpty.hidden && shareEmpty.disabled &&
    !shareEmpty.duplicateCopy && !shareEmpty.clearLink && shareEmpty.clearLabel === 'Clear cart',
    shareEmpty);
  await page.evaluate(() => document.getElementById('codeSheetClose').click());

  const shareBuy = await page.evaluate(async () => {
    let copied = null;
    let rejected = 0;
    navigator.clipboard.writeText = (t) => { copied = t; return Promise.reject(new Error('denied')); };
    addToCart('buy', 'Bandages', 2, 250);
    const beforeSell = JSON.stringify(sellCart);
    document.getElementById('shareOrderBtn').click();
    const immediate = document.getElementById('toast').textContent;
    const link = document.getElementById('orderCodeOut').value;
    await new Promise(r => setTimeout(r, 30));
    const after = document.getElementById('toast').textContent;
    if (after.indexOf('Copy failed') >= 0) rejected = 1;
    const body = document.getElementById('orderSheetBody');
    const box = document.getElementById('orderCodeBox');
    const shown = box.getBoundingClientRect().top - body.getBoundingClientRect().top;
    const payload = link.split('#order=')[1];
    let decoded = null;
    try { decoded = JSON.parse(atob(decodeURIComponent(payload))); } catch (e) { decoded = String(e); }
    return {
      immediate, after, link, copied, rejected,
      open: document.body.classList.contains('code-open'),
      shown: +shown.toFixed(1),
      display: document.getElementById('orderCodeOut').style.display,
      sellSame: JSON.stringify(sellCart) === beforeSell,
      decoded
    };
  });
  const shareBase = await page.evaluate(() => {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    return url.toString();
  });
  check('share-buy-existing-link',
    shareBuy.link.startsWith(shareBase + '#order=') && !shareBuy.link.includes('github.io') &&
    shareBuy.copied === shareBuy.link &&
    shareBuy.rejected === 1 && /Copy failed/.test(shareBuy.after) &&
    shareBuy.open && shareBuy.display === 'block' && shareBuy.shown <= 12 &&
    shareBuy.sellSame && shareBuy.decoded && shareBuy.decoded.v === 2 && shareBuy.decoded.cart.Bandages.qty === 2,
    { immediate: shareBuy.immediate, after: shareBuy.after, link: shareBuy.link.slice(0, 80), shown: shareBuy.shown, decoded: shareBuy.decoded });
  await shot(page, 'share-390-dock');

  const shareCopied = await page.evaluate(async () => {
    let copied = null;
    navigator.clipboard.writeText = (t) => { copied = t; return Promise.resolve(); };
    document.getElementById('shareOrderBtn').click();
    await new Promise(r => setTimeout(r, 30));
    const base = new URL(location.href);
    base.hash = '';
    base.search = '';
    return {
      toast: document.getElementById('toast').textContent,
      label: document.getElementById('genCodeBtn').textContent,
      copied: copied && copied.startsWith(base.toString() + '#order=')
    };
  });
  check('share-copy-success-toast', shareCopied.toast === 'Copied' && shareCopied.label === 'Copied' && shareCopied.copied, shareCopied);

  const sellShare = await page.evaluate(async () => {
    const out = document.getElementById('orderCodeOut');
    const sentinel = 'SENTINEL-NOT-A-LINK';
    out.value = sentinel;
    let writes = 0;
    navigator.clipboard.writeText = () => { writes++; return Promise.resolve(); };
    addToCart('sell', 'Cannabis', 3, 10);
    const buyBefore = JSON.stringify(buyCart);
    document.querySelector('.tab-btn[data-tab="sell"]').click();
    const share = document.getElementById('shareOrderBtn');
    const note = share.querySelector('.note');
    document.getElementById('shareOrderBtn').click();
    await new Promise(r => setTimeout(r, 20));
    return {
      toast: document.getElementById('toast').textContent,
      value: out.value,
      writes,
      buySame: JSON.stringify(buyCart) === buyBefore,
      unavailable: share.classList.contains('is-unavailable'),
      aria: share.getAttribute('aria-label'),
      disabled: share.getAttribute('aria-disabled'),
      note: note.textContent.trim(),
      noteDisplay: getComputedStyle(note).display,
      sellQty: sellCart.Cannabis && sellCart.Cannabis.qty
    };
  });
  check('sell-share-does-not-copy-buy-cart',
    sellShare.toast === 'Order links are for the buy cart' &&
    sellShare.value === 'SENTINEL-NOT-A-LINK' && sellShare.writes === 0 && sellShare.buySame &&
    sellShare.unavailable && sellShare.disabled === 'true' &&
    sellShare.note === 'Buy cart only' && sellShare.noteDisplay === 'block' &&
    /buy cart/i.test(sellShare.aria) && sellShare.sellQty === 3,
    sellShare);
  await shot(page, 'sell-share-390');
  const sellDock = await page.evaluate(() => {
    document.getElementById('codeSheetClose').click();
    document.getElementById('toast').classList.remove('show');
    const share = document.getElementById('shareOrderBtn');
    const note = share.querySelector('.note');
    const r = share.getBoundingClientRect();
    return {
      note: note.textContent.trim(),
      noteDisplay: getComputedStyle(note).display,
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      right: +r.right.toFixed(1),
      clipped: share.scrollWidth > share.clientWidth + 1,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth
    };
  });
  check('sell-dock-note-visible', sellDock.note === 'Buy cart only' && sellDock.noteDisplay === 'block' && sellDock.h >= 44 && sellDock.right <= 390.5 && !sellDock.clipped && sellDock.scrollW <= sellDock.clientW + 1, sellDock);
  await shot(page, 'sell-dock-390');
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const sell375 = await page.evaluate(() => {
    const share = document.getElementById('shareOrderBtn');
    const r = share.getBoundingClientRect();
    return {
      noteDisplay: getComputedStyle(share.querySelector('.note')).display,
      w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1),
      clipped: share.scrollWidth > share.clientWidth + 1,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth
    };
  });
  check('sell-dock-375-fits', sell375.noteDisplay === 'block' && sell375.w >= 44 && sell375.h >= 44 && sell375.right <= 375.5 && !sell375.clipped && sell375.scrollW <= sell375.clientW + 1, sell375);
  await shot(page, 'sell-dock-375');

  await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const short = await page.evaluate(() => {
    document.getElementById('codeSheetClose').click();
    document.getElementById('toast').classList.remove('show');
    document.querySelector('.tab-btn[data-tab="buy"]').click();
    buyPath = ['Weapons', 'Weapons']; render();
    const dock = document.querySelector('.dock').getBoundingClientRect();
    const stack = document.querySelector('#buyGrid .catstack').getBoundingClientRect();
    window.scrollTo(0, document.body.scrollHeight);
    const rows = [...document.querySelectorAll('#buyGrid .row')];
    const last = rows[rows.length - 1].getBoundingClientRect();
    const dock2 = document.querySelector('.dock').getBoundingClientRect();
    return {
      rows: rows.length,
      stackBottom: +stack.bottom.toFixed(1),
      dockTop: +dock.top.toFixed(1),
      menusClearDock: stack.bottom < dock.top - 8,
      lastBottom: +last.bottom.toFixed(1),
      dockTopScrolled: +dock2.top.toFixed(1),
      hidden: last.bottom > dock2.top + 1,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth
    };
  });
  check('short-375-scroll-clears-dock', short.rows > 3 && short.menusClearDock && !short.hidden && short.scrollW <= short.clientW + 1, short);
  await shot(page, 'nav-375-short');

  check('nav-console', errors.length === 0, errors.slice(0, 6));

  await page.close();
  await browser.close();
  const summary = { pass: fails.length === 0, fails };
  fs.writeFileSync(path.join(OUT, 'nav-dock.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(ART, 'nav-dock.json'), JSON.stringify(summary, null, 2));
  if (fails.length) {
    console.log('NAV FAILS', fails.length);
    process.exit(1);
  }
  console.log('NAV OK');
})().catch(err => { console.error(err); process.exit(1); });
