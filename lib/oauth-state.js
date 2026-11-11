'use strict';

const { randomId, pkcePair, timingSafeEqualStr } = require('./crypto-util');

const COOKIE_NAME = 'g935_oauth';
const TTL_MS = 10 * 60 * 1000;

function createOAuthStateStore() {
  const map = new Map();

  function purge() {
    const now = Date.now();
    for (const [state, rec] of map) {
      if (rec.expiresAt <= now) map.delete(state);
    }
  }

  function issue() {
    purge();
    const state = randomId(24);
    const nonce = randomId(24);
    const { verifier, challenge } = pkcePair();
    map.set(state, { nonce, verifier, challenge, expiresAt: Date.now() + TTL_MS });
    return { state, nonce, verifier, challenge };
  }

  // One-time consume. Returns the record or null on mismatch/expiry.
  function consume(state, nonce) {
    if (!state || !nonce) return null;
    const rec = map.get(state);
    map.delete(state);
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) return null;
    if (!timingSafeEqualStr(rec.nonce, nonce)) return null;
    return rec;
  }

  return { cookieName: COOKIE_NAME, issue, consume, purge, _map: map };
}

module.exports = { createOAuthStateStore, COOKIE_NAME, TTL_MS };
