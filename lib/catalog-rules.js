'use strict';

// Catalog edits are a separate price list from the calculator's role buttons.
// A catalog discount is either a percent of the unit price or a fixed credit
// amount, never both. Role percents are computed from that same unit price,
// and the line uses the lower of the two results. They are not multiplied.
// A role bonus replaces the sell unit and is not discounted again.

const GUILD_ID = '1213578527522431046';
const OWNER_ROLE_ID = '1215040829186383912';
const STAFF_ROLE_ID = '1215042184764723251';
const TRADER_ROLE_ID = '1215060053191819324';
const MAX_PRICE = 10000000;
const MAX_CHANGES = 400;

function catalogEditAllowed(config, membership) {
  if (!config || !membership || membership.inGuild !== true) return false;
  if (String(config.discordGuildId) !== GUILD_ID) return false;
  if (String(config.discordServerOwnerRoleId) !== OWNER_ROLE_ID) return false;
  if (String(config.discordHighLevelStaffRoleId) !== STAFF_ROLE_ID) return false;
  const roles = new Set((membership.roles || []).map(String));
  return roles.has(OWNER_ROLE_ID) || roles.has(STAFF_ROLE_ID);
}

function roundCr(value) {
  return Math.round(Number(value) || 0);
}

function catalogResult(price, discount) {
  const base = roundCr(price);
  if (!discount || discount.value == null || Number(discount.value) === 0) return base;
  if (discount.type === 'percent') return Math.max(0, roundCr(base * (1 - Number(discount.value) / 100)));
  if (discount.type === 'fixed') return Math.max(0, base - roundCr(discount.value));
  return base;
}

function payableUnit({ price, discount, rolePercent, bonus }) {
  if (bonus != null) return roundCr(bonus);
  const base = roundCr(price);
  const catalog = catalogResult(base, discount);
  const role = rolePercent ? Math.max(0, roundCr(base * (1 - Number(rolePercent) / 100))) : base;
  return Math.min(catalog, role);
}

function dayOneTotal(lines, dayOne) {
  let kept = 0;
  let eligible = 0;
  for (const line of lines) {
    if (line.catalogDiscount) kept += line.total;
    else eligible += line.total;
  }
  if (!dayOne) return kept + eligible;
  return kept + eligible * 0.9;
}

function normalizeDiscount(raw, price) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_discount' };
  if (Object.keys(raw).some((key) => key !== 'type' && key !== 'value')) return { error: 'invalid_discount' };
  if (raw.type !== 'percent' && raw.type !== 'fixed') return { error: 'invalid_discount' };
  if (!Number.isInteger(raw.value) || raw.value < 0) return { error: 'invalid_discount' };
  if (raw.type === 'percent' && raw.value > 100) return { error: 'invalid_discount' };
  if (raw.type === 'fixed' && raw.value > price) return { error: 'invalid_discount' };
  if (raw.value === 0) return null;
  return { type: raw.type, value: raw.value };
}

function sameRecord(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateOverlay(baseItems, changes) {
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES) return { error: 'invalid_body' };
  const index = new Map(baseItems.map((item) => [`${item.side}\n${item.name}`, item]));
  const seen = new Set();
  const next = [];
  for (const raw of changes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_body' };
    if (Object.keys(raw).some((key) => !['side', 'name', 'price', 'in_stock', 'discount'].includes(key))) {
      return { error: 'invalid_body' };
    }
    if (raw.side !== 'buy' && raw.side !== 'sell') return { error: 'invalid_item' };
    if (typeof raw.name !== 'string' || raw.name.length > 80 || /[<>]/.test(raw.name)) return { error: 'invalid_item' };
    const base = index.get(`${raw.side}\n${raw.name}`);
    if (!base || seen.has(`${raw.side}\n${raw.name}`)) return { error: 'invalid_item' };
    seen.add(`${raw.side}\n${raw.name}`);
    if (!Number.isInteger(raw.price) || raw.price < 0 || raw.price > MAX_PRICE) return { error: 'invalid_price' };
    if (base.unusual === 'tier' && raw.price !== base.price) return { error: 'invalid_price' };
    if (typeof raw.in_stock !== 'boolean') return { error: 'invalid_stock' };
    const discount = normalizeDiscount(raw.discount, raw.price);
    if (discount && discount.error) return { error: discount.error };
    const record = {
      side: raw.side,
      name: base.name,
      price: raw.price,
      in_stock: raw.in_stock,
      discount: discount || null,
    };
    if (record.price === base.price && record.in_stock === base.inStock && !record.discount) continue;
    next.push(record);
  }
  next.sort((a, b) => (a.side + a.name).localeCompare(b.side + b.name));
  return { changes: next };
}

function diffChanges(prev, next) {
  const map = (list) => {
    const out = new Map();
    for (const row of list || []) out.set(`${row.side}\n${row.name}`, row);
    return out;
  };
  const before = map(prev);
  const after = map(next);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const out = [];
  for (const key of keys) {
    const oldValue = before.get(key) || null;
    const newValue = after.get(key) || null;
    if (sameRecord(oldValue, newValue)) continue;
    const split = key.indexOf('\n');
    out.push({
      side: key.slice(0, split),
      name: key.slice(split + 1),
      old: oldValue,
      new: newValue,
    });
  }
  return out;
}

module.exports = {
  GUILD_ID,
  OWNER_ROLE_ID,
  STAFF_ROLE_ID,
  TRADER_ROLE_ID,
  catalogEditAllowed,
  catalogResult,
  payableUnit,
  dayOneTotal,
  validateOverlay,
  diffChanges,
};
