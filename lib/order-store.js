'use strict';

const crypto = require('node:crypto');

const ORDER_TTL_MS = 45 * 60 * 1000;
const ORDER_MAX_BYTES = 16 * 1024;
const ORDER_MAX_ENTRIES = 5000;
const CODE_LENGTH = 8;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const DROPPED_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'authorization',
  'password',
  'secret',
  'apikey',
  'identity',
  'balance',
  'roles',
  'session',
]);

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function sanitizeValue(value, depth) {
  if (depth > 6) return { error: 'invalid_order' };
  if (value == null) return { value: null };
  if (typeof value === 'boolean') return { value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > 100000000) return { error: 'invalid_order' };
    return { value };
  }
  if (typeof value === 'string') {
    if (value.length > 200) return { error: 'invalid_order' };
    return { value };
  }
  if (Array.isArray(value)) {
    if (value.length > 40) return { error: 'invalid_order' };
    const next = [];
    for (const entry of value) {
      const clean = sanitizeValue(entry, depth + 1);
      if (clean.error) return clean;
      next.push(clean.value);
    }
    return { value: next };
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 40) return { error: 'invalid_order' };
    const next = {};
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 40) return { error: 'invalid_order' };
      if (DROPPED_KEYS.has(key.toLowerCase())) continue;
      const clean = sanitizeValue(value[key], depth + 1);
      if (clean.error) return clean;
      next[key] = clean.value;
    }
    return { value: next };
  }
  return { error: 'invalid_order' };
}

function validateOrderPayload(raw, rawText) {
  const size = Buffer.byteLength(String(rawText || ''), 'utf8');
  if (size > ORDER_MAX_BYTES) return { error: 'too_large', status: 413 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_order', status: 400 };
  const cart = raw.cart;
  if (!cart || typeof cart !== 'object' || Array.isArray(cart)) return { error: 'invalid_order', status: 400 };
  const names = Object.keys(cart);
  if (!names.length || names.length > 200) return { error: 'invalid_order', status: 400 };
  const cleanCart = {};
  for (const name of names) {
    if (typeof name !== 'string' || name.length < 1 || name.length > 80 || /[<>]/.test(name)) {
      return { error: 'invalid_order', status: 400 };
    }
    const line = cart[name];
    if (!line || typeof line !== 'object' || Array.isArray(line)) return { error: 'invalid_order', status: 400 };
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 100000) return { error: 'invalid_order', status: 400 };
    const clean = { qty: line.qty };
    if (line.base != null) {
      if (!Number.isFinite(line.base) || line.base < 0 || line.base > 100000000) return { error: 'invalid_order', status: 400 };
      clean.base = line.base;
    }
    if (Object.prototype.hasOwnProperty.call(line, 'salePrice')) {
      if (line.salePrice != null && (!Number.isFinite(line.salePrice) || line.salePrice < 0 || line.salePrice > 100000000)) {
        return { error: 'invalid_order', status: 400 };
      }
      clean.salePrice = line.salePrice == null ? null : line.salePrice;
    }
    if (typeof line.item === 'string' && line.item.length <= 80 && !/[<>]/.test(line.item)) clean.item = line.item;
    cleanCart[name] = clean;
  }
  let kits = [];
  if (raw.kits != null) {
    if (!Array.isArray(raw.kits)) return { error: 'invalid_order', status: 400 };
    const cleanKits = sanitizeValue(raw.kits, 0);
    if (cleanKits.error) return { error: 'invalid_order', status: 400 };
    kits = cleanKits.value;
  }
  return { payload: { v: 2, cart: cleanCart, kits } };
}

function createOrderStore(options = {}) {
  const ttlMs = options.ttlMs || ORDER_TTL_MS;
  const maxEntries = options.maxEntries || ORDER_MAX_ENTRIES;
  const now = options.now || Date.now;
  const nextCode = options.randomCode || randomCode;
  const map = new Map();
  let sweepTimer = null;

  function oldestCode() {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [code, rec] of map) {
      if (rec.createdAt < oldestAt) {
        oldestAt = rec.createdAt;
        oldestKey = code;
      }
    }
    return oldestKey;
  }

  function sweep(at) {
    const t = at == null ? now() : at;
    for (const [code, rec] of map) {
      if (rec.expiresAt <= t) map.delete(code);
    }
  }

  function evictToFit() {
    while (map.size >= maxEntries) {
      const key = oldestCode();
      if (!key) break;
      map.delete(key);
    }
  }

  function create(payload) {
    sweep();
    evictToFit();
    let code = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = String(nextCode() || '');
      if (!/^[A-Za-z0-9_-]{6,8}$/.test(candidate)) continue;
      if (!map.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      const err = new Error('code_unavailable');
      err.status = 503;
      throw err;
    }
    const createdAt = now();
    const expiresAt = createdAt + ttlMs;
    map.set(code, { payload, createdAt, expiresAt });
    return { code, expiresAt };
  }

  function get(code) {
    if (!map.has(code)) return { status: 404 };
    const rec = map.get(code);
    if (rec.expiresAt <= now()) {
      map.delete(code);
      return { status: 410 };
    }
    return { status: 200, payload: rec.payload, expiresAt: rec.expiresAt };
  }

  function start() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => sweep(), options.sweepMs || 60 * 1000);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  function stop() {
    if (!sweepTimer) return;
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  return { create, get, sweep, start, stop, size: () => map.size };
}

function createOrderRateLimit(options = {}) {
  const limit = options.limit || 20;
  const windowMs = options.windowMs || 60 * 1000;
  const now = options.now || Date.now;
  const hits = new Map();

  function allow(ip) {
    const key = String(ip || 'unknown');
    const t = now();
    const rec = hits.get(key);
    if (!rec || t - rec.start >= windowMs) {
      if (hits.size > 10000) {
        for (const [id, row] of hits) {
          if (t - row.start >= windowMs) hits.delete(id);
        }
      }
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    if (rec.count >= limit) return false;
    rec.count += 1;
    return true;
  }

  return { allow };
}

function readLimitedBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      const err = new Error('too_large');
      err.status = 413;
      reject(err);
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('too_large');
        err.status = 413;
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = req && req.headers ? req.headers['x-forwarded-for'] : '';
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (/^[0-9a-fA-F:.]+$/.test(first) && first.length <= 64) return first;
  }
  const remote = req && req.socket && req.socket.remoteAddress;
  return remote ? String(remote) : 'unknown';
}

module.exports = {
  ORDER_TTL_MS,
  ORDER_MAX_BYTES,
  ORDER_MAX_ENTRIES,
  validateOrderPayload,
  createOrderStore,
  createOrderRateLimit,
  readLimitedBody,
  clientIp,
  randomCode,
};
