'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractConst(source, name) {
  const token = `const ${name} = `;
  const start = source.indexOf(token);
  if (start < 0) throw new Error(`missing ${name}`);
  let i = start + token.length;
  if (source[i] !== '{') throw new Error(`bad ${name}`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let j = i; j < source.length; j += 1) {
    const ch = source[j];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function literal(source, name) {
  const body = extractConst(source, name);
  if (/function|=>|<\/|import\s|require\s*\(/.test(body)) throw new Error(`unsafe ${name}`);
  return vm.runInNewContext(`(${body})`, Object.create(null), { timeout: 1000 });
}

function walk(node, side, inheritedOut, out) {
  if (Array.isArray(node)) {
    node.forEach((item) => {
      if (!item || typeof item.name !== 'string') return;
      out.push({
        side,
        name: item.name,
        price: item.price,
        inStock: inheritedOut ? false : item.inStock !== false,
        unusual: item.name === 'Bible' ? 'tier' : (item.name === 'Player Kit' || item.name === 'Ghillie Kit' ? 'kit' : null),
      });
    });
    return;
  }
  if (!node || typeof node !== 'object') return;
  const outOfStock = inheritedOut || node._outOfStock === true;
  Object.entries(node).forEach(([key, value]) => {
    if (key.startsWith('_')) return;
    walk(value, side, outOfStock, out);
  });
}

function loadBaseCatalog(file = path.join(__dirname, '..', 'app', 'index.html')) {
  const source = fs.readFileSync(file, 'utf8');
  const items = [];
  walk(literal(source, 'buyitems'), 'buy', false, items);
  walk(literal(source, 'sellitems'), 'sell', false, items);
  return items;
}

module.exports = { loadBaseCatalog };
