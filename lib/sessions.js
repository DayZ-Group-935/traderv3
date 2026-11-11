'use strict';

const { randomId } = require('./crypto-util');

const COOKIE_NAME = 'g935_sid';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

function createSessionStore(options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const map = new Map();

  function purge() {
    const now = Date.now();
    for (const [id, rec] of map) {
      if (rec.expiresAt <= now) map.delete(id);
    }
  }

  function create(data) {
    purge();
    const id = randomId(32);
    const rec = {
      id,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      discordUserId: data.discordUserId,
      username: data.username || '',
      globalName: data.globalName || '',
      discriminator: data.discriminator || '',
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || '',
      tokenExpiresAt: data.tokenExpiresAt || 0,
      scope: data.scope || '',
    };
    map.set(id, rec);
    return rec;
  }

  function get(id) {
    if (!id) return null;
    const rec = map.get(id);
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) {
      map.delete(id);
      return null;
    }
    return rec;
  }

  function touch(id) {
    const rec = get(id);
    if (!rec) return null;
    rec.expiresAt = Date.now() + ttlMs;
    return rec;
  }

  function update(id, patch) {
    const rec = get(id);
    if (!rec) return null;
    Object.assign(rec, patch);
    return rec;
  }

  function destroy(id) {
    if (id) map.delete(id);
  }

  function publicIdentity(rec) {
    if (!rec) return null;
    return {
      id: rec.discordUserId,
      username: rec.username,
      global_name: rec.globalName,
    };
  }

  return { cookieName: COOKIE_NAME, create, get, touch, update, destroy, publicIdentity, _map: map, purge };
}

module.exports = { createSessionStore, COOKIE_NAME, DEFAULT_TTL_MS };
