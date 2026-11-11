'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mapDiscounts } = require('./discounts');

const ROADKILL_EXCLUDED = new Set(['Trader Truck', 'Trader Car']);

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

function loadBuiltinRoles(file = path.join(__dirname, '..', 'index.html')) {
  const source = fs.readFileSync(file, 'utf8');
  const body = extractConst(source, 'roles');
  if (/function|=>|<\/|import\s|require\s*\(/.test(body)) throw new Error('unsafe roles');
  return vm.runInNewContext(`(${body})`, Object.create(null), { timeout: 1000 });
}

function sideFor(name, fallback, catalog) {
  const buy = catalog.some((item) => item.side === 'buy' && item.name === name);
  const sell = catalog.some((item) => item.side === 'sell' && item.name === name);
  if (buy && !sell) return 'buy';
  if (sell && !buy) return 'sell';
  return fallback;
}

function builtinRoleRules(catalog = []) {
  const roles = loadBuiltinRoles();
  return Object.keys(roles).sort().map((name) => {
    const def = roles[name] || {};
    const effects = [];
    Object.entries(def.discounts || {}).forEach(([item, pct]) => {
      if (!pct) return;
      effects.push({
        side: sideFor(item, 'buy', catalog),
        name: item,
        discount: { type: 'percent', value: pct },
      });
    });
    Object.entries(def.bonuses || {}).forEach(([item, price]) => {
      effects.push({
        side: sideFor(item, 'sell', catalog),
        name: item,
        price,
      });
    });
    return {
      name,
      cart_percent: name === 'Day One' ? 10 : null,
      effects,
    };
  });
}

function builtinNames() {
  return new Set(builtinRoleRules().map((rule) => rule.name));
}

function cleanEffect(raw, names) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_role_rule' };
  if (raw.side !== 'buy' && raw.side !== 'sell') return { error: 'invalid_role_rule' };
  if (typeof raw.name !== 'string' || raw.name.length > 80 || /[<>]/.test(raw.name)) return { error: 'invalid_role_rule' };
  if (!names.has(raw.name) && !/^[A-Za-z0-9 .'+-]{1,80}$/.test(raw.name)) return { error: 'invalid_role_rule' };
  const keys = Object.keys(raw);
  if (keys.some((key) => !['side', 'name', 'discount', 'price'].includes(key))) return { error: 'invalid_role_rule' };
  const hasPrice = raw.price != null;
  const hasDiscount = raw.discount != null;
  if (hasPrice === hasDiscount) return { error: 'invalid_role_rule' };
  if (hasPrice) {
    if (!Number.isInteger(raw.price) || raw.price < 0 || raw.price > 10000000) return { error: 'invalid_role_rule' };
    if (raw.name === 'Trader Truck' || raw.name === 'Trader Car') return { error: 'invalid_role_rule' };
    return { side: raw.side, name: raw.name, price: raw.price };
  }
  const discount = raw.discount;
  if (!discount || (discount.type !== 'percent' && discount.type !== 'fixed')) return { error: 'invalid_role_rule' };
  if (!Number.isInteger(discount.value) || discount.value <= 0) return { error: 'invalid_role_rule' };
  if (discount.type === 'percent' && discount.value > 100) return { error: 'invalid_role_rule' };
  if (discount.type === 'fixed' && discount.value > 10000000) return { error: 'invalid_role_rule' };
  return { side: raw.side, name: raw.name, discount: { type: discount.type, value: discount.value } };
}

function validateRoleRules(raw, catalog) {
  if (!Array.isArray(raw) || raw.length > 80) return { error: 'invalid_role_rule' };
  const names = new Set((catalog || []).map((item) => item.name));
  const known = builtinNames();
  const seen = new Set();
  const rules = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: 'invalid_role_rule' };
    if (typeof row.name !== 'string' || !known.has(row.name) || seen.has(row.name)) return { error: 'invalid_role_rule' };
    if (Object.keys(row).some((key) => !['name', 'cart_percent', 'effects'].includes(key))) return { error: 'invalid_role_rule' };
    seen.add(row.name);
    let cart = null;
    if (row.cart_percent != null) {
      if (!Number.isInteger(row.cart_percent) || row.cart_percent < 0 || row.cart_percent > 100) return { error: 'invalid_role_rule' };
      cart = row.cart_percent || null;
    }
    if (!Array.isArray(row.effects) || row.effects.length > 200) return { error: 'invalid_role_rule' };
    const effects = [];
    const effectSeen = new Set();
    for (const effect of row.effects) {
      const clean = cleanEffect(effect, names);
      if (clean.error) return clean;
      const key = `${clean.side}\n${clean.name}`;
      if (effectSeen.has(key)) return { error: 'invalid_role_rule' };
      effectSeen.add(key);
      if (row.name === 'Roadkill' && ROADKILL_EXCLUDED.has(clean.name)) return { error: 'invalid_role_rule' };
      effects.push(clean);
    }
    rules.push({ name: row.name, cart_percent: cart, effects });
  }
  rules.sort((a, b) => a.name.localeCompare(b.name));
  return { rules };
}

function effectiveRoleRules(stored, catalog) {
  if (Array.isArray(stored) && stored.length) return stored;
  return builtinRoleRules(catalog);
}

function pricingRoleNames(roleIds, verifiedMap) {
  const mapped = mapDiscounts(roleIds, verifiedMap);
  if (!mapped.configured) return [];
  const known = builtinNames();
  const names = [];
  mapped.applied.forEach((entry) => {
    if (known.has(entry.label) && !names.includes(entry.label)) names.push(entry.label);
  });
  return names;
}

module.exports = {
  ROADKILL_EXCLUDED,
  builtinRoleRules,
  builtinNames,
  validateRoleRules,
  effectiveRoleRules,
  pricingRoleNames,
};
