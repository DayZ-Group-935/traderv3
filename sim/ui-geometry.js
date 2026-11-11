// Layout regressions for Concept C on the working calculator.
// Asserts geometry; does not weaken catalog, price, or share checks in sim.js.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = 'file://' + FILE;
const OUT = process.env.OUT || path.join(__dirname, 'out', 'geometry');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
function check(id, ok, detail) {
  if (!ok) fails.push({ id, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''));
}

async function boot(browser, width) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'load' });
  await sleep(80);
  return { page, errors };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none']
  });

  for (const width of [375, 390, 430]) {
    const { page, errors } = await boot(browser, width);
    const browse = await page.evaluate(() => {
      const banner = document.querySelector('.hero').getBoundingClientRect();
      const clickCat = (name) => {
        const b = [...document.querySelectorAll('#buyGrid .cat-btn')].find(x => x.textContent.trim() === name);
        if (b) b.click();
      };
      clickCat('Weapons');
      clickCat('Weapons');
      const rows = [...document.querySelectorAll('#buyGrid .row')];
      const names = rows.map(r => r.querySelector('.nm')?.textContent.trim()).filter(Boolean);
      const wide = rows.filter(r => r.querySelector('.ic.ic-wide, .has-wide')).length;
      const uses = [...document.querySelectorAll('#buyGrid .item-btn .ic use')].map(u => u.getAttribute('href'));
      const missing = uses.filter(h => !h || !document.getElementById(h.slice(1)));
      const docW = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const overflow = [...document.querySelectorAll('.app *')].filter(el => {
        if (el.closest('.hero-mark')) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (!r.width || st.display === 'none' || st.visibility === 'hidden') return false;
        if (st.overflowX === 'auto' || st.overflowX === 'scroll') return false;
        let p = el.parentElement;
        while (p) {
          const ps = getComputedStyle(p);
          if (ps.overflowX === 'hidden' || ps.overflow === 'hidden') return false;
          p = p.parentElement;
        }
        return r.right > innerWidth + 1 || r.left < -1;
      }).slice(0, 6).map(el => el.tagName + '.' + String(el.className).split(' ')[0]);
      const small = [...document.querySelectorAll('.tab-btn, #search, .cat-btn, .item-btn .adder, .sheet-close')].filter(el => {
        const r = el.getBoundingClientRect();
        if (!r.width) return false;
        return r.width < 43.5 || r.height < 43.5;
      }).map(el => ({ t: el.id || el.textContent.trim().slice(0, 24), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }));
      // 6–7 item rows in the first 844px viewport (banner + tool + chips + dock)
      const visibleRows = rows.filter(r => {
        const b = r.getBoundingClientRect();
        return b.top >= 0 && b.bottom <= 844 && b.height > 40;
      }).length;
      return {
        banner: Math.round(banner.height),
        rows: rows.length, visibleRows, names: names.slice(0, 8), wide,
        missing: missing.length, docW, overflow, small,
        release: document.body.dataset.release
      };
    });
    check(`banner-136@${width}`, browse.banner === 136, browse.banner);
    check(`weapons-rows@${width}`, browse.rows >= 6 && browse.wide >= 6, { rows: browse.rows, wide: browse.wide, names: browse.names });
    check(`icons-resolve@${width}`, browse.missing === 0, browse.missing);
    check(`no-page-overflow@${width}`, browse.docW <= 1 && browse.overflow.length === 0, { docW: browse.docW, overflow: browse.overflow });
    check(`targets-44@${width}`, browse.small.length === 0, browse.small);
    check(`release@${width}`, browse.release === 'c-balanced-2026-11-11', browse.release);
    check(`row-count-aim@${width}`, browse.visibleRows >= 6 && browse.visibleRows <= 8, browse.visibleRows);
    await page.screenshot({ path: path.join(OUT, `browse-${width}.png`) });

    // add two weapons, open the order sheet, check +/- and roles
    await page.evaluate(() => {
      const clickItem = (name) => {
        const b = [...document.querySelectorAll('#buyGrid .item-btn')].find(x => (x.querySelector('.nm')?.textContent || '').replace(/\*/g, '').trim() === name);
        if (b) b.click();
      };
      clickItem('M4A1');
      clickItem('Aug AX');
      document.getElementById('codeSheetBtn').click();
    });
    await sleep(80);
    const order = await page.evaluate(() => {
      const header = document.querySelector('#buySummaryWrap .summary-header').textContent;
      const lines = [...document.querySelectorAll('#buySummary .summary-item .price')].map(p => p.textContent);
      const before = header;
      const plus = document.querySelector('#buyGrid .row.is-in .stepper .hit[aria-label^="Increase M4A1"]');
      // sheet is open; the roster stepper may be underneath. Use summary add-one.
      const add = document.querySelector('#buySummary .add-one[data-name="M4A1"]');
      if (add) add.click();
      const after = document.querySelector('#buySummaryWrap .summary-header').textContent;
      const qty = buyCart.M4A1 && buyCart.M4A1.qty;
      const roles = [...document.querySelectorAll('.role-btn')];
      const body = document.querySelector('.sheet-body');
      const block = document.querySelector('.roles-block, .roles-section');
      if (body && block) body.scrollTop = block.offsetTop - 8;
      const grid = document.querySelector('.roles-grid');
      const cs = getComputedStyle(grid);
      const widths = roles.map(el => +el.getBoundingClientRect().width.toFixed(1));
      const heights = roles.map(el => +el.getBoundingClientRect().height.toFixed(1));
      const smallRoles = roles.filter(el => el.getBoundingClientRect().height < 43.5 || el.getBoundingClientRect().width < 43.5).map(el => el.textContent.trim());
      const cols = cs.gridTemplateColumns.trim().split(/\s+/).length;
      return {
        before, after, lines, qty, plus: !!plus,
        roleCount: roles.length, cols,
        widthSpan: widths.length ? +(Math.max(...widths) - Math.min(...widths)).toFixed(2) : null,
        heightSpan: heights.length ? +(Math.max(...heights) - Math.min(...heights)).toFixed(2) : null,
        smallRoles
      };
    });
    check(`totals-plus@${width}`, order.qty === 2 && /10,000/.test(order.after) && order.plus, order);
    check(`roles-2col@${width}`, order.cols === 2 && order.roleCount >= 20 && order.widthSpan <= 1.5 && order.heightSpan <= 1.5 && order.smallRoles.length === 0, order);
    await page.evaluate(() => { const body = document.querySelector('.sheet-body'); if (body) body.scrollTop = 0; });
    await sleep(40);
    await page.screenshot({ path: path.join(OUT, `order-${width}.png`) });
    await page.evaluate(() => {
      const body = document.querySelector('.sheet-body');
      const block = document.querySelector('.roles-section');
      if (body && block) body.scrollTop = block.offsetTop - 8;
    });
    await sleep(40);
    await page.screenshot({ path: path.join(OUT, `roles-${width}.png`) });
    check(`console@${width}`, errors.length === 0, errors.slice(0, 4));
    await page.close();
  }

  // kit sheet at 390
  const kit = await boot(browser, 390);
  await kit.page.evaluate(() => {
    const clickCat = (name) => {
      const b = [...document.querySelectorAll('#buyGrid .cat-btn')].find(x => x.textContent.trim() === name);
      if (b) b.click();
    };
    // kits live at the top level
      const kitCat = [...document.querySelectorAll('#buyGrid .cat-btn')].find(b => b.textContent.trim() === 'Player Kit');
    if (kitCat) kitCat.click();
    const item = [...document.querySelectorAll('#buyGrid .item-btn')].find(b => (b.querySelector('.nm')?.textContent || b.textContent).trim() === 'Player Kit');
    if (item) item.click();
  });
  await sleep(60);
  const kitState = await kit.page.evaluate(() => {
    const panel = document.getElementById('kitPanel');
    const open = panel && panel.style.display === 'flex';
    const title = document.querySelector('.kit-box h3')?.textContent || '';
    const drink = document.querySelector('select[data-slot="drink"]');
    return { open, title, drink: drink && drink.value, display: panel && getComputedStyle(panel).display };
  });
  check('kit-opens', kitState.open && /Player Kit/.test(kitState.title), kitState);
  await kit.page.screenshot({ path: path.join(OUT, 'kit-390.png') });
  check('kit-console', kit.errors.length === 0, kit.errors.slice(0, 4));
  await kit.page.close();

  await browser.close();
  const summary = { pass: fails.length === 0, fails };
  fs.writeFileSync(path.join(OUT, 'geometry.json'), JSON.stringify(summary, null, 2));
  if (fails.length) {
    console.log('GEOMETRY FAILS', fails.length);
    process.exit(1);
  }
  console.log('GEOMETRY OK');
})().catch(e => { console.error(e); process.exit(1); });
