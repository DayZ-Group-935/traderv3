const puppeteer = require('puppeteer-core');
const FILE = 'file://' + (process.argv[2] || require('path').join(__dirname, '..', 'index.html'));
const OUT = process.env.OUT || require('path').join(__dirname, 'out', 'icons') + '/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => errors.push('reqfail ' + r.url().slice(0, 80)));
  const VW = +(process.argv[3] || 375); await page.setViewport({ width: VW, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(FILE, { waitUntil: 'load' }); await sleep(300);
  const E = (f, ...a) => page.evaluate(f, ...a);
  const res = await E(() => {
    const out = { tiles: 0, cats: 0, bad: [], fallback: [], truncated: [], itemNames: new Set(), zeroBox: [], wordBreaks: [] };
    const check = (scope) => { if (typeof fitNames === 'function') fitNames(document.querySelector(scope));
      document.querySelectorAll(scope + ' .item-btn:not(.back-btn), ' + scope + ' .cat-btn').forEach(b => {
        if (b.classList.contains('role-turnin')) return;
        const isCat = b.classList.contains('cat-btn'); isCat ? out.cats++ : out.tiles++;
        const u = b.querySelector('.ic use'); const href = u && u.getAttribute('href');
        const t = href && document.getElementById(href.slice(1));
        if (!t || t.tagName.toLowerCase() !== 'symbol') out.bad.push(b.textContent);
        if (href === '#ic-crate' && !isCat) out.fallback.push(b.textContent);
        const r = u && u.getBoundingClientRect(); const sr = u && u.closest('svg').getBoundingClientRect(); if (!r || r.width < 4 || r.height < 4 || !sr || sr.width < 20) out.zeroBox.push(b.textContent);
        const nm = b.querySelector('.nm'); if (nm && (nm.scrollWidth > nm.clientWidth + 1)) out.truncated.push(b.textContent);
        if (nm) { const cs = getComputedStyle(nm); const cx = (window.__cv ||= document.createElement('canvas')).getContext('2d'); cx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
          nm.textContent.split(/\s+/).forEach(w => { if (cx.measureText(w).width > nm.clientWidth + 0.5) out.wordBreaks.push(w + ' (' + Math.round(cx.measureText(w).width) + '>' + nm.clientWidth + ')'); }); }
        if (!isCat) out.itemNames.add(b.textContent.replace(/\*/g, '').replace(/ ×\d+$/, ''));
      });
    };
    const walkBuy = (path) => { buyPath = path.slice(); render(); check('#buyGrid'); let node = buyitems; for (const p of path) node = node[p];
      if (!Array.isArray(node)) Object.keys(node).filter(k => !k.startsWith('_') && !(node[k] && node[k]._outOfStock)).forEach(k => walkBuy(path.concat(k))); };
    currentTab = 'buy'; walkBuy([]);
    // out of stock IED: render its items via search
    searchTerm = 'ied'; render(); check('#buyGrid'); searchTerm = 'plastic'; render(); check('#buyGrid'); searchTerm = 'detonator'; render(); check('#buyGrid'); searchTerm = 'm4'; render(); check('#buyGrid'); searchTerm = '';
    // bulk buttons
    flattenBuyItems(buyitems).filter(i => i.bulkOptions && i.inStock !== false).forEach(i => { handleBuyItem(i); check('#buyGrid'); });
    buyCart = {}; currentTab = 'sell'; sellPath = []; render(); check('#sellGrid');
    Object.keys(sellitems).forEach(c => { sellPath = [c]; render(); check('#sellGrid'); });
    searchTerm = 'pelt'; render(); check('#sellGrid'); searchTerm = '';
    sellitems['General'].filter(i => i.bulkOptions).forEach(i => { handleSellItem(i); check('#sellGrid'); });
    sellCart = {}; currentTab = 'buy'; sellPath = []; buyPath = []; render();
    const allBuy = flattenBuyItems(buyitems).map(i => i.name), allSell = Object.values(sellitems).flat().map(i => i.name);
    out.missingRows = allBuy.concat(allSell).filter(n => !out.itemNames.has(n));
    out.itemNames = out.itemNames.size; out.wordBreaks = [...new Set(out.wordBreaks)];
    // cart rows
    addToCart('buy', 'M4A1', 1, 3500); addToCart('buy', 'Car Tires', 4, 500); addToCart('sell', 'Cannabis', 10, 10);
    out.cartRows = [...document.querySelectorAll('.summary-item')].map(r => { const h = r.querySelector('.ic use')?.getAttribute('href'); return { t: r.querySelector('.name').textContent, ok: !!(h && document.getElementById(h.slice(1))) }; });
    renderSummary('sell'); out.sellCartRows = [...document.querySelectorAll('#sellSummary .summary-item')].map(r => !!document.getElementById((r.querySelector('.ic use')?.getAttribute('href') || '#x').slice(1)));
    // kit rows
    handleBuyItem({ name: 'Player Kit' });
    out.kitRows = [...document.querySelectorAll('#kitFields .kit-row')].map(r => { const h = r.querySelector('.ic use')?.getAttribute('href'); return { l: r.querySelector('label')?.textContent, ok: !!(h && document.getElementById(h.slice(1))), h }; });
    const hd = document.querySelector('select[data-slot="helmet"]'); hd.value = 'Boonie Hat + NVG Strap'; hd.dispatchEvent(new Event('change', { bubbles: true }));
    return out;
  });
  await sleep(50);
  res.kitHeadAfterChange = await E(() => document.querySelector('select[data-slot="helmet"]').closest('.kit-row').querySelector('use').getAttribute('href'));
  await E(() => { closeKitPanel(); buyCart = {}; sellCart = {}; kitConfigs = []; render(); renderKitSummaries(); });
  res.errors = errors;
  console.log(JSON.stringify(res, null, 1));
  // screenshots
  const shot = async (n) => { await sleep(600); await page.screenshot({ path: OUT + '375-' + n + '.png' }); };
  await page.goto(FILE, { waitUntil: 'load' }); await sleep(300);
  await shot('01-main-buy');
  await E(() => { buyPath = ['Weapons']; render(); }); await shot('02-weapons-cats');
  await E(() => { buyPath = ['Weapons', 'Weapons']; render(); }); await shot('03-weapons-items');
  await E(() => { buyPath = ['Clothing']; render(); }); await shot('04-clothing-cats');
  await E(() => { buyPath = ['Clothing', 'Headgear']; render(); }); await shot('05-headgear');
  await E(() => { buyPath = ['Meds & Tools', 'Pharmaceuticals']; render(); }); await shot('06-pharma');
  await E(() => { buyPath = ['Building']; render(); }); await shot('07-building');
  await E(() => { buyPath = ['Vehicles', 'Tires']; render(); addToCart('buy', 'Car Tires', 4, 500); addToCart('buy', 'M4A1', 1, 3500); addToCart('buy','Bandages',2,250); document.getElementById('toast').classList.remove('show'); const r = document.getElementById('buySummaryWrap').getBoundingClientRect(); window.scrollTo(0, scrollY + r.top - 300); }); await shot('08-tires-cart');
  await E(() => { window.scrollTo(0,0); buyCart = {}; render(); document.querySelector('.tab-btn[data-tab="sell"]').click(); }); await shot('09-sell-main');
  await E(() => { sellPath = ['General']; render(); }); await shot('10-sell-general');
  await E(() => { sellPath = ['High Value Items']; render(); }); await shot('11-sell-highvalue');
  await E(() => { document.querySelector('.tab-btn[data-tab="buy"]').click(); const s = document.getElementById('search'); s.value = 'scar'; s.dispatchEvent(new Event('input')); }); await shot('12-search-scar');
  await E(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); handleBuyItem(flattenBuyItems(buyitems).find(i => i.name === '5.56x45')); }); await shot('13-bulk');
  await E(() => { buyPath = []; render(); handleBuyItem({ name: 'Player Kit' }); }); await shot('14-kit-top');
  await E(() => { const h = document.querySelector('select[data-slot="helmet"]'); h.value = 'Boonie Hat + NVG Strap'; h.dispatchEvent(new Event('change', { bubbles: true })); const b = document.querySelector('.kit-box'); const r = h.closest('.kit-row').getBoundingClientRect(); b.scrollTop += r.top - b.getBoundingClientRect().top - 200; }); await shot('15-kit-gear');
  await E(() => { document.querySelector('input[data-omit="candy"]').click(); const b = document.querySelector('.kit-box'); b.scrollTop = b.scrollHeight; }); await shot('16-kit-included');
  await browser.close();
})();
