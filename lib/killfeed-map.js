'use strict';

// Strict mapper for the official Get user balance 200 schema, as verified
// by the 2026-11-11 12:15 America/Toronto live GET evidence in SETUP.md:
//   bank (integer), bank_str (base-10 integer digit string),
//   cash (integer), cash_str (base-10 integer digit string),
//   cash_str === String(cash), bank_str === String(bank),
//   no extra fields, no currency-unit field.
// cash and bank are preserved as distinct values. No total, unit, or
// spendability is invented.

const REQUIRED_KEYS = ['bank', 'bank_str', 'cash', 'cash_str'];

function isSafeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value);
}

function isIntegerDigitString(value) {
  return typeof value === 'string' && /^-?\d+$/.test(value);
}

function mapEconomyBody(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, mapped: false, available: false, reason: 'schema_invalid', write_access: false };
  }

  const keys = Object.keys(body).sort();
  const expected = REQUIRED_KEYS.slice().sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    return { ok: false, mapped: false, available: false, reason: 'schema_invalid', write_access: false };
  }

  const { bank, bank_str, cash, cash_str } = body;
  if (!isSafeInteger(bank) || !isSafeInteger(cash) || !isIntegerDigitString(bank_str) || !isIntegerDigitString(cash_str)) {
    return { ok: false, mapped: false, available: false, reason: 'schema_invalid', write_access: false };
  }
  if (bank_str !== String(bank) || cash_str !== String(cash)) {
    return { ok: false, mapped: false, available: false, reason: 'schema_mismatch', write_access: false };
  }

  return {
    ok: true,
    mapped: true,
    available: true,
    write_access: false,
    cash,
    cash_str,
    bank,
    bank_str,
  };
}

function providerError(status) {
  let reason = 'provider_error';
  if (status === 401 || status === 403) reason = 'unauthorized';
  else if (status === 404) reason = 'not_found';
  else if (status === 429) reason = 'rate_limited';
  return {
    ok: false,
    mapped: false,
    available: false,
    write_access: false,
    http_status: status,
    reason,
  };
}

module.exports = { REQUIRED_KEYS, mapEconomyBody, providerError, isSafeInteger, isIntegerDigitString };
