'use strict';

// Calculator terms are the master. A Discord percent is applied only when
// that role has no calculator terms. When the calculator already defines the
// role, the Discord sentence is reference text and is not a second discount.
// Two percents on one line do not stack: the lower price wins.

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

function loadObject(name, file = path.join(__dirname, '..', 'index.html')) {
  const source = fs.readFileSync(file, 'utf8');
  const body = extractConst(source, name);
  if (/function|=>|<\/|import\s|require\s*\(/.test(body)) throw new Error(`unsafe ${name}`);
  return vm.runInNewContext(`(${body})`, Object.create(null), { timeout: 1000 });
}

function loadDiscordStatements(file) {
  return loadObject('discordStatements', file);
}

function loadDiscordOngoing(file) {
  return loadObject('discordOngoing', file);
}

function hasCalculatorTerms(rule) {
  if (!rule) return false;
  if (rule.cart_percent) return true;
  return Array.isArray(rule.effects) && rule.effects.length > 0;
}

function resolveRole(name, rules, statements, ongoing) {
  const catalog = statements || loadDiscordStatements();
  const bonusOnly = ongoing || loadDiscordOngoing();
  const list = rules || require('./role-rules').builtinRoleRules();
  const direct = catalog[name] || null;
  const calculatorName = direct && direct.calculator ? direct.calculator : name;
  const rule = list.find((row) => row && row.name === calculatorName) || null;
  const reference = direct && !direct.calculator
    ? direct
    : Object.entries(catalog).find(([, row]) => row && row.calculator === name);
  const statement = direct
    ? direct.statement
    : (reference ? reference[1].statement : null);
  if (hasCalculatorTerms(rule)) {
    return {
      name,
      source: 'calculator',
      tag: 'calculator term',
      calculator_name: calculatorName,
      discord_statement: statement,
      applied_percent: null,
    };
  }
  if (direct && direct.percent && !direct.calculator) {
    return {
      name,
      source: 'discord',
      tag: 'from Discord',
      calculator_name: null,
      discord_statement: direct.statement,
      applied_percent: direct.percent,
      scope: 'buy',
    };
  }
  if (bonusOnly[name]) {
    return {
      name,
      source: 'none',
      tag: 'no defined terms',
      calculator_name: null,
      discord_statement: bonusOnly[name].statement || 'ongoing bonuses, no %',
      applied_percent: null,
    };
  }
  return {
    name,
    source: 'unknown',
    tag: null,
    calculator_name: null,
    discord_statement: null,
    applied_percent: null,
  };
}

function roleSourceTable(rules) {
  const { builtinRoleRules } = require('./role-rules');
  const list = rules || builtinRoleRules();
  const statements = loadDiscordStatements();
  const ongoing = loadDiscordOngoing();
  const rows = list.map((rule) => resolveRole(rule.name, list, statements, ongoing));
  Object.keys(statements).forEach((name) => {
    if (rows.some((row) => row.name === name)) return;
    rows.push(resolveRole(name, list, statements, ongoing));
  });
  Object.keys(ongoing).forEach((name) => {
    if (rows.some((row) => row.name === name)) return;
    rows.push(resolveRole(name, list, statements, ongoing));
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function buyLinePrice(itemName, base, activeNames, statements) {
  const { builtinRoleRules } = require('./role-rules');
  const rules = builtinRoleRules();
  const catalog = statements || loadDiscordStatements();
  let price = base;
  (activeNames || []).forEach((name) => {
    const resolved = resolveRole(name, rules, catalog, {});
    if (resolved.source === 'none' || resolved.source === 'unknown') return;
    if (resolved.source === 'discord') {
      price = Math.min(price, base * (1 - resolved.applied_percent / 100));
      return;
    }
    const rule = rules.find((row) => row.name === (resolved.calculator_name || name));
    const effect = (rule && rule.effects || []).find((row) => row.side === 'buy' && row.name === itemName && row.discount);
    if (effect && effect.discount.type === 'percent') {
      price = Math.min(price, base * (1 - effect.discount.value / 100));
    } else if (effect && effect.discount.type === 'fixed') {
      price = Math.min(price, Math.max(0, base - effect.discount.value));
    }
  });
  return Math.round(price);
}

module.exports = {
  loadDiscordStatements,
  loadDiscordOngoing,
  resolveRole,
  roleSourceTable,
  buyLinePrice,
};
