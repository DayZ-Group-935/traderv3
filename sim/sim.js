// 935 Trading Calculator simulation harness (puppeteer-core + system Chrome)
const puppeteer = require('puppeteer-core');
const fs = require('fs'); const path = require('path');
const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = 'file://' + FILE;
const OUT = path.join(__dirname, 'out');
const results = []; let consoleErrors = [];
function rec(id, pass, detail) { results.push({ id, pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); }

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FILE_NOT_FOUND/.test(m.text())) consoleErrors.push(m.text()); }); // logo-enhanced.png is not shipped with the HTML; ignore its 404
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  async function fresh() { await page.goto(URL); await page.evaluate(() => localStorage.clear()); await page.reload(); consoleErrors = []; }
  await fresh();
  const E = (fn, ...a) => page.evaluate(fn, ...a);
  const clickText = async (sel, text) => E((sel, text) => { const b = [...document.querySelectorAll(sel)].find(x => x.textContent.trim() === text); if (!b) return false; b.click(); return true; }, sel, text);
  const header = (t) => E(t => document.querySelector(`#${t}SummaryWrap .summary-header`).textContent, t);

  // ---------- 1. Catalog walk: every buy item clickable via UI ----------
  const walk = await E(() => {
    const leaves = []; // {path, item}
    (function rec(node, p) {
      if (Array.isArray(node)) node.forEach(i => leaves.push({ path: p, name: i.name, price: i.price, bulk: i.bulkOptions || null, inStock: i.inStock }));
      else Object.keys(node).forEach(k => { if (k.startsWith('_')) return; rec(node[k], p.concat(k)); });
    })(buyitems, []);
    return leaves;
  });
  // IED is {_outOfStock, items}; walker above treats "items" as a path segment
  let buyFails = [], buyCount = 0;
  for (const leaf of walk) {
    await E(() => { buyCart = {}; kitConfigs = []; currentTab = 'buy'; searchTerm = ''; buyPath = []; render(); });
    let ok = true;
    for (const seg of leaf.path) { if (seg === 'items') continue; if (!(await clickText('#buyGrid .cat-btn', seg))) { ok = false; break; } }
    const navOk = ok;
    if (ok) ok = await clickText('#buyGrid .item-btn', leaf.name) || await E(n => { const b = [...document.querySelectorAll('#buyGrid .item-btn')].find(x => x.textContent.replace(/\*/g, '').trim() === n); if (b) { b.click(); return true } return false }, leaf.name);
    let q = 1;
    if (ok && leaf.bulk) { q = leaf.bulk[leaf.bulk.length - 1]; ok = await clickText('#buyGrid .item-btn', `${leaf.name} ×${q}`); }
    const cart = await E(() => JSON.parse(JSON.stringify(buyCart)));
    const kitOpen = await E(() => document.getElementById('kitPanel').style.display === 'flex');
    buyCount++;
    if (leaf.name === 'Player Kit' || leaf.name === 'Ghillie Kit') { if (!kitOpen) buyFails.push({ leaf, why: 'kit panel did not open' }); await E(() => closeKitPanel()); continue; }
    if (leaf.inStock === false || leaf.path.includes('IED')) {
      const t = await E(() => document.getElementById('toast').textContent);
      if (Object.keys(cart).length) buyFails.push({ leaf, why: 'out-of-stock item added', cart });
      else if (leaf.path.includes('IED') && (await E(() => buyPath.includes('IED')))) buyFails.push({ leaf, why: 'IED category navigable' });
      continue;
    }
    if (!ok) { buyFails.push({ leaf, why: 'not clickable' }); continue; }
    if (leaf.name === 'IED Complete') continue;
    if (!cart[leaf.name] || cart[leaf.name].qty !== q || cart[leaf.name].base !== leaf.price) buyFails.push({ leaf, why: 'cart mismatch', cart });
  }
  rec('buy-catalog-walk: every in-stock buy item addable via category UI incl. largest bulk option', buyFails.length === 0, { tested: buyCount, fails: buyFails });

  // sell walk
  const sellLeaves = await E(() => Object.entries(sellitems).flatMap(([c, a]) => a.map(i => ({ c, name: i.name, price: i.price, bulk: i.bulkOptions || null }))));
  let sellFails = [];
  for (const l of sellLeaves) {
    for (const q0 of (l.bulk || [1])) {
      await E(() => { sellCart = {}; currentTab = 'sell'; searchTerm = ''; sellPath = []; render(); });
      await clickText('#sellGrid .cat-btn', l.c);
      await clickText('#sellGrid .item-btn', l.name);
      if (l.bulk) await clickText('#sellGrid .item-btn', `${l.name} ×${q0}`);
      const c = await E(() => JSON.parse(JSON.stringify(sellCart)));
      if (!c[l.name] || c[l.name].qty !== q0 || c[l.name].base !== l.price) sellFails.push({ l, q0, c });
    }
  }
  rec('sell-catalog-walk: every sell item and every bulk option addable', sellFails.length === 0, { tested: sellLeaves.length, fails: sellFails });

  // every buy bulk option
  const bulkRes = await E(() => {
    const fails = []; let n = 0;
    flattenBuyItems(buyitems).filter(i => i.bulkOptions && i.inStock !== false).forEach(i => i.bulkOptions.forEach(q => { buyCart = {}; handleBuyItem(i); const b = [...document.querySelectorAll('#buyGrid .item-btn')].find(x => x.textContent === `${i.name} ×${q}`); n++; if (!b) { fails.push(i.name + ' x' + q + ' missing'); return; } b.click(); if (!buyCart[i.name] || buyCart[i.name].qty !== q) fails.push(i.name + ' x' + q); }));
    return { n, fails };
  });
  rec('buy-bulk-options: every bulk button adds exact qty', bulkRes.fails.length === 0, bulkRes);

  // ---------- 2. Role key orphan check ----------
  const orphans = await E(() => {
    const buyNames = new Set(flattenBuyItems(buyitems).filter(x => x && x.name).map(x => x.name));
    const sellNames = new Set(Object.values(sellitems).flat().map(x => x.name));
    const out = [];
    for (const [r, d] of Object.entries(roles)) {
      for (const k of Object.keys(d.discounts || {})) if (!buyNames.has(k)) out.push({ role: r, type: 'discount', key: k, inSell: sellNames.has(k) });
      for (const k of Object.keys(d.bonuses || {})) if (!sellNames.has(k)) out.push({ role: r, type: 'bonus', key: k, inBuy: buyNames.has(k) });
    }
    return out;
  });
  rec('role-keys: every discount key matches a buy item and every bonus key a sell item', orphans.length === 0, orphans);

  // discount actually applied via UI for one sample per role key (non-orphans)
  const roleApply = await E(() => {
    const items = Object.fromEntries(flattenBuyItems(buyitems).filter(x => x && x.name).map(x => [x.name, x]));
    const fails = []; let n = 0;
    for (const [r, d] of Object.entries(roles)) for (const [k, pct] of Object.entries(d.discounts || {})) {
      if (!items[k]) continue; n++;
      activeRoles = new Set([r]); const got = getDiscountedPrice(k, items[k].price); const exp = items[k].price * (1 - pct / 100);
      if (Math.abs(got - exp) > 1e-9 || got < 0) fails.push({ r, k, got, exp });
    }
    activeRoles = new Set(); return { n, fails };
  });
  rec('role-discounts: each matched discount key yields base*(1-pct)', roleApply.fails.length === 0, roleApply);

  // stacking: overlapping roles take max discount, no double apply
  const stack = await E(() => {
    const o = {};
    activeRoles = new Set(['Deadshot', 'Hotshot']); o.tundra_dead_hot = getDiscountedPrice('Tundra', 2500);
    activeRoles = new Set(['Kamikaze', 'Click Click Boom']); o.grenade_kam_ccb = getDiscountedPrice('Grenade', 750);
    activeRoles = new Set(['Deadshot', 'Head Hunter', 'Hotshot']); o.win308 = getDiscountedPrice('308 WIN', 500);
    activeRoles = new Set(Object.keys(roles)); const all = flattenBuyItems(buyitems).filter(x => x && x.name).map(i => [i.name, getDiscountedPrice(i.name, i.price)]); o.anyNegative = all.filter(([, p]) => p < 0);
    activeRoles = new Set(); return o;
  });
  rec('role-stacking: Deadshot+Hotshot Tundra=1250 (max discount, not stacked)', stack.tundra_dead_hot === 1250, stack.tundra_dead_hot);
  rec('role-stacking: Kamikaze(25)+ClickClickBoom(20) Grenade=562.5', stack.grenade_kam_ccb === 562.5, stack.grenade_kam_ccb);
  rec('role-308: Deadshot/Hotshot/Head Hunter discount 308 WIN (expect 250)', stack.win308 === 250, stack.win308);
  rec('role-all-active: no negative unit prices', stack.anyNegative.length === 0, stack.anyNegative);

  // bonus semantics
  const bonus = await E(() => {
    const o = {};
    sellCart = { Cigarettes: { qty: 1, base: 25, salePrice: null } }; activeRoles = new Set(['Marlboro Man']); renderSummary('sell'); o.marlboro_1cig = document.querySelector('#sellSummaryWrap .summary-header').textContent;
    sellCart = { Cannabis: { qty: 1, base: 10, salePrice: null } }; activeRoles = new Set(['Dr. Greenthumb']); renderSummary('sell'); o.greenthumb_1 = document.querySelector('#sellSummaryWrap .summary-header').textContent;
    sellCart = { 'Hockey Stick': { qty: 1, base: 500, salePrice: null } }; activeRoles = new Set(['Hat Trick']); renderSummary('sell'); o.hattrick_1 = document.querySelector('#sellSummaryWrap .summary-header').textContent;
    // order dependence of bonus vs discount (same name)
    roles.__A = { discounts: { X: 50 } }; roles.__B = { bonuses: { X: 999 } };
    activeRoles = new Set(['__A', '__B']); o.order_AB = getDiscountedPrice('X', 100);
    activeRoles = new Set(['__B', '__A']); o.order_BA = getDiscountedPrice('X', 100);
    delete roles.__A; delete roles.__B; activeRoles = new Set(); sellCart = {};
    return o;
  });
  rec('bonus-semantics: Marlboro Man active, sell 1 Cigarette (base 25) – bonus replaces unit price', true, bonus);

  // ---------- 3. Randomized totals vs independent recompute ----------
  const rand = await E((N) => {
    // independent model, written from the stated rules (not reusing app functions)
    const buyAll = []; (function w(n) { if (Array.isArray(n)) n.forEach(i => buyAll.push(i)); else Object.keys(n).forEach(k => { if (!k.startsWith('_')) w(n[k]); }); })(buyitems);
    const buyable = buyAll.filter(i => i.inStock !== false && !['Player Kit', 'Ghillie Kit', 'IED Complete'].includes(i.name));
    const sellAll = Object.values(sellitems).flat();
    const roleNames = Object.keys(roles);
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const mism = []; let lineHeaderMismatch = 0; let lineHeaderExamples = [];
    for (let t = 0; t < N; t++) {
      buyCart = {}; sellCart = {}; kitConfigs = []; activeRoles = new Set();
      roleNames.forEach(r => { if (rnd() < 0.2) activeRoles.add(r); });
      const exp = {}; const sexp = {};
      const nb = Math.floor(rnd() * 8);
      for (let i = 0; i < nb; i++) { const it = buyable[Math.floor(rnd() * buyable.length)]; const q = it.bulkOptions ? it.bulkOptions[Math.floor(rnd() * it.bulkOptions.length)] : 1; addToCart('buy', it.name, q, it.price, it.salePrice); exp[it.name] = exp[it.name] || { q: 0, p: it.price }; exp[it.name].q += q; }
      const ns = Math.floor(rnd() * 6);
      for (let i = 0; i < ns; i++) { const it = sellAll[Math.floor(rnd() * sellAll.length)]; const q = it.bulkOptions ? it.bulkOptions[Math.floor(rnd() * it.bulkOptions.length)] : 1; addToCart('sell', it.name, q, it.price); sexp[it.name] = sexp[it.name] || { q: 0, p: it.price }; sexp[it.name].q += q; }
      const unit = (name, base) => { let best = base; let bonus = null; for (const r of activeRoles) { const d = roles[r].discounts?.[name]; if (d) best = Math.min(best, base * (1 - d / 100)); const b = roles[r].bonuses?.[name]; if (b) bonus = b; } return bonus ?? best; };
      let eb = 0; for (const [n, v] of Object.entries(exp)) eb += unit(n, v.p) * v.q; if (activeRoles.has('Day One')) eb *= 0.9;
      const bible = q => q === 1 ? 10000 : q === 2 ? 30000 : q === 3 ? 40000 : q >= 4 ? 60000 : 0;
      let es = 0; for (const [n, v] of Object.entries(sexp)) es += n === 'Bible' ? bible(v.q) : unit(n, v.p) * v.q;
      calculate();
      const toastTxt = document.getElementById('toast').textContent;
      const m = toastTxt.replace(/,/g, '').match(/Buy(?: \(FM\))?: (-?\d+) Cr \| Sell: (-?\d+) Cr/);
      if (!m || +m[1] !== Math.round(eb) || +m[2] !== Math.round(es)) mism.push({ t, toastTxt, eb, es, roles: [...activeRoles] });
      // line-vs-header consistency (live summary, no Day One)
      renderSummary('buy');
      const lines = [...document.querySelectorAll('#buySummary .summary-item .price')].map(s => { const mm = s.textContent.replace(/,/g, '').match(/(\d+) Cr|TOKEN/); return mm && mm[1] ? +mm[1] : 0; });
      const h = document.querySelector('#buySummaryWrap .summary-header').textContent.replace(/,/g, '').match(/— (\d+) Cr/);
      const hs = h ? +h[1] : 0; const ls = lines.reduce((a, b) => a + b, 0);
      if (hs !== ls && !activeRoles.has('Day One')) { lineHeaderMismatch++; if (lineHeaderExamples.length < 3) lineHeaderExamples.push({ cart: JSON.parse(JSON.stringify(buyCart)), roles: [...activeRoles], header: hs, sumLines: ls }); }
    }
    activeRoles = new Set(); buyCart = {}; sellCart = {}; render();
    return { N, mismatches: mism.length, examples: mism.slice(0, 3), lineHeaderMismatch, lineHeaderExamples };
  }, 500);
  rec('random-carts: calculate() toast == independent recompute (500 runs, 20% role density)', rand.mismatches === 0, { N: rand.N, mismatches: rand.mismatches, examples: rand.examples });
  rec('random-carts: sum of rounded line prices == rounded header total (carts without Day One; Day One 10% is applied to header only)', rand.lineHeaderMismatch === 0, { count: rand.lineHeaderMismatch, examples: rand.lineHeaderExamples });

  // Day One live header vs calculate
  const dayOne = await E(() => {
    buyCart = {}; activeRoles = new Set(['Day One']); addToCart('buy', 'M4A1', 1, 3500); const live = document.querySelector('#buySummaryWrap .summary-header').textContent; calculate(); const calc = document.querySelector('#buySummaryWrap .summary-header').textContent; addToCart('buy', 'Belt', 1, 100); const after = document.querySelector('#buySummaryWrap .summary-header').textContent; activeRoles = new Set(); buyCart = {}; render(); return { live, calc, afterNextAdd: after };
  });
  rec('day-one: live cart header reflects 10% (expected 3150)', /3,?150/.test(dayOne.live), dayOne);

  // ---------- 4. Merge with different base (role turn-in) ----------
  const merge = await E(() => {
    sellCart = {}; activeRoles = new Set();
    addToCart('sell', 'Cannabis', 10, 10); doRoleTurnIn({ name: 'Cannabis' });
    const a = JSON.parse(JSON.stringify(sellCart.Cannabis));
    sellCart = {}; doRoleTurnIn({ name: 'Cannabis' }); addToCart('sell', 'Cannabis', 10, 10);
    const b = JSON.parse(JSON.stringify(sellCart.Cannabis));
    sellCart = {}; addToCart('sell', 'Cannabis', 10, 10); doRoleTurnIn({ name: 'Cannabis' }); calculate(); const total = document.getElementById('toast').textContent.replace(/,/g, '');
    sellCart = {}; return { normalThenTurnIn: a, turnInThenNormal: b, sellToast: total };
  });
  rec('merge: normal Cannabis x10 then Role Turn-In x1200 keeps both prices (expect sell 10*10+1200*14=16900)', /Sell: 16900 Cr/.test(merge.sellToast), merge);

  // ---------- 5. Role turn-in buttons ----------
  const turnin = await E(() => {
    const out = [];
    for (const it of Object.values(sellitems).flat()) {
      sellCart = {}; currentTab = 'sell'; searchTerm = ''; render(); handleSellItem(it);
      const b = [...document.querySelectorAll('#sellGrid .role-turnin')][0];
      if (!b) continue; b.click(); out.push({ item: it.name, addedKeys: Object.keys(sellCart), cart: JSON.parse(JSON.stringify(sellCart)) });
    }
    sellCart = {}; render(); return out;
  });
  const deadTurnins = turnin.filter(t => t.addedKeys.length === 0).map(t => t.item);
  rec('role-turnin: every visible Role Turn-In button adds something', deadTurnins.length === 0, { dead: deadTurnins, all: turnin.map(t => [t.item, t.addedKeys]) });

  // ---------- 6. Out of stock ----------
  const oos = await E(() => {
    const o = {}; buyCart = {}; currentTab = 'buy'; buyPath = ['Vehicles', 'Vehicles']; searchTerm = ''; render();
    const btn = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => b.textContent.includes('Trader Car')); o.carStyled = btn && btn.style.textDecoration; btn.click(); o.carCart = Object.keys(buyCart); o.toast = document.getElementById('toast').textContent;
    buyPath = ['Explosives']; render(); const ied = [...document.querySelectorAll('#buyGrid .cat-btn')].find(b => b.textContent === 'IED'); ied.click(); o.iedNav = buyPath.slice();
    // via search
    buyPath = []; searchTerm = 'ied'; render(); o.searchIED = [...document.querySelectorAll('#buyGrid .item-btn')].map(b => ({ t: b.textContent, strike: b.style.textDecoration }));
    const comp = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => b.textContent === 'IED Complete'); if (comp) comp.click(); o.cartAfterSearchIED = JSON.parse(JSON.stringify(buyCart));
    searchTerm = 'plastic'; render(); const pe = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => b.textContent === 'Plastic Explosives'); buyCart = {}; if (pe) pe.click(); o.cartAfterSearchPE = JSON.parse(JSON.stringify(buyCart));
    searchTerm = 'trader car'; render(); const tc = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => b.textContent.includes('Trader Car')); buyCart = {}; tc && tc.click(); o.carViaSearch = Object.keys(buyCart);
    searchTerm = ''; buyCart = {}; buyPath = []; render(); return o;
  });
  rec('oos: Trader Car struck through and not addable (category + search)', oos.carCart.length === 0 && oos.carViaSearch.length === 0 && oos.carStyled === 'line-through', oos);
  rec('oos: IED category blocked in category view', oos.iedNav.length === 1, oos.iedNav);
  rec('oos: IED items blocked in search results', Object.keys(oos.cartAfterSearchIED).length === 0 && Object.keys(oos.cartAfterSearchPE).length === 0, { searchIED: oos.searchIED, afterIEDComplete: oos.cartAfterSearchIED, afterPlastic: oos.cartAfterSearchPE });

  // ---------- 7. Order codes ----------
  await fresh();
  const codes = await E(async () => {
    const o = {}; const parseOut = v => { const s = String(v || ''); const m = s.match(/#order=([^&]*)/i); return JSON.parse(atob(m ? decodeURIComponent(m[1]) : s)); };
    const gen = () => { document.getElementById('genCodeBtn').click(); return document.getElementById('orderCodeOut').value; };
    const load = (c) => { document.getElementById('orderCodeIn').value = c; let err = null; try { document.getElementById('loadCodeBtn').click(); } catch (e) { err = e.message; } return { toast: document.getElementById('toast').textContent, cart: JSON.parse(JSON.stringify(buyCart)), err }; };
    // roundtrip random
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const all = flattenBuyItems(buyitems).filter(i => i && i.name && i.inStock !== false && !/Kit$/.test(i.name)); let rtFail = 0;
    for (let t = 0; t < 200; t++) { buyCart = {}; for (let i = 0; i < 1 + rnd() * 10; i++) { const it = all[Math.floor(rnd() * all.length)]; addToCart('buy', it.name, 1 + Math.floor(rnd() * 5), it.price); } const before = JSON.stringify(buyCart); const c = gen(); buyCart = {}; load(c); if (JSON.stringify(buyCart) !== before) rtFail++; }
    o.roundtripFails = rtFail;
    buyCart = {}; o.emptyGen = (gen(), document.getElementById('toast').textContent);
    o.emptyLoad = load('');
    o.garbage = load('!!!not base64!!!');
    o.notJson = load(btoa('hello'));
    o.tamperPrice = load(btoa(JSON.stringify({ 'Trader Truck': { qty: 1, base: 1, salePrice: null } })));
    renderSummary('buy'); o.tamperHeader = document.querySelector('#buySummaryWrap .summary-header').textContent;
    o.negativeQty = load(btoa(JSON.stringify({ 'M4A1': { qty: -10, base: 3500, salePrice: null } }))); renderSummary('buy'); o.negHeader = document.querySelector('#buySummaryWrap .summary-header').textContent;
    o.unknownItem = load(btoa(JSON.stringify({ 'Free Money': { qty: 1, base: -99999, salePrice: null } })));
    window.__xss = 0; o.xss = load(btoa(JSON.stringify({ '<img src=x onerror="window.__xss=1">': { qty: 1, base: 1, salePrice: null } })));
    await new Promise(r => setTimeout(r, 300)); o.xssFired = window.__xss;
    o.nullCode = load(btoa('null'));
    let addErr = null; try { addToCart('buy', 'M4A1', 1, 3500); } catch (e) { addErr = e.message; } o.addAfterNull = addErr;
    o.arrayCode = load(btoa('[1,2,3]'));
    // kit roundtrip
    buyCart = {}; kitConfigs = []; handleBuyItem({ name: 'Player Kit' }); saveKit(); const kc = gen(); const kitDefsBefore = kitConfigs.length; kitConfigs = []; buyCart = {}; load(kc); o.kitRoundtrip = { cartKeys: Object.keys(buyCart), kitDefsBefore, kitDefsAfterLoad: kitConfigs.length };
    // load replaces cart but stale kit defs remain
    buyCart = {}; kitConfigs = []; handleBuyItem({ name: 'Player Kit' }); saveKit(); load(btoa(JSON.stringify({ 'M4A1': { qty: 1, base: 3500, salePrice: null } }))); o.staleKitDefs = { cart: Object.keys(buyCart), kitConfigs: kitConfigs.map(k => k.name), boxVisible: document.getElementById('kitSummaryBox')?.style.display };
    o.sellInCode = (() => { buyCart = { M4A1: { qty: 1, base: 3500, salePrice: null } }; sellCart = { Bible: { qty: 1, base: 10000, salePrice: null } }; activeRoles = new Set(['Day One']); const c = gen(); return parseOut(c); })();
    buyCart = {}; sellCart = {}; kitConfigs = []; activeRoles = new Set();
    return o;
  });
  rec('codes: 200 random carts round-trip exactly', codes.roundtripFails === 0, codes.roundtripFails);
  rec('codes: empty cart generate -> "Cart is empty"; empty load -> "Paste a link or code first"', codes.emptyGen === 'Cart is empty' && codes.emptyLoad.toast === 'Paste a link or code first', [codes.emptyGen, codes.emptyLoad.toast]);
  rec('codes: garbage / non-JSON -> "Invalid code", cart unchanged', codes.garbage.toast === 'Invalid code' && codes.notJson.toast === 'Invalid code', [codes.garbage, codes.notJson]);
  rec('codes: tampered price rejected or re-priced from catalog (Trader Truck base:1)', codes.tamperPrice.toast !== 'Order loaded' || /250,?000/.test(codes.tamperHeader), { toast: codes.tamperPrice.toast, header: codes.tamperHeader });
  rec('codes: negative qty rejected', codes.negativeQty.toast !== 'Order loaded', { toast: codes.negativeQty.toast, header: codes.negHeader });
  rec('codes: unknown item rejected', codes.unknownItem.toast !== 'Order loaded', codes.unknownItem);
  rec('codes: HTML in item name not executed (XSS)', codes.xssFired === 0, { fired: codes.xssFired });
  rec('codes: "null" code fails gracefully', codes.nullCode.toast !== 'Order loaded' && !codes.addAfterNull, { toast: codes.nullCode.toast, err: codes.nullCode.err, addAfterNull: codes.addAfterNull });
  rec('codes: array code rejected', codes.arrayCode.toast !== 'Order loaded', codes.arrayCode);
  rec('codes: kit definitions travel with code', codes.kitRoundtrip.kitDefsAfterLoad === codes.kitRoundtrip.kitDefsBefore, codes.kitRoundtrip);
  rec('codes: loading a code clears stale kit definitions', codes.staleKitDefs.kitConfigs.length === 0, codes.staleKitDefs);
  rec('codes: info — code payload contents (buy cart only; no sell, roles, Day One)', true, codes.sellInCode);
  const pe1 = consoleErrors.slice(); rec('codes: console errors during malformed-code tests', pe1.length === 0, pe1);

  // ---------- 8. Search ----------
  await fresh();
  const search = await E(() => {
    const s = (v, tab = 'buy') => { if (currentTab !== tab) document.querySelector(`.tab-btn[data-tab="${tab}"]`).click(); const el = document.getElementById('search'); el.value = v; el.dispatchEvent(new Event('input')); const g = document.getElementById(tab + 'Grid'); return { items: [...g.querySelectorAll('.item-btn')].map(b => b.textContent), empty: !!g.querySelector('.empty'), bc: document.getElementById(tab + 'Breadcrumb').textContent }; };
    const o = {};
    o.upper = s('M4A1').items; o.lower = s('m4a1').items; o.partial = s('tun').items; o.spaces = s('   tundra  ').items;
    o.none = s('zzzqqq'); o.clear = s(''); o.single_a = s('a').items.length; o.r = s('r').items.length;
    o.desert = s('cuu').items.concat(s('hunter').items); o.kit = s('kit').items;
    o.sellUpper = s('BIBLE', 'sell').items; o.sellNone = s('zz', 'sell'); o.sellClear = s('', 'sell');
    // tab switch clears search
    s('tundra', 'buy'); document.querySelector('.tab-btn[data-tab="sell"]').click(); o.afterTabSwitch = { val: document.getElementById('search').value, term: searchTerm };
    document.querySelector('.tab-btn[data-tab="buy"]').click();
    // add via search then bulk back returns to search results
    s('5.56'); [...document.querySelectorAll('#buyGrid .item-btn')].find(b => b.textContent === '5.56x45').click(); const bulkBtns = [...document.querySelectorAll('#buyGrid .item-btn')].map(b => b.textContent); [...document.querySelectorAll('#buyGrid .item-btn')].find(b => b.textContent === '← Back').click(); o.bulkFromSearch = { bulkBtns, afterBack: [...document.querySelectorAll('#buyGrid .item-btn')].map(b => b.textContent).slice(0, 5) };
    s(''); return o;
  });
  rec('search: case-insensitive (M4A1 == m4a1)', JSON.stringify(search.upper) === JSON.stringify(search.lower) && search.upper.includes('M4A1'), search.upper);
  rec('search: partial "tun" finds Tundra; whitespace trimmed', search.partial.includes('Tundra') && search.spaces.includes('Tundra'), { partial: search.partial, spaces: search.spaces });
  rec('search: no results shows "No matches"', search.none.empty && search.sellNone.empty, search.none);
  rec('search: clearing restores category view', search.clear.bc.startsWith('Buy') && search.sellClear.bc.startsWith('Sell'), [search.clear.bc, search.sellClear.bc]);
  rec('search: sell side case-insensitive', search.sellUpper.includes('Bible'), search.sellUpper);
  rec('search: tab switch clears search', search.afterTabSwitch.val === '' && search.afterTabSwitch.term === '', search.afterTabSwitch);
  rec('search: no duplicate buttons for "cuu"/"hunter"', new Set(search.desert).size === search.desert.length, search.desert);
  rec('search: info — single-letter result counts / kit search / bulk from search', true, { a: search.single_a, r: search.r, kit: search.kit, bulkFromSearch: search.bulkFromSearch });

  // ---------- 9. Player Kit ----------
  await fresh();
  const kit = await E(() => {
    const o = {}; const sel = k => document.querySelector(`select[data-slot="${k}"]`); const setSel = (k, v) => { const s = sel(k); s.value = v; s.dispatchEvent(new Event('change')); };
    handleBuyItem({ name: 'Player Kit' });
    o.initialDisabled = ['mag1', 'suppressor1', 'scope1', 'mag2', 'suppressor2', 'scope2'].filter(k => sel(k).disabled);
    setSel('weapon1', 'Tundra'); o.tundraLocks = { mag: sel('mag1').value, sup: sel('suppressor1').value, scope: sel('scope1').value, dis: [sel('mag1').disabled, sel('suppressor1').disabled, sel('scope1').disabled] };
    setSel('weapon1', 'M4A1'); o.m4scopes = [...sel('scope1').options].map(x => x.value); o.m4scopeVal = sel('scope1').value;
    setSel('weapon1', 'Tundra'); o.backToTundraScopeVal = sel('scope1').value;
    setSel('weapon1', 'M4A1'); setSel('weapon1', '(select)'); o.resetScopeVal = sel('scope1').value; o.resetScopeOpts = [...sel('scope1').options].map(x => x.value).slice(0, 3);
    setSel('weapon1', 'KAM'); setSel('weapon2', 'Crossbow');
    document.getElementById('kitTokenToggle').checked = true;
    document.querySelector('input[data-omit="candy"]').checked = false; document.querySelector('input[data-omit="morphine"]').checked = false;
    saveKit();
    o.cart1 = JSON.parse(JSON.stringify(buyCart)); o.cfg1 = JSON.parse(JSON.stringify(kitConfigs[0]));
    o.kitBox = document.getElementById('kitSummaryBox').innerText;
    o.summaryPrice = document.querySelector('#buySummary .summary-item .price').textContent;
    calculate(); o.calcToken = document.getElementById('toast').textContent;
    // no weapon selected: kit still added?
    handleBuyItem({ name: 'Player Kit' }); saveKit(); o.cart2 = Object.keys(buyCart); o.kit2weapon = kitConfigs[1].weapon1.item; o.kit2mag = kitConfigs[1].mag1.item;
    // Ghillie
    handleBuyItem({ name: 'Ghillie Kit' }); o.ghillieHasBackpack = !!sel('backpack'); o.ghillieHasHelmet = !!sel('helmet'); saveKit(); o.cart3 = Object.keys(buyCart); o.g3 = kitConfigs[2].backpack;
    calculate(); o.calc3 = document.getElementById('toast').textContent;
    // remove kit 1 then add another -> name collision
    buyCart = {}; kitConfigs = []; handleBuyItem({ name: 'Player Kit' }); saveKit(); handleBuyItem({ name: 'Player Kit' }); saveKit();
    [...document.querySelectorAll('#buySummary .remove-all')].find(b => b.dataset.name === 'Player Kit 1').click();
    o.afterRemove = { cart: Object.keys(buyCart), kits: kitConfigs.map(k => k.name) };
    handleBuyItem({ name: 'Player Kit' }); document.getElementById('kitTokenToggle').checked = true; saveKit();
    o.afterReAdd = { cart: JSON.parse(JSON.stringify(buyCart)), kits: kitConfigs.map(k => k.name + (k.token ? '(token)' : '')) };
    // cancel
    const before = Object.keys(buyCart).length; handleBuyItem({ name: 'Player Kit' }); closeKitPanel(); o.cancelNoAdd = Object.keys(buyCart).length === before;
    // Day One on kit
    activeRoles = new Set(['Day One']); buyCart = { 'Player Kit 1': { qty: 1, base: 16000, salePrice: null } }; calculate(); o.dayOneKit = document.getElementById('toast').textContent; activeRoles = new Set();
    buyCart = {}; kitConfigs = []; render(); renderKitSummaries();
    return o;
  });
  rec('kit: mag/suppressor/scope disabled until weapon chosen', kit.initialDisabled.length === 6, kit.initialDisabled);
  rec('kit: Tundra locks 308 WIN / Bottle Suppressor / Hunting Scope', kit.tundraLocks.mag === '308 WIN' && kit.tundraLocks.sup === 'Bottle Suppressor' && kit.tundraLocks.scope === 'Hunting Scope', kit.tundraLocks);
  rec('kit: switching M4A1 -> Tundra shows locked Hunting Scope in panel', kit.backToTundraScopeVal === 'Hunting Scope', { scopeValueShown: kit.backToTundraScopeVal, m4scopes: kit.m4scopes });
  rec('kit: resetting weapon to (select) resets scope to "- -"', kit.resetScopeVal === '- -', { scopeValueShown: kit.resetScopeVal, opts: kit.resetScopeOpts });
  rec('kit: token -> price 0, shows struck 16000 TOKEN; omitted items flagged and still listed', kit.cart1['Player Kit 1'].base === 0 && kit.cfg1.candy.omitted && kit.cfg1.morphine.omitted && /Candy Cane/.test(kit.kitBox) && /Morphine/.test(kit.kitBox), { cart: kit.cart1, summary: kit.summaryPrice, calc: kit.calcToken });
  rec('kit: KAM/Crossbow overrides saved', kit.cfg1.mag1.item === '75Rd KAM Drum Mag' && kit.cfg1.mag2.item === 'Bolts', { mag1: kit.cfg1.mag1, mag2: kit.cfg1.mag2, scope1: kit.cfg1.scope1, scope2: kit.cfg1.scope2 });
  rec('kit: empty slots save as "- -" (not "(select)")', kit.kit2weapon === "- -" && kit.kit2mag === "- -", { weapon1: kit.kit2weapon, mag1: kit.kit2mag });
  rec('kit: Ghillie kit hides backpack, stores Ghillie Suit', !kit.ghillieHasBackpack && kit.g3.item === 'Ghillie Suit', { helmetSlotShown: kit.ghillieHasHelmet, cart: kit.cart3, calc: kit.calc3 });
  rec('kit: remove Kit 1 then add new kit -> no name collision', Object.keys(kit.afterReAdd.cart).length === 2 && new Set(kit.afterReAdd.kits.map(k => k.replace('(token)', ''))).size === kit.afterReAdd.kits.length, { afterRemove: kit.afterRemove, afterReAdd: kit.afterReAdd });
  rec('kit: Cancel adds nothing', kit.cancelNoAdd);
  rec('kit: info — Day One applied to kit price', true, kit.dayOneKit);

  // ---------- 10. Cart controls, clear, tabs ----------
  await fresh();
  const ctl = await E(() => {
    const o = {}; activeRoles = new Set(['Roadkill']);
    addToCart('buy', 'Car Tires', 3, 500); addToCart('buy', 'Belt', 1, 100);
    document.querySelector('#buySummary .remove-one[data-name="Car Tires"]').click(); o.afterMinus = buyCart['Car Tires'].qty;
    document.querySelector('#buySummary .remove-one[data-name="Belt"]').click(); o.beltGone = !buyCart.Belt;
    document.querySelector('#buySummary .remove-all[data-name="Car Tires"]').click(); o.empty = Object.keys(buyCart).length === 0 && document.querySelector('#buySummary .empty') !== null;
    addToCart('buy', 'M4A1', 1, 3500); addToCart('sell', 'Bible', 1, 10000);
    document.querySelector('.tab-btn[data-tab="sell"]').click(); o.sellVisible = document.getElementById('sellSummaryWrap').style.display; o.buyHidden = document.getElementById('buySummaryWrap').style.display; o.orderBoxVisibleOnSell = getComputedStyle(document.getElementById('orderCodeBox')).display;
    document.querySelector('.tab-btn[data-tab="buy"]').click(); o.cartsKept = [Object.keys(buyCart), Object.keys(sellCart)];
    document.getElementById('clearRolesBtn').click(); o.rolesCleared = activeRoles.size === 0 && Object.keys(buyCart).length === 1;
    document.getElementById('genCodeBtn').click(); document.getElementById('clearAllBtn').click(); o.cleared = Object.keys(buyCart).length + Object.keys(sellCart).length; o.codeStillShown = document.getElementById('orderCodeOut').value.length > 0;
    o.lsAfterClear = localStorage.getItem('935calc');
    // remove-one with quotes in name? data-name attribute injection
    addToCart('buy', 'Red Dot (Baraka)', 2, 300); document.querySelector('#buySummary .remove-one').click(); o.parenName = buyCart['Red Dot (Baraka)']?.qty;
    buyCart = {}; render(); return o;
  });
  rec('cart: remove-one decrements; at qty 1 removes; remove-all removes', ctl.afterMinus === 2 && ctl.beltGone && ctl.empty, ctl);
  rec('cart: tab switch keeps both carts', ctl.cartsKept[0].length === 1 && ctl.cartsKept[1].length === 1, ctl.cartsKept);
  rec('cart: Clear Roles clears roles only', ctl.rolesCleared);
  rec('cart: Clear empties carts and localStorage cart', ctl.cleared === 0, ctl.lsAfterClear);
  rec('cart: Clear also clears a generated order code', !ctl.codeStillShown, { codeStillShown: ctl.codeStillShown });
  rec('cart: info — order code box visible on Sell tab', true, ctl.orderBoxVisibleOnSell);

  // ---------- 11. Large totals & formatting ----------
  const big = await E(() => {
    buyCart = {}; for (let i = 0; i < 7; i++) addToCart('buy', 'Trader Truck', 1, 250000); const h = document.querySelector('#buySummaryWrap .summary-header').textContent; const line = document.querySelector('#buySummary .price').textContent; calculate(); const t = document.getElementById('toast').textContent;
    activeRoles = new Set(['Kamikaze']); buyCart = {}; addToCart('buy', 'Grenade', 1, 750); const g1 = document.querySelector('#buySummary .price').textContent;
    activeRoles = new Set(['Kamikaze', 'Day One']); calculate(); const g2 = document.getElementById('toast').textContent;
    activeRoles = new Set(); buyCart = {}; render(); return { header7: h, line7: line, toast7: t, grenadeKamikazeLine: g1, grenadeKamikazeDayOneToast: g2 };
  });
  rec('format: 7 Trader Trucks = 1750000 exact', /1,?750,?000/.test(big.header7) && /1,?750,?000/.test(big.toast7), big);
  rec('format: thousands separators used (header, line, toast)', /1,750,000/.test(big.header7) && /1,750,000/.test(big.line7) && /1,750,000/.test(big.toast7), big);

  // ---------- 12 / R5. Refresh clears everything ----------
  await fresh();
  const freshState = () => E(() => ({
    buy: Object.keys(buyCart), sell: Object.keys(sellCart), roles: [...activeRoles], kits: kitConfigs.length, tab: currentTab,
    activeTabBtn: document.querySelector('.tab-btn.active')?.dataset.tab, buyPanel: document.getElementById('buyPanel').style.display, sellPanel: document.getElementById('sellPanel').style.display,
    roleBtnActive: document.querySelectorAll('.role-btn.active').length, search: document.getElementById('search').value, searchTerm,
    codeIn: document.getElementById('orderCodeIn').value, codeOut: document.getElementById('orderCodeOut').value, codeOutShown: document.getElementById('orderCodeOut').style.display !== 'none',
    buyHeader: document.querySelector('#buySummaryWrap .summary-header').textContent, sellHeader: document.querySelector('#sellSummaryWrap .summary-header').textContent,
    buyEmpty: !!document.querySelector('#buySummary .empty'), kitBox: document.getElementById('kitSummaryBox')?.style.display || 'absent', kitPanel: document.getElementById('kitPanel').style.display,
    ls: Object.keys(localStorage).filter(k => k.startsWith('935calc')), toastShown: document.getElementById('toast').classList.contains('show')
  }));
  const isFresh = st => st.buy.length === 0 && st.sell.length === 0 && st.roles.length === 0 && st.kits === 0 && st.tab === 'buy' && st.activeTabBtn === 'buy' && st.buyPanel === 'block' && st.sellPanel === 'none' && st.roleBtnActive === 0 && st.search === '' && st.searchTerm === '' && st.codeIn === '' && st.codeOut === '' && !st.codeOutShown && st.buyHeader === 'Buy Cart' && st.sellHeader === 'Sell Cart' && st.buyEmpty && (st.kitBox === 'none' || st.kitBox === 'absent') && st.kitPanel === 'none' && st.ls.length === 0;
  const fillEverything = () => E(() => {
    addToCart('buy', 'M4A1', 2, 3500); addToCart('buy', 'Trader Truck', 1, 250000);
    activeRoles.add('Hotshot'); activeRoles.add('Day One'); render();
    handleBuyItem({ name: 'Player Kit' }); const w = document.querySelector('select[data-slot="weapon1"]'); w.value = 'M4A1'; w.dispatchEvent(new Event('change'));
    document.getElementById('kitTokenToggle').checked = true; ['bandages', 'morphine'].forEach(k => document.querySelector(`input[data-omit="${k}"]`).checked = false); saveKit();
    document.getElementById('genCodeBtn').click(); const code = document.getElementById('orderCodeOut').value;
    document.querySelector('.tab-btn[data-tab="sell"]').click(); addToCart('sell', 'Bible', 3, 10000); doRoleTurnIn({ name: 'Cannabis' });
    const se = document.getElementById('search'); se.value = 'bib'; se.dispatchEvent(new Event('input'));
    document.getElementById('orderCodeIn').value = 'leftover text';
    calculate();
    // a pending (unsaved) kit form left open
    handleBuyItem({ name: 'Ghillie Kit' }); document.getElementById('kitTokenToggle').checked = true; document.querySelector('input[data-omit="saline"]').checked = false;
    return code;
  });
  const code5 = await fillEverything();
  const before5 = await freshState();
  rec('r5-setup: state was really filled before reload', !isFresh(before5) && before5.buy.length === 3 && before5.sell.length === 2 && before5.roles.length === 2 && before5.kits === 1 && before5.tab === 'sell' && before5.search === 'bib', before5);
  await page.reload();
  const after5 = await freshState();
  rec('r5-reload: everything cleared (carts, roles, kits, Buy tab, search, code fields, totals, storage)', isFresh(after5), after5);
  const kitForm = await E(() => { handleBuyItem({ name: 'Player Kit' }); const r = { token: document.getElementById('kitTokenToggle').checked, allIncluded: [...document.querySelectorAll('input[data-omit]')].every(c => c.checked), slotLabels: [...document.querySelectorAll('#kitFields select')].map(x => x.options[x.selectedIndex]?.textContent), title: document.querySelector('.kit-box h3').textContent }; closeKitPanel(); return r; });
  rec('r5-reload: kit form fresh (token off, every Include checked, "- -" slots)', !kitForm.token && kitForm.allIncluded && kitForm.slotLabels.slice(0, 16).every(l => l === '- -'), kitForm);
  // order code still works after the refresh
  await E(c => { document.getElementById('orderCodeIn').value = c; document.getElementById('loadCodeBtn').click(); }, code5);
  const loaded5 = await E(() => ({ toast: document.getElementById('toast').textContent, cart: JSON.parse(JSON.stringify(buyCart)), kit: kitConfigs[0] && { name: kitConfigs[0].name, token: kitConfigs[0].token, bandages: kitConfigs[0].bandages.omitted, morphine: kitConfigs[0].morphine.omitted, weapon1: kitConfigs[0].weapon1.item }, struck: [...document.querySelectorAll('#kitSummaryBox .kit-omitted')].map(d => d.textContent), header: document.querySelector('#buySummaryWrap .summary-header').textContent }));
  rec('r5-code: order code generated before refresh rebuilds the order after it (incl. token kit + omissions)', loaded5.toast === 'Order loaded' && loaded5.cart.M4A1?.qty === 2 && loaded5.cart['Trader Truck']?.qty === 1 && loaded5.cart['Player Kit 1']?.base === 0 && loaded5.kit?.bandages === true && loaded5.kit?.morphine === true && loaded5.kit?.weapon1 === 'M4A1' && loaded5.struck.join() === 'Bandages ×2,Morphine' && /257,000/.test(loaded5.header), loaded5);
  // ...and a loaded order is itself cleared by the next refresh
  await page.reload();
  rec('r5-reload: a loaded order is cleared by the next refresh', isFresh(await freshState()), null);
  // old users' stored state is wiped
  await E(() => { localStorage.setItem('935calc', JSON.stringify({ buyCart: { 'Desert Hunter': { qty: 1, base: 600, salePrice: null } }, sellCart: { Bible: { qty: 2, base: 10000 } }, activeRoles: ['Hotshot', 'Nonexistent Role'], kitConfigs: [{ name: 'Player Kit 1' }] })); localStorage.setItem('unrelated-key', 'keep'); });
  consoleErrors = []; await page.reload();
  const oldUser = await freshState(); const unrelated = await E(() => localStorage.getItem('unrelated-key'));
  rec('r5-storage: previously saved state from older versions is ignored and deleted; unrelated keys untouched', isFresh(oldUser) && unrelated === 'keep' && consoleErrors.length === 0, { ls: oldUser.ls, unrelated, consoleErrors });
  await E(() => localStorage.setItem('935calc', '{corrupt'));
  consoleErrors = []; await page.reload();
  rec('r5-storage: corrupt stored state does not crash and is deleted', consoleErrors.length === 0 && isFresh(await freshState()), consoleErrors);
  // nothing gets written while using the app
  await fillEverything(); const lsDuring = await E(() => Object.keys(localStorage).filter(k => k.startsWith('935calc')));
  rec('r5-storage: app writes nothing to localStorage while in use', lsDuring.length === 0, lsDuring);
  // back/forward cache + pageshow
  await page.goto('about:blank'); await page.goBack();
  rec('r5-bfcache: back navigation lands fresh', isFresh(await freshState()), await freshState());
  await fillEverything();
  await E(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  rec('r5-bfcache: pageshow (persisted:true) resets everything', isFresh(await freshState()), await freshState());
  const ac = await E(() => { handleBuyItem({ name: 'Player Kit' }); const r = [...document.querySelectorAll('input, select')].filter(el => el.getAttribute('autocomplete') !== 'off').map(el => el.id || el.dataset.slot || el.dataset.omit || el.type); closeKitPanel(); return r; });
  rec('r5-autocomplete: every input/select (incl. kit form) has autocomplete="off"', ac.length === 0, ac);

  // R5b. Drink slot = Canteen only
  await fresh();
  const drink = await E(() => {
    const o = {}; handleBuyItem({ name: 'Player Kit' }); const d = document.querySelector('select[data-slot="drink"]');
    o.opts = [...d.options].map(x => x.textContent); o.value = d.value; o.disabled = d.disabled; saveKit(); o.saved = kitConfigs[0].drink.item;
    o.summaryLine = [...document.querySelectorAll('#kitSummaryBox div')].map(x => x.textContent).find(t => t.startsWith('Drink:'));
    handleBuyItem({ name: 'Ghillie Kit' }); o.ghillieOpts = [...document.querySelector('select[data-slot="drink"]').options].map(x => x.textContent); closeKitPanel();
    o.shopHasFilteringBottle = flattenBuyItems(buyitems).find(i => i && i.name === 'Filtering Bottle')?.price ?? null;
    buyCart = {}; addToCart('buy', 'Filtering Bottle', 1, 1000); o.shopAdd = buyCart['Filtering Bottle']?.qty;
    const load = c => { document.getElementById('orderCodeIn').value = c; document.getElementById('loadCodeBtn').click(); return document.getElementById('toast').textContent; };
    o.oldCodeToast = load(btoa(JSON.stringify({ v: 2, cart: { 'Player Kit 1': { qty: 1, base: 16000, salePrice: null }, 'Filtering Bottle': { qty: 1, base: 1000, salePrice: null } }, kits: [{ name: 'Player Kit 1', token: false, drink: { item: 'Filtering Bottle' } }] })));
    o.oldCodeDrink = kitConfigs[0]?.drink.item; o.oldCodeShopItem = buyCart['Filtering Bottle']?.qty;
    o.emptyDrinkToast = load(btoa(JSON.stringify({ v: 2, cart: { 'Player Kit 1': { qty: 1, base: 16000, salePrice: null } }, kits: [{ name: 'Player Kit 1', drink: { item: '- -' } }] })));
    o.emptyDrink = kitConfigs[0]?.drink.item;
    buyCart = {}; kitConfigs = []; renderKitSummaries(); return o;
  });
  rec('r5-drink: kit Drink offers only Canteen, preselected and fixed; saved/summary "Drink: Canteen" (Player + Ghillie)', JSON.stringify(drink.opts) === '["Canteen"]' && drink.value === 'Canteen' && drink.disabled && drink.saved === 'Canteen' && drink.summaryLine === 'Drink: Canteen' && JSON.stringify(drink.ghillieOpts) === '["Canteen"]', drink);
  rec('r5-drink: Filtering Bottle still a shop item (1,000) and addable', drink.shopHasFilteringBottle === 1000 && drink.shopAdd === 1, { price: drink.shopHasFilteringBottle, added: drink.shopAdd });
  rec('r5-drink: old code with Filtering Bottle (or "- -") kit drink loads as Canteen; shop Filtering Bottle line kept', drink.oldCodeToast === 'Order loaded' && drink.oldCodeDrink === 'Canteen' && drink.oldCodeShopItem === 1 && drink.emptyDrink === 'Canteen', { toast: drink.oldCodeToast, drink: drink.oldCodeDrink, shopLine: drink.oldCodeShopItem, emptyDrink: drink.emptyDrink });

  // R6. Bandana in shop (Face, same price as Keffiyeh) and kit (Goggles slot)
  await fresh();
  const band = await E(() => {
    const o = {}; const all = flattenBuyItems(buyitems).filter(i => i && i.name);
    const k = all.find(i => i.name === 'Keffiyeh'), b = all.find(i => i.name === 'Bandana');
    o.keff = k && { price: k.price, bulk: k.bulkOptions || null, inStock: k.inStock }; o.band = b && { price: b.price, bulk: b.bulkOptions || null, inStock: b.inStock };
    o.face = buyitems.Clothing.Face.map(i => i.name); o.count = all.filter(i => i.name === 'Bandana').length;
    o.roleRefs = Object.entries(roles).filter(([, r]) => JSON.stringify(r).includes('Bandana') || JSON.stringify(r).includes('Keffiyeh')).map(([n]) => n);
    // via UI: Clothing > Face > Bandana
    buyCart = {}; buyPath = ['Clothing', 'Face']; render(); const btn = [...document.querySelectorAll('#buyGrid .item-btn')].find(x => x.textContent === 'Bandana'); btn && btn.click(); o.uiAdd = JSON.parse(JSON.stringify(buyCart));
    o.line = document.querySelector('#buySummary .price')?.textContent;
    buyPath = []; searchTerm = 'banda'; render(); o.search = [...document.querySelectorAll('#buyGrid .item-btn')].map(x => x.textContent); searchTerm = ''; render();
    // kit
    handleBuyItem({ name: 'Player Kit' }); const g = document.querySelector('select[data-slot="face"]'); o.kitOpts = [...g.options].map(x => x.textContent); g.value = 'Bandana'; saveKit(); o.kitSaved = kitConfigs[0].face.item;
    o.kitLine = [...document.querySelectorAll('#kitSummaryBox div')].map(x => x.textContent).find(t => t.startsWith('Face:'));
    handleBuyItem({ name: 'Ghillie Kit' }); o.ghillieOpts = [...document.querySelector('select[data-slot="face"]').options].map(x => x.textContent); closeKitPanel();
    o.kitPrice = buyCart['Player Kit 1']?.base;
    // order-code round trip (shop Bandana line + kit with Bandana)
    addToCart('buy', 'Bandana', 2, 500);
    document.getElementById('genCodeBtn').click(); const code = document.getElementById('orderCodeOut').value;
    const before = JSON.stringify(buyCart); buyCart = {}; kitConfigs = []; renderKitSummaries();
    document.getElementById('orderCodeIn').value = code; document.getElementById('loadCodeBtn').click();
    o.rt = { toast: document.getElementById('toast').textContent, same: JSON.stringify(buyCart) === before, cart: JSON.parse(JSON.stringify(buyCart)), kitGoggles: kitConfigs[0]?.face.item, header: document.querySelector('#buySummaryWrap .summary-header').textContent };
    const tam = btoa(JSON.stringify({ Bandana: { qty: 1, base: 1, salePrice: null } })); document.getElementById('orderCodeIn').value = tam; document.getElementById('loadCodeBtn').click(); o.tamperBase = buyCart.Bandana?.base;
    buyCart = {}; kitConfigs = []; renderKitSummaries(); return o;
  });
  rec('r6-bandana-shop: "Bandana" in Clothing > Face next to Keffiyeh, price == Keffiyeh (500), same bulk/stock flags, single entry', band.band && band.band.price === band.keff.price && band.band.price === 500 && band.band.bulk === band.keff.bulk && band.band.inStock === band.keff.inStock && band.face.join() === 'Bandana,Keffiyeh' && band.count === 1, { keff: band.keff, band: band.band, face: band.face });
  rec('r6-bandana-shop: addable via category UI and search; line shows 500 Cr', band.uiAdd.Bandana?.qty === 1 && band.uiAdd.Bandana?.base === 500 && band.line === '500 Cr' && band.search.includes('Bandana'), { uiAdd: band.uiAdd, line: band.line, search: band.search });
  rec('r6-bandana-kit: Bandana option in kit Face slot (Player + Ghillie); saves and shows; kit price unchanged', band.kitOpts.includes('Bandana') && band.ghillieOpts.includes('Bandana') && band.kitSaved === 'Bandana' && band.kitLine === 'Face: Bandana' && band.kitPrice === 16000, { kitOpts: band.kitOpts, ghillieOpts: band.ghillieOpts, saved: band.kitSaved, line: band.kitLine, kitPrice: band.kitPrice });
  rec('r6-bandana-code: order code round-trips shop Bandana x3 and kit Bandana; tampered Bandana price re-priced to 500', band.rt.toast === 'Order loaded' && band.rt.same && band.rt.cart.Bandana?.qty === 3 && band.rt.kitGoggles === 'Bandana' && band.tamperBase === 500, band.rt);
  rec('r6-info: roles referencing Keffiyeh/Bandana', band.roleRefs.length === 0, band.roleRefs);

  // R7. Head / Goggles / Face slots + NVG rule
  await fresh();
  const r7 = await E(() => {
    const o = {}; const q = k => document.querySelector(`select[data-slot="${k}"]`); const opts = k => [...q(k).options].map(x => x.value);
    const rowLabels = () => [...document.querySelectorAll('#kitFields .kit-row')].map(r => r.querySelector('label')?.textContent).filter(Boolean);
    const setHead = v => { q('helmet').value = v; q('helmet').dispatchEvent(new Event('change')); };
    const hintShown = () => getComputedStyle(document.getElementById('nvgHint')).display !== 'none';
    for (const ghillie of [false, true]) {
      const t = ghillie ? 'ghillie' : 'player'; handleBuyItem({ name: ghillie ? 'Ghillie Kit' : 'Player Kit' });
      const labels = rowLabels(); const gi = labels.indexOf('Goggles');
      o[t] = { head: opts('helmet'), goggles: opts('goggles'), face: opts('face'), labels, faceAfterGoggles: labels[gi + 1] === 'Face', faceDefault: q('face').options[q('face').selectedIndex].textContent, gogglesInitiallyEnabled: !q('goggles').disabled, hintInitially: hintShown() };
      // NVG lock / unlock
      q('goggles').value = 'Ski Goggles'; setHead('Boonie Hat + NVG Strap');
      o[t].lock = { disabled: q('goggles').disabled, value: q('goggles').value, label: q('goggles').options[q('goggles').selectedIndex]?.textContent, hint: hintShown(), hintText: document.getElementById('nvgHint').textContent };
      setHead('Tactical Helm + NV Goggles'); o[t].lockNV = q('goggles').disabled;
      setHead('Bandana'); o[t].unlockBandana = { disabled: q('goggles').disabled, hint: hintShown() };
      q('goggles').value = 'Dust Goggles'; setHead('Keffiyeh'); o[t].unlockKeep = { disabled: q('goggles').disabled, value: q('goggles').value };
      setHead('(select)'); o[t].unlockNone = !q('goggles').disabled;
      o[t].nvgHeads = o[t].head.filter(h => h !== '(select)' && /NVG|NV Goggles/.test(h)); o[t].nonNvgHeads = o[t].head.filter(h => h !== '(select)' && !/NVG|NV Goggles/.test(h));
      // save: Head Bandana + Goggles Dust + Face Bandana (same item twice allowed)
      setHead('Bandana'); q('goggles').value = 'Dust Goggles'; q('face').value = 'Bandana'; saveKit();
      // second kit with NVG head: goggles saved "- -", definitions note
      handleBuyItem({ name: ghillie ? 'Ghillie Kit' : 'Player Kit' }); q('goggles').value = 'Tac Goggles'; setHead('Assault Helmet + NVG Strap'); q('face').value = 'Keffiyeh'; saveKit();
    }
    o.saved = kitConfigs.map(k => [k.name, k.helmet.item, k.goggles.item, k.face.item]);
    o.defs = [...document.querySelectorAll('#kitSummaryBox div > div')].map(x => x.textContent).filter(t => /^(Head|Goggles|Face|Helmet):/.test(t));
    o.prices = Object.fromEntries(Object.entries(buyCart).map(([n, v]) => [n, v.base]));
    o.shop = ['Keffiyeh', 'Bandana', 'Dust Goggles'].map(n => [n, flattenBuyItems(buyitems).find(i => i && i.name === n)?.price]);
    // round-trip
    document.getElementById('genCodeBtn').click(); const code = document.getElementById('orderCodeOut').value;
    const before = JSON.stringify({ c: buyCart, k: kitConfigs }); buyCart = {}; kitConfigs = []; renderKitSummaries();
    document.getElementById('orderCodeIn').value = code; document.getElementById('loadCodeBtn').click();
    o.rt = { toast: document.getElementById('toast').textContent, same: JSON.stringify({ c: buyCart, k: kitConfigs }) === before };
    // old codes
    const load = kit => { document.getElementById('orderCodeIn').value = btoa(JSON.stringify({ v: 2, cart: { 'Player Kit 1': { qty: 1, base: 16000, salePrice: null } }, kits: [Object.assign({ isGhillie: false, token: false, name: 'Player Kit 1' }, kit)] })); document.getElementById('loadCodeBtn').click(); const k = kitConfigs[0] || {}; return { toast: document.getElementById('toast').textContent, head: k.helmet?.item, goggles: k.goggles?.item, face: k.face?.item, defs: [...document.querySelectorAll('#kitSummaryBox div > div')].map(x => x.textContent).filter(t => /^(Head|Goggles|Face|Jacket|Drink):/.test(t)), base: buyCart['Player Kit 1']?.base }; };
    o.oldBandanaGoggles = load({ helmet: { item: 'Baseball Cap + NVG Strap' }, goggles: { item: 'Bandana' } });
    o.oldBandanaNoNvg = load({ helmet: { item: '(select)' }, goggles: { item: 'Bandana' } });
    o.oldKeffGoggles = load({ goggles: { item: 'Keffiyeh' } });
    o.oldNoFace = load({ helmet: { item: 'Desert Helmet + NVG Strap' }, goggles: { item: '(select)' }, jacket: { item: 'Desert Hunter' }, drink: { item: 'Filtering Bottle' } });
    o.oldNvgWithGoggles = load({ helmet: { item: 'Boonie Hat + NVG Strap' }, goggles: { item: 'Dust Goggles' } });
    buyCart = {}; kitConfigs = []; renderKitSummaries(); return o;
  });
  const both = f => ['player', 'ghillie'].every(t => f(r7[t]));
  rec('r7-slots: Head (helmet options + Bandana, Keffiyeh), Goggles (goggles only), Face (Bandana, Keffiyeh) right after Goggles, default "- -"; Player + Ghillie',
    both(k => k.head.includes('Bandana') && k.head.includes('Keffiyeh') && k.head.includes('Boonie Hat + NVG Strap') && JSON.stringify(k.goggles) === '["(select)","Dust Goggles","Ski Goggles","Tac Goggles"]' && JSON.stringify(k.face) === '["(select)","Bandana","Keffiyeh"]' && k.faceAfterGoggles && k.faceDefault === '- -' && k.labels.includes('Head') && !k.labels.includes('Helmet')),
    { player: { head: r7.player.head, goggles: r7.player.goggles, face: r7.player.face, labels: r7.player.labels }, ghillieLabels: r7.ghillie.labels });
  rec('r7-nvg: NVG head locks Goggles to "- -" with hint; NV Goggles helm also locks (Player + Ghillie)', both(k => k.gogglesInitiallyEnabled && !k.hintInitially && k.lock.disabled && k.lock.value === '(select)' && k.lock.label === '- -' && k.lock.hint && k.lockNV), { player: r7.player.lock, ghillie: r7.ghillie.lock });
  rec('r7-nvg: Goggles re-enabled for Bandana / Keffiyeh / no headgear', both(k => !k.unlockBandana.disabled && !k.unlockBandana.hint && !k.unlockKeep.disabled && k.unlockKeep.value === 'Dust Goggles' && k.unlockNone), { player: [r7.player.unlockBandana, r7.player.unlockKeep, r7.player.unlockNone] });
  rec('r7-info: Head options with/without NVG', true, { nvg: r7.player.nvgHeads, nonNvg: r7.player.nonNvgHeads });
  rec('r7-save: same item in Head and Face allowed; NVG kit saves Goggles "- -"; Kit Definitions shows Head/Goggles/Face with "(NVG strap)" note',
    JSON.stringify(r7.saved) === JSON.stringify([['Player Kit 1', 'Bandana', 'Dust Goggles', 'Bandana'], ['Player Kit 2', 'Assault Helmet + NVG Strap', '- -', 'Keffiyeh'], ['Ghillie Kit 3', 'Bandana', 'Dust Goggles', 'Bandana'], ['Ghillie Kit 4', 'Assault Helmet + NVG Strap', '- -', 'Keffiyeh']]) && r7.defs.includes('Head: Bandana') && r7.defs.includes('Face: Bandana') && r7.defs.includes('Goggles: Dust Goggles') && r7.defs.includes('Goggles: - - (NVG strap)') && r7.defs.includes('Face: Keffiyeh') && !r7.defs.some(d => d.startsWith('Helmet:')),
    { saved: r7.saved, defs: r7.defs });
  rec('r7-prices: kits 16,000; shop Keffiyeh/Bandana/Dust Goggles 500', Object.values(r7.prices).every(p => p === 16000) && r7.shop.every(([, p]) => p === 500), { kits: r7.prices, shop: r7.shop });
  rec('r7-code: round-trip with Head/Goggles/Face + NVG kits is exact', r7.rt.toast === 'Order loaded' && r7.rt.same, r7.rt);
  rec('r7-old-code: old Goggles=Bandana/Keffiyeh moves to Face, Goggles "- -"; old helmet shown as Head', r7.oldBandanaGoggles.toast === 'Order loaded' && r7.oldBandanaGoggles.face === 'Bandana' && r7.oldBandanaGoggles.goggles === '- -' && r7.oldBandanaGoggles.defs.includes('Head: Baseball Cap + NVG Strap') && r7.oldBandanaNoNvg.face === 'Bandana' && r7.oldBandanaNoNvg.goggles === '- -' && r7.oldKeffGoggles.face === 'Keffiyeh' && r7.oldKeffGoggles.goggles === '- -', { a: r7.oldBandanaGoggles, b: r7.oldBandanaNoNvg, c: r7.oldKeffGoggles });
  rec('r7-old-code: old kit without Face gets Face "- -"; older name/drink mappings still applied', r7.oldNoFace.face === '- -' && r7.oldNoFace.defs.includes('Face: - -') && r7.oldNoFace.defs.includes('Jacket: Hunter Jacket') && r7.oldNoFace.defs.includes('Drink: Canteen') && r7.oldNoFace.base === 16000, r7.oldNoFace);
  rec('r7-old-code: old NVG head + real goggles -> Goggles "- -" (NVG rule applied on load)', r7.oldNvgWithGoggles.goggles === '- -' && r7.oldNvgWithGoggles.defs.includes('Goggles: - - (NVG strap)'), r7.oldNvgWithGoggles);
  await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(URL); await page.reload();
  await E(() => { handleBuyItem({ name: 'Player Kit' }); const h = document.querySelector('select[data-slot="helmet"]'); h.value = 'Boonie Hat + NVG Strap'; h.dispatchEvent(new Event('change')); document.querySelector('select[data-slot="face"]').value = 'Bandana'; const b = document.querySelector('.kit-box'); const r = h.closest('.kit-row').getBoundingClientRect(); b.scrollTop += r.top - b.getBoundingClientRect().top - 60; });
  await page.screenshot({ path: path.join(OUT, 'r7-375-kit-form-nvg.png') });
  await E(() => { const h = document.querySelector('select[data-slot="helmet"]'); h.value = 'Keffiyeh'; h.dispatchEvent(new Event('change')); document.querySelector('select[data-slot="goggles"]').value = 'Tac Goggles'; });
  await page.screenshot({ path: path.join(OUT, 'r7-375-kit-form-keffiyeh.png') });
  await page.setViewport({ width: 375, height: 1100, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await E(() => { saveKit(); handleBuyItem({ name: 'Ghillie Kit' }); const h = document.querySelector('select[data-slot="helmet"]'); h.value = 'Ghillie Hood + NVG Strap'; h.dispatchEvent(new Event('change')); document.querySelector('select[data-slot="face"]').value = 'Keffiyeh'; saveKit(); document.getElementById('toast').classList.remove('show'); const r = document.getElementById('kitSummaryBox').getBoundingClientRect(); window.scrollTo(0, scrollY + r.top - 10); });
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, 'r7-375-kit-definitions.png') });

  // ---------- R2. Round-2 behaviour ----------
  await fresh();
  const r2 = await E(() => {
    const o = {}; const names = flattenBuyItems(buyitems).filter(i => i && i.name).map(i => i.name);
    o.newNames = ['Hunter Jacket', 'Hunter Pants', 'CUU Jacket', 'CUU Pants'].map(n => { const it = flattenBuyItems(buyitems).find(i => i && i.name === n); return it ? [n, it.price] : [n, null]; });
    o.oldNamesLeft = document.documentElement.innerHTML.split('\n').filter(l => !/LEGACY/.test(l)).join('\n').match(/Desert CUU|Desert Hunter|AK Supressor/g); // legacy alias maps excluded
    o.jackets = buyitems.Clothing.Jackets.map(i => i.name); o.pants = buyitems.Clothing.Pants.map(i => i.name);
    o.dupNames = names.filter((n, i) => names.indexOf(n) !== i);
    buyCart = {}; ['Hunter Jacket', 'Hunter Pants', 'CUU Jacket', 'CUU Pants'].forEach(n => addToCart('buy', n, 1, 600)); o.cartLines = Object.keys(buyCart);
    o.akInCatalog = names.includes('AK Suppressor');
    handleBuyItem({ name: 'Player Kit' }); o.kitJacketOpts = [...document.querySelector('select[data-slot="jacket"]').options].map(x => x.value); o.kitPantsOpts = [...document.querySelector('select[data-slot="pants"]').options].map(x => x.value); o.kitSupOpts = [...document.querySelector('select[data-slot="suppressor1"]').options].map(x => x.value);
    o.kitSelectLabel = document.querySelector('select[data-slot="jacket"]').options[0].textContent;
    const ws = document.querySelector('select[data-slot="weapon1"]'); ws.value = 'KAM'; ws.dispatchEvent(new Event('change')); o.kamSup = document.querySelector('select[data-slot="suppressor1"]').value;
    const jk = document.querySelector('select[data-slot="jacket"]'); jk.value = 'Hunter Jacket';
    saveKit(); o.kitSaved = { jacket: kitConfigs[0].jacket.item, pants: kitConfigs[0].pants.item, weapon2: kitConfigs[0].weapon2.item, scope2: kitConfigs[0].scope2.item, sup1: kitConfigs[0].suppressor1.item };
    o.kitSummaryText = document.getElementById('kitSummaryBox').innerText; o.kitSummaryHasSelect = /\(select\)|Trader's choice/.test(o.kitSummaryText);
    o.kitSummaryTraderChoiceCount = (o.kitSummaryText.match(/: - -/g) || []).length;
    // Roadkill
    activeRoles = new Set(['Roadkill']); o.roadkill = { truck: getDiscountedPrice('Trader Truck', 250000), car: getDiscountedPrice('Trader Car', 75000), moped: getDiscountedPrice('Moped Tires', 800), carTires: getDiscountedPrice('Car Tires', 500), radiator: getDiscountedPrice('Car Radiator', 500) };
    o.roadkillKeys = Object.keys(roles.Roadkill.discounts);
    activeRoles = new Set(Object.keys(roles)); o.allRolesTruck = getDiscountedPrice('Trader Truck', 250000); activeRoles = new Set();
    // separators
    buyCart = {}; addToCart('buy', 'Trader Truck', 2, 250000); addToCart('buy', 'Box of Nails', 1, 6000);
    o.lineTexts = [...document.querySelectorAll('#buySummary .price')].map(x => x.textContent); o.headerText = document.querySelector('#buySummaryWrap .summary-header').textContent;
    calculate(); o.calcToast = document.getElementById('toast').textContent; o.codeNumeric = (() => { document.getElementById('genCodeBtn').click(); const s = document.getElementById('orderCodeOut').value; const m = s.match(/#order=([^&]*)/i); const d = JSON.parse(atob(m ? decodeURIComponent(m[1]) : s)); return typeof d.cart['Trader Truck'].base === 'number' && d.cart['Trader Truck'].base === 250000; })();
    handleBuyItem({ name: 'Player Kit' }); document.getElementById('kitTokenToggle').checked = true; saveKit(); o.tokenText = [...document.querySelectorAll('#buySummary .price')].map(x => x.textContent).find(t => /TOKEN/.test(t));
    // + button
    const plus = n => { const b = [...document.querySelectorAll('#buySummary .add-one, #sellSummary .add-one')].find(x => x.dataset.name === n); if (!b) return 'no-button'; b.click(); return 'clicked'; };
    buyCart = {}; kitConfigs = []; addToCart('buy', 'M4A1', 1, 3500); o.plusM4 = [plus('M4A1'), buyCart.M4A1.qty];
    addToCart('buy', '5.56x45', 5, 250); o.plusAmmo = [plus('5.56x45'), buyCart['5.56x45'].qty];
    handleBuyItem({ name: 'Player Kit' }); saveKit(); o.plusKit = plus('Player Kit 1');
    buyCart['Trader Car'] = { qty: 1, base: 75000, salePrice: null }; renderSummary('buy'); o.plusOOS = plus('Trader Car');
    buyCart = {}; kitConfigs = []; buyCart['Plastic Explosives'] = { qty: 1, base: 18000, salePrice: null }; renderSummary('buy'); o.plusIED = plus('Plastic Explosives');
    currentTab = 'sell'; render(); sellCart = {}; addToCart('sell', 'Tanned Leather', 8, 250); o.plusSell = [plus('Tanned Leather'), sellCart['Tanned Leather'].qty];
    doRoleTurnIn({ name: 'Syringe' }); o.plusTurnIn = plus('Syringe');
    addToCart('sell', 'Bible', 1, 10000); plus('Bible'); o.bibleAfterPlus = [sellCart.Bible.qty, document.querySelector('#sellSummaryWrap .summary-header').textContent];
    o.plusUpdatesHeader = (() => { sellCart = {}; addToCart('sell', 'Compass', 1, 250); plus('Compass'); return document.querySelector('#sellSummaryWrap .summary-header').textContent; })();
    sellCart = {}; buyCart = {}; currentTab = 'buy'; render();
    return o;
  });
  rec('r2-rename: 4 renamed items exist at 600 in correct categories', JSON.stringify(r2.newNames) === JSON.stringify([['Hunter Jacket', 600], ['Hunter Pants', 600], ['CUU Jacket', 600], ['CUU Pants', 600]]) && r2.jackets.includes('Hunter Jacket') && r2.jackets.includes('CUU Jacket') && r2.pants.includes('Hunter Pants') && r2.pants.includes('CUU Pants'), { newNames: r2.newNames, jackets: r2.jackets, pants: r2.pants });
  rec('r2-rename: no old names ("Desert CUU", "Desert Hunter", "AK Supressor") left outside the legacy alias maps', !r2.oldNamesLeft, r2.oldNamesLeft);
  rec('r2-rename: no duplicate item names in buy catalog', r2.dupNames.length === 0, r2.dupNames);
  rec('r2-rename: 4 desert items are 4 separate cart lines', r2.cartLines.length === 4, r2.cartLines);
  rec('r2-rename: kit jacket/pants/suppressor options use new names; KAM locks AK Suppressor', r2.kitJacketOpts.includes('Hunter Jacket') && r2.kitPantsOpts.includes('CUU Pants') && r2.kitSupOpts.includes('AK Suppressor') && r2.kamSup === 'AK Suppressor' && r2.akInCatalog, { jacket: r2.kitJacketOpts, pants: r2.kitPantsOpts, sup: r2.kitSupOpts, kamSup: r2.kamSup });
  rec('r2-kit: empty slots saved and shown as "- -" (no "(select)" / "Trader\'s choice")', r2.kitSaved.pants === "- -" && r2.kitSaved.weapon2 === "- -" && !r2.kitSummaryHasSelect && r2.kitSummaryTraderChoiceCount > 0, { saved: r2.kitSaved, traderChoiceLines: r2.kitSummaryTraderChoiceCount, selectLabel: r2.kitSelectLabel });
  rec('r2-roadkill: Humvee key removed; parts incl. Moped Tires keep 25%', !r2.roadkillKeys.includes('Humvee') && r2.roadkill.moped === 600 && r2.roadkill.carTires === 375 && r2.roadkill.radiator === 375, { keys: r2.roadkillKeys, prices: r2.roadkill });
  rec('r2-roadkill: no vehicle discount (Truck 250,000, Car 75,000; all roles on: Truck 250,000)', r2.roadkill.truck === 250000 && r2.roadkill.car === 75000 && r2.allRolesTruck === 250000, { truck: r2.roadkill.truck, car: r2.roadkill.car, allRoles: r2.allRolesTruck });
  rec('r2-format: separators on line prices, header, Calculate toast, token strike; order code numeric', r2.lineTexts.includes('500,000 Cr') && r2.lineTexts.includes('6,000 Cr') && /506,000 Cr/.test(r2.headerText) && /Buy: 506,000 Cr/.test(r2.calcToast) && /16,000/.test(r2.tokenText) && r2.codeNumeric, { lines: r2.lineTexts, header: r2.headerText, toast: r2.calcToast, token: r2.tokenText, codeNumeric: r2.codeNumeric });
  rec('r2-plus: + adds 1 to normal item and bulk item (min bulk option 1)', r2.plusM4[1] === 2 && r2.plusAmmo[1] === 6 && r2.plusSell[1] === 9, { m4: r2.plusM4, ammo: r2.plusAmmo, sell: r2.plusSell });
  rec('r2-plus: no + on kits, out-of-stock (Trader Car, IED parts) or role turn-in lines', r2.plusKit === 'no-button' && r2.plusOOS === 'no-button' && r2.plusIED === 'no-button' && r2.plusTurnIn === 'no-button', { kit: r2.plusKit, car: r2.plusOOS, ied: r2.plusIED, turnIn: r2.plusTurnIn });
  rec('r2-plus: + updates header live; Bible tiered total respected (2 Bibles = 30,000)', /Sell Cart — 500 Cr/.test(r2.plusUpdatesHeader) && r2.bibleAfterPlus[0] === 2, { compassHeader: r2.plusUpdatesHeader, bible: r2.bibleAfterPlus });

  // legacy order codes / storage with old names
  await fresh();
  const legacy = await E(() => {
    const o = {}; const load = c => { document.getElementById('orderCodeIn').value = c; document.getElementById('loadCodeBtn').click(); return document.getElementById('toast').textContent; };
    o.v1 = load(btoa(JSON.stringify({ 'Desert CUU': { qty: 2, base: 600, salePrice: null }, 'AK Supressor': { qty: 1, base: 1000, salePrice: null }, 'Desert Hunter': { qty: 1, base: 600, salePrice: null } })));
    o.v1Cart = JSON.parse(JSON.stringify(buyCart));
    const kit = { isGhillie: false, token: false, name: 'Player Kit 1', weapon1: { item: 'KAM' }, suppressor1: { item: 'AK Supressor' }, jacket: { item: 'Desert Hunter' }, pants: { item: 'Desert CUU' }, boots: { item: '(select)' } };
    o.v2 = load(btoa(JSON.stringify({ v: 2, cart: { 'Player Kit 1': { qty: 1, base: 16000, salePrice: null } }, kits: [kit] })));
    o.v2Kit = { jacket: kitConfigs[0]?.jacket.item, pants: kitConfigs[0]?.pants.item, sup: kitConfigs[0]?.suppressor1.item, boots: kitConfigs[0]?.boots.item };
    return o;
  });
  rec('r2-legacy: v1 code with old names loads (Desert CUU -> CUU Jacket, Desert Hunter -> Hunter Jacket, AK Supressor -> AK Suppressor)', legacy.v1 === 'Order loaded' && legacy.v1Cart['CUU Jacket']?.qty === 2 && legacy.v1Cart['Hunter Jacket']?.qty === 1 && legacy.v1Cart['AK Suppressor']?.qty === 1, legacy);
  rec('r2-legacy: v2 kit with old names maps by slot (jacket->Hunter Jacket, pants->CUU Pants)', legacy.v2Kit.jacket === 'Hunter Jacket' && legacy.v2Kit.pants === 'CUU Pants' && legacy.v2Kit.sup === 'AK Suppressor' && legacy.v2Kit.boots === "- -", legacy.v2Kit);

  // ---------- R3. "- -" placeholders + omit is display-only ----------
  await fresh();
  const r3 = await E(() => {
    const o = {}; const sel = k => document.querySelector(`select[data-slot="${k}"]`);
    handleBuyItem({ name: 'Player Kit' });
    o.placeholderLabels = [...document.querySelectorAll('#kitFields select')].map(x => x.options[x.selectedIndex]?.textContent);
    o.anyTraderChoiceOrSelectLabel = [...document.querySelectorAll('#kitFields option')].some(op => /Trader's choice|\(select\)/.test(op.textContent));
    // price with nothing omitted vs everything omitted, paid and token
    const priceFor = (omitAll, token) => { buyCart = {}; kitConfigs = []; handleBuyItem({ name: 'Player Kit' }); if (token) document.getElementById('kitTokenToggle').checked = true; if (omitAll) document.querySelectorAll('input[data-omit]').forEach(c => c.checked = false); saveKit(); calculate(); return { base: buyCart['Player Kit 1'].base, toast: document.getElementById('toast').textContent, header: document.querySelector('#buySummaryWrap .summary-header').textContent, fixedCount: kitFixed.filter(f => kitConfigs[0][f.key]).length }; };
    o.paidNone = priceFor(false, false); o.paidAll = priceFor(true, false); o.tokNone = priceFor(false, true); o.tokAll = priceFor(true, true);
    // kit with nothing omitted
    buyCart = {}; kitConfigs = []; handleBuyItem({ name: 'Player Kit' }); saveKit();
    { const bx = document.getElementById('kitSummaryBox'); o.noOmit = { toast: document.getElementById('toast').textContent, optionalListed: kitFixed.map(f => f.label).filter(l => bx.innerText.includes(l)), slotLines: kitSlots.filter(sl => bx.innerText.includes(sl.label + ':')).length, struck: bx.querySelectorAll('.kit-omitted').length, flagsStored: kitFixed.every(f => kitConfigs[0][f.key] && kitConfigs[0][f.key].omitted === false) }; }
    // strikethrough rendering + toast fallback
    buyCart = {}; kitConfigs = []; handleBuyItem({ name: 'Player Kit' });
    document.querySelector('input[data-omit="candy"]').checked = false; document.querySelector('input[data-omit="morphine"]').checked = false; saveKit();
    o.addToast = document.getElementById('toast').textContent;
    const box = document.getElementById('kitSummaryBox');
    o.struck = [...box.querySelectorAll('.kit-omitted')].map(d => ({ t: d.textContent, deco: getComputedStyle(d).textDecorationLine, op: getComputedStyle(d).opacity }));
    o.keptListed = kitFixed.filter(f => !['candy', 'morphine'].includes(f.key)).map(f => f.label).filter(l => box.innerText.includes(l));
    o.slotLines = kitSlots.filter(sl => box.innerText.includes(sl.label + ':')).length;
    o.cartLine = document.querySelector('#buySummary .summary-item')?.textContent.replace(/\s+/g, ' ').trim();
    o.dashLines = (box.innerText.match(/: - -/g) || []).length;
    // order-code round trip
    document.getElementById('genCodeBtn').click(); const code = document.getElementById('orderCodeOut').value; const m3 = String(code).match(/#order=([^&]*)/i); const payload = JSON.parse(atob(m3 ? decodeURIComponent(m3[1]) : code));
    o.codeFlags = { candy: payload.kits[0].candy, bandages: payload.kits[0].bandages };
    buyCart = {}; kitConfigs = []; renderKitSummaries();
    document.getElementById('orderCodeIn').value = code; document.getElementById('loadCodeBtn').click();
    o.afterLoad = { toast: document.getElementById('toast').textContent, candy: kitConfigs[0]?.candy, morphine: kitConfigs[0]?.morphine, bandages: kitConfigs[0]?.bandages, struck: [...document.querySelectorAll('#kitSummaryBox .kit-omitted')].map(d => d.textContent), base: buyCart['Player Kit 1']?.base };
    // old v2 code from round 2 (Trader's choice text) and a v2 kit without omitted flags
    document.getElementById('orderCodeIn').value = btoa(JSON.stringify({ v: 2, cart: { 'Player Kit 1': { qty: 1, base: 16000, salePrice: null } }, kits: [{ name: 'Player Kit 1', token: false, weapon1: { item: "Trader's choice" }, candy: { item: 'Candy Cane' } }] }));
    document.getElementById('loadCodeBtn').click();
    o.oldCode = { toast: document.getElementById('toast').textContent, weapon1: kitConfigs[0]?.weapon1.item, candyOmitted: kitConfigs[0]?.candy.omitted, struck: document.querySelectorAll('#kitSummaryBox .kit-omitted').length };
    // set up for reload test
    buyCart = {}; kitConfigs = []; handleBuyItem({ name: 'Player Kit' }); document.querySelector('input[data-omit="saline"]').checked = false; saveKit();
    return o;
  });
  await page.reload();
  const r3reload = await E(() => ({ kits: kitConfigs.length, cart: Object.keys(buyCart), struck: document.querySelectorAll('#kitSummaryBox .kit-omitted').length }));
  rec('r3-placeholder: kit dropdown placeholders show "- -"; no "(select)"/"Trader\'s choice" labels', r3.placeholderLabels.every(l => l === '- -' || l === 'Belt + Sheath' || l === 'Canteen') && !r3.anyTraderChoiceOrSelectLabel, { labels: r3.placeholderLabels });
  rec('r3-placeholder: saved kit summary shows "- -" for empty slots', r3.dashLines > 0, { dashLines: r3.dashLines });
  rec('r3-omit: omitting all items does not change price (paid 16000, token 0) or item count', r3.paidNone.base === 16000 && r3.paidAll.base === 16000 && r3.tokNone.base === 0 && r3.tokAll.base === 0 && r3.paidNone.toast.split(' — ')[0] === r3.paidAll.toast.split(' — ')[0] && r3.paidAll.fixedCount === 13, { paidNone: r3.paidNone, paidAll: r3.paidAll, tokNone: r3.tokNone, tokAll: r3.tokAll });
  rec('r3/r4-omit: only unchecked items listed, with line-through + dimmed; kept items (e.g. Bandages) not listed; slot lines still listed', r3.struck.length === 2 && r3.struck.every(x => x.deco === 'line-through' && +x.op < 1) && r3.struck.map(x => x.t).join() === 'Candy Cane,Morphine' && r3.keptListed.length === 0 && r3.slotLines >= 17, { struck: r3.struck, keptListed: r3.keptListed, slotLines: r3.slotLines, cartLine: r3.cartLine });
  rec('r4-omit: kit with nothing omitted lists no optional items; no-omit toast has no "(omitted)"', r3.noOmit.optionalListed.length === 0 && r3.noOmit.slotLines >= 17 && !/omitted/.test(r3.noOmit.toast) && r3.noOmit.struck === 0, r3.noOmit);
  rec('r3-omit: plain-text fallback "(omitted)" in add toast', /Candy Cane \(omitted\)/.test(r3.addToast) && /Morphine \(omitted\)/.test(r3.addToast), r3.addToast);
  rec('r3-omit: flag in order code and survives round-trip', r3.codeFlags.candy.omitted === true && r3.codeFlags.bandages.omitted === false && r3.afterLoad.candy?.omitted === true && r3.afterLoad.morphine?.omitted === true && r3.afterLoad.bandages?.omitted === false && r3.afterLoad.struck.join() === 'Candy Cane,Morphine' && r3.afterLoad.base === 16000, { code: r3.codeFlags, afterLoad: r3.afterLoad });
  rec('r3-omit: old codes load ("Trader\'s choice" -> "- -", missing omit flag = not struck)', r3.oldCode.toast === 'Order loaded' && r3.oldCode.weapon1 === '- -' && !r3.oldCode.candyOmitted && r3.oldCode.struck === 0, r3.oldCode);
  rec('r3/r5-omit: kit with omissions is cleared by reload (order code is the way to keep it)', r3reload.kits === 0 && r3reload.cart.length === 0 && r3reload.struck === 0, r3reload);

  // screenshot: kit summary + cart at 375
  await page.setViewport({ width: 375, height: 1100, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(URL); await E(() => localStorage.clear()); await page.reload();
  await E(() => { addToCart('buy', 'Hunter Jacket', 1, 600); handleBuyItem({ name: 'Player Kit' }); const w = document.querySelector('select[data-slot="weapon1"]'); w.value = 'M4A1'; w.dispatchEvent(new Event('change')); ['bandages', 'morphine'].forEach(k => document.querySelector(`input[data-omit="${k}"]`).checked = false); saveKit(); document.getElementById('toast').classList.remove('show'); const r = document.getElementById('buySummaryWrap').getBoundingClientRect(); window.scrollTo(0, scrollY + r.top - 10); });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, 'r4-375-kit-summary.png') });

  // toast placement vs last cart row
  await fresh();
  await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.reload();
  const toastCover = await E(async () => {
    buyPath = ['Vehicles', 'Tires']; render();
    ['Car Tires', 'Humvee Tires', 'Moped Tires', 'Truck Tires', 'Motorbike Tires', 'Car Battery'].forEach(n => addToCart('buy', n, 1, 500));
    const rows = document.querySelectorAll('#buySummary .summary-item'); const last = rows[rows.length - 1];
    const res = [];
    for (const y of [0, 150, 300, 450]) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 50)); addToCart('buy', 'Car Tires', 1, 500); const t = document.getElementById('toast').getBoundingClientRect(); const l = last.getBoundingClientRect(); res.push({ scrollY: Math.round(scrollY), toast: [Math.round(t.top), Math.round(t.bottom)], lastRow: [Math.round(l.top), Math.round(l.bottom)], overlap: !(t.bottom <= l.top || t.top >= l.bottom) }); }
    return res;
  });
  await page.screenshot({ path: path.join(OUT, 'r2-375-toast.png') });
  rec('r2-toast: toast does not cover last cart row (cart scrolled near bottom of screen)', toastCover.filter(x => x.lastRow[1] > 400 && x.lastRow[0] < 600).every(x => !x.overlap), toastCover);

  // ---------- 13. Mobile 375px ----------
  await fresh();
  await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.reload();
  async function mobileAudit(label) {
    return E((label) => {
      const vw = document.documentElement.clientWidth; const o = { label, vw, scrollW: document.documentElement.scrollWidth };
      const overflow = []; const small = []; const clipped = [];
      document.querySelectorAll('button, input, select, .breadcrumb span').forEach(el => {
        const r = el.getBoundingClientRect(); if (!r.width || getComputedStyle(el).display === 'none' || el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return;
        const name = (el.id ? '#' + el.id : el.className) + ' "' + (el.textContent || el.placeholder || '').trim().slice(0, 24) + '"';
        let scroller = false; let p = el.parentElement;
        while (p) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll') { scroller = true; break; } p = p.parentElement; }
        if (!scroller && (r.right > vw + 0.5 || r.left < -0.5)) overflow.push(name + ' ' + Math.round(r.left) + '-' + Math.round(r.right));
        let tr = r; if (el.type === 'checkbox' && el.closest('label')) tr = el.closest('label').getBoundingClientRect(); // label is the hit area
        if (el.tagName === 'BUTTON' || el.tagName === 'SELECT' || el.tagName === 'INPUT') if (tr.height < 43.5 || tr.width < 43.5) small.push(name + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        if (el.id !== 'orderCodeOut' && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') clipped.push(name); // long code in a one-line input is expected
      });
      o.overflow = overflow; o.smallTargets = small; o.clipped = clipped;
      const bb = document.querySelector('.dock').getBoundingClientRect(); o.bottomBar = { top: Math.round(bb.top), h: Math.round(bb.height) };
      return o;
    }, label);
  }
  const m = [];
  m.push(await mobileAudit('home')); await page.screenshot({ path: path.join(OUT, 'm375-home.png'), fullPage: true });
  await E(() => { buyPath = ['Clothing', 'Plate Carriers']; render(); for (let i = 0; i < 3; i++) addToCart('buy', 'Plate Carrier (Desert)', 1, 2000); addToCart('buy', 'Trader Truck', 3, 250000); addToCart('buy', 'Red Dot (Baraka)', 1, 300); activeRoles.add('Click Click Boom'); render(); });
  m.push(await mobileAudit('cart')); await page.screenshot({ path: path.join(OUT, 'm375-cart.png'), fullPage: true });
  await E(() => handleBuyItem({ name: 'Player Kit' }));
  m.push(await mobileAudit('kit-panel')); await page.screenshot({ path: path.join(OUT, 'm375-kit.png') });
  const kitScroll = await E(() => { const b = document.querySelector('.kit-box'); const r = b.getBoundingClientRect(); return { boxH: Math.round(r.height), vh: innerHeight, scrollable: b.scrollHeight > b.clientHeight, overflowY: getComputedStyle(b).overflowY, saveVisible: document.querySelector('.kit-save').getBoundingClientRect().bottom <= innerHeight }; });
  await E(() => { closeKitPanel(); document.getElementById('genCodeBtn').click(); });
  m.push(await mobileAudit('code')); 
  await E(() => { addToCart('buy', 'Plate Carrier (Black)', 1, 2000); }); // toast
  const toastBox = await E(() => { const t = document.getElementById('toast'); const r = t.getBoundingClientRect(); const bb = document.querySelector('.dock').getBoundingClientRect(); return { toast: [Math.round(r.top), Math.round(r.bottom)], bottomBarTop: Math.round(bb.top), overlapsBottomBar: r.bottom > bb.top }; });
  await E(() => { addToCart('buy', 'Gloves', 1, 250); }); // ensure last item is visible above the dock
  const lastItemHidden = await E(() => { window.scrollTo(0, document.body.scrollHeight); const nodes = document.querySelectorAll('#buyGrid .row, #sellGrid .row'); const last = (nodes.length ? nodes[nodes.length - 1] : document.querySelector('#buyGrid')).getBoundingClientRect(); const bb = document.querySelector('.dock').getBoundingClientRect(); return { lastRoleBottom: Math.round(last.bottom), barTop: Math.round(bb.top), hidden: last.bottom > bb.top + 1 }; });
  await page.screenshot({ path: path.join(OUT, 'm375-bottom.png') });
  for (const w of [375, 420]) {
    await page.setViewport({ width: w, height: w === 375 ? 667 : 900, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(URL); await E(() => localStorage.clear()); await page.reload();
    await E(() => { buyPath = ['Clothing', 'Jackets']; render(); addToCart('buy', 'Hunter Jacket', 1, 600); addToCart('buy', 'CUU Pants', 1, 600); addToCart('buy', 'Trader Truck', 3, 250000); addToCart('buy', '5.56x45', 10, 250); activeRoles.add('Roadkill'); render(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(OUT, `r2-${w}-cart.png`), fullPage: true });
    await E(() => { document.getElementById('genCodeBtn').click(); });
    m.push(await mobileAudit(`r2-${w}-cart`));
    await E(() => { handleBuyItem({ name: 'Player Kit' }); const s = document.querySelector('select[data-slot="weapon1"]'); s.value = 'KAM'; s.dispatchEvent(new Event('change')); });
    m.push(await mobileAudit(`r2-${w}-kit`));
    await page.screenshot({ path: path.join(OUT, `r2-${w}-kit.png`) });
    await E(() => { const b = document.querySelector('.kit-box'); b.scrollTop = b.scrollHeight; });
    await page.screenshot({ path: path.join(OUT, `r2-${w}-kit-bottom.png`) });
    await E(() => { document.querySelector('.kit-save').click(); window.scrollTo(0, 400); });
    await page.screenshot({ path: path.join(OUT, `r2-${w}-kitsummary.png`) });
  }
  rec('mobile375: no horizontal overflow', m.every(x => x.scrollW <= x.vw && x.overflow.length === 0), m.map(x => ({ l: x.label, scrollW: x.scrollW, overflow: x.overflow })));
  rec('mobile375: tap targets >= 44x44', m.every(x => x.smallTargets.length === 0), m.map(x => ({ l: x.label, small: x.smallTargets })));
  rec('mobile375: no clipped text', m.every(x => x.clipped.length === 0), m.map(x => ({ l: x.label, clipped: x.clipped })));
  rec('mobile375: kit panel fits/scrolls, Add Kit reachable', kitScroll.saveVisible || kitScroll.scrollable, kitScroll);
  rec('mobile375: page bottom not hidden under fixed bottom bar', !lastItemHidden.hidden, lastItemHidden);
  rec('mobile375: info — toast position vs bottom bar', true, toastBox);


  // ---------- 7b. Shareable order links ----------
  await fresh();
  const shareBuilt = await E(() => {
    buyCart = {}; kitConfigs = [];
    addToCart('buy', 'M4A1', 2, 3500);
    addToCart('buy', 'Trader Truck', 1, 250000);
    handleBuyItem({ name: 'Player Kit' });
    const w = document.querySelector('select[data-slot="weapon1"]'); w.value = 'M4A1'; w.dispatchEvent(new Event('change'));
    document.getElementById('kitTokenToggle').checked = true;
    saveKit();
    document.getElementById('genCodeBtn').click();
    return {
      link: document.getElementById('orderCodeOut').value,
      toast: document.getElementById('toast').textContent,
      cart: JSON.parse(JSON.stringify(buyCart)),
      kits: JSON.parse(JSON.stringify(kitConfigs))
    };
  });
  const SHARE_BASE = 'https://dayz-group-935.github.io/traderv3/';
  rec('share: generated link uses the canonical production URL with #order=', typeof shareBuilt.link === 'string' && shareBuilt.link.startsWith(SHARE_BASE + '#order=') && !shareBuilt.link.includes('file:'), shareBuilt.link.slice(0, 160));

  const shareHash = '#' + String(shareBuilt.link).split('#').slice(1).join('#');
  // Same-document hash changes are ignored (existing carts are not replaced). Go via about:blank so this is a fresh open.
  await page.goto('about:blank');
  await page.goto(URL + shareHash, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const t = document.getElementById('toast');
    return !!t && (t.textContent === 'Order loaded' || t.textContent === 'Invalid code');
  }, { timeout: 5000 });
  const opened = await E(() => ({
    hash: location.hash,
    href: location.href,
    toast: document.getElementById('toast').textContent,
    cart: JSON.parse(JSON.stringify(buyCart)),
    kits: JSON.parse(JSON.stringify(kitConfigs))
  }));
  rec('share: opening the link restores buy quantities and the token kit, then clears the fragment',
    opened.toast === 'Order loaded' && opened.hash === '' && !/#/.test(opened.href) &&
    opened.cart.M4A1?.qty === 2 && opened.cart['Trader Truck']?.qty === 1 &&
    opened.cart['Player Kit 1']?.base === 0 && opened.kits[0]?.token === true && opened.kits[0]?.weapon1?.item === 'M4A1',
    opened);

  await page.reload({ waitUntil: 'load' });
  const afterShareReload = await E(() => ({ hash: location.hash, buy: Object.keys(buyCart), kits: kitConfigs.length }));
  rec('share: after the fragment is cleared, a refresh leaves the calculator empty',
    afterShareReload.hash === '' && afterShareReload.buy.length === 0 && afterShareReload.kits === 0, afterShareReload);

  await fresh();
  const pasted = await E((link) => {
    const load = (c) => { document.getElementById('orderCodeIn').value = c; document.getElementById('loadCodeBtn').click(); return { toast: document.getElementById('toast').textContent, cart: JSON.parse(JSON.stringify(buyCart)), kits: JSON.parse(JSON.stringify(kitConfigs)) }; };
    const o = {};
    buyCart = {}; kitConfigs = [];
    o.full = load(link);
    buyCart = {}; kitConfigs = [];
    o.hashOnly = load('#' + String(link).split('#').slice(1).join('#'));
    buyCart = {}; kitConfigs = [];
    o.v1 = load(btoa(JSON.stringify({ 'M4A1': { qty: 3, base: 1, salePrice: null } })));
    buyCart = {}; kitConfigs = [];
    o.v2 = load(btoa(JSON.stringify({ v: 2, cart: { 'Player Kit 1': { qty: 1, base: 16000, salePrice: null } }, kits: [{ name: 'Player Kit 1', token: false, weapon1: { item: 'KAM' } }] })));
    return o;
  }, shareBuilt.link);
  rec('share: a pasted production link imports the order', pasted.full.toast === 'Order loaded' && pasted.full.cart.M4A1?.qty === 2 && pasted.full.cart['Trader Truck']?.qty === 1 && pasted.full.kits[0]?.token === true && pasted.full.kits[0]?.weapon1?.item === 'M4A1', pasted.full);
  rec('share: a pasted #order= fragment imports the order', pasted.hashOnly.toast === 'Order loaded' && pasted.hashOnly.cart.M4A1?.qty === 2 && pasted.hashOnly.kits[0]?.token === true, pasted.hashOnly);
  rec('share: legacy v1 raw codes still import and re-price from the catalog', pasted.v1.toast === 'Order loaded' && pasted.v1.cart.M4A1?.qty === 3 && pasted.v1.cart.M4A1?.base === 3500, pasted.v1);
  rec('share: legacy v2 raw codes still import kit equipment', pasted.v2.toast === 'Order loaded' && pasted.v2.kits[0]?.weapon1?.item === 'KAM' && pasted.v2.cart['Player Kit 1']?.base === 16000, pasted.v2);

  await fresh();
  const bad = await E(() => {
    addToCart('buy', 'M4A1', 1, 3500);
    const before = JSON.stringify(buyCart);
    const load = (c) => { document.getElementById('orderCodeIn').value = c; document.getElementById('loadCodeBtn').click(); return { toast: document.getElementById('toast').textContent, same: JSON.stringify(buyCart) === before, cart: JSON.parse(JSON.stringify(buyCart)) }; };
    const wrap = payload => 'https://dayz-group-935.github.io/traderv3/#order=' + encodeURIComponent(payload);
    return {
      malformedLink: load(wrap('%%%')),
      noOrderHash: load('https://dayz-group-935.github.io/traderv3/#nope=abc'),
      badJson: load(wrap(btoa('hello'))),
      unknown: load(wrap(btoa(JSON.stringify({ 'Free Money': { qty: 1, base: 1, salePrice: null } })))),
      badQty: load(wrap(btoa(JSON.stringify({ v: 2, cart: { M4A1: { qty: 0, base: 3500, salePrice: null } }, kits: [] })))),
      negQty: load(wrap(btoa(JSON.stringify({ v: 2, cart: { M4A1: { qty: -2, base: 3500, salePrice: null } }, kits: [] }))))
    };
  });
  rec('share: malformed, unknown-item, and bad-quantity links are rejected and leave the cart unchanged',
    [bad.malformedLink, bad.noOrderHash, bad.badJson, bad.unknown, bad.badQty, bad.negQty].every(x => x.toast === 'Invalid code' && x.same && x.cart.M4A1?.qty === 1), bad);

  await fresh();
  const noHashChange = await E(() => {
    addToCart('buy', 'M4A1', 4, 3500);
    const before = JSON.stringify(buyCart);
    const payload = encodeURIComponent(btoa(JSON.stringify({ v: 2, cart: { 'Trader Truck': { qty: 1, base: 250000, salePrice: null } }, kits: [] })));
    history.pushState(null, '', location.href.split('#')[0] + '#order=' + payload);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return { same: JSON.stringify(buyCart) === before, cart: JSON.parse(JSON.stringify(buyCart)), hash: location.hash };
  });
  rec('share: a later hash change does not replace an existing cart', noHashChange.same && noHashChange.cart.M4A1?.qty === 4, noHashChange);

  rec('console: errors/uncaught exceptions during whole run (incl. intentional malformed tests)', true, { count: consoleErrors.length, first: consoleErrors.slice(0, 5) });
  await browser.close();
  const pass = results.filter(r => r.pass).length;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ file: FILE, when: new Date().toString(), pass, fail: results.length - pass, results }, null, 2));
  console.log(`\n${pass}/${results.length} passed`);
})().catch(e => { console.error(e); process.exit(1); });
