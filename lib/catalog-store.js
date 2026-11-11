'use strict';

const fs = require('node:fs');
const path = require('node:path');

function emptyDocument() {
  return { revision: 0, updated_at: null, changes: [], role_rules: null, audit: [] };
}

function parentWritable(filePath) {
  try {
    fs.accessSync(path.dirname(filePath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Production root is /var/data. Tests may pass another root; environment
// variables cannot. A path outside the root, or a missing directory, does
// not accept writes.
function openCatalogStore(options = {}) {
  const root = path.resolve(options.root || '/var/data');
  const enabled = options.enabled === true;
  const requested = typeof options.path === 'string' ? options.path : '';
  let filePath = null;
  if (enabled && requested) {
    const resolved = path.resolve(requested);
    const rel = path.relative(root, resolved);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) filePath = resolved;
  }

  function ready() {
    return Boolean(filePath) && parentWritable(filePath);
  }

  function reason() {
    if (!filePath) return 'catalog_store_unconfigured';
    if (!parentWritable(filePath)) return 'catalog_store_unavailable';
    return null;
  }

  function load() {
    if (!filePath) return { ok: false, reason: 'catalog_store_unconfigured', doc: emptyDocument() };
    if (!fs.existsSync(filePath)) return { ok: true, reason: null, doc: emptyDocument() };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.changes) || !Number.isInteger(parsed.revision)) {
        return { ok: false, reason: 'catalog_store_unreadable', doc: emptyDocument() };
      }
      return {
        ok: true,
        reason: null,
        doc: {
          revision: parsed.revision,
          updated_at: parsed.updated_at || null,
          changes: parsed.changes,
          role_rules: Array.isArray(parsed.role_rules) ? parsed.role_rules : null,
          audit: Array.isArray(parsed.audit) ? parsed.audit : [],
        },
      };
    } catch {
      return { ok: false, reason: 'catalog_store_unreadable', doc: emptyDocument() };
    }
  }

  function save(doc) {
    if (!ready()) return { ok: false, reason: reason() };
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    const body = JSON.stringify(doc);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, filePath);
    return { ok: true, reason: null };
  }

  return { ready, reason, load, save, filePath };
}

function openCatalogStoreFromEnv(env = process.env) {
  return openCatalogStore({
    enabled: env.CATALOG_STORE === 'file',
    path: env.CATALOG_STORE_PATH || '',
  });
}

module.exports = { openCatalogStore, openCatalogStoreFromEnv };
