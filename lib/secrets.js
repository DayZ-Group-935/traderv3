'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_KILLFEED_KEY_FILE = path.join(__dirname, '..', 'secrets', 'killfeed-api-key');

// Read a secret from a local file. Returns the trimmed value or ''.
// Never logs the contents. Callers must not print the return value.
function readSecretFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return '';
    const raw = fs.readFileSync(filePath, 'utf8');
    return String(raw).trim();
  } catch {
    return '';
  }
}

function resolveKillfeedApiKey(get, options = {}) {
  const envKey = typeof get === 'function' ? get('KILLFEED_API_KEY') : '';
  if (envKey) return { key: envKey, source: 'env', filePath: '' };

  const explicitFile = typeof get === 'function' ? get('KILLFEED_API_KEY_FILE') : '';
  const filePath = explicitFile || (options.readSecretFiles ? DEFAULT_KILLFEED_KEY_FILE : '');
  if (!filePath) return { key: '', source: 'none', filePath: '' };

  const key = readSecretFile(filePath);
  return { key, source: key ? 'file' : 'none', filePath: key ? filePath : '' };
}

module.exports = { readSecretFile, resolveKillfeedApiKey, DEFAULT_KILLFEED_KEY_FILE };
