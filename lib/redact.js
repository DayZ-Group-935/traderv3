'use strict';

const SENSITIVE_KEY = /^(client_secret|secret|token|access_token|refresh_token|authorization|api_key|apikey|api-key|cookie|set-cookie|code|password|session|session_secret|bot_token|discord_bot_token|discord_client_secret|killfeed_api_key|code_verifier|code_challenge|refresh)$/i;
const BEARER = /Bearer\s+[A-Za-z0-9._\-]+/gi;
const BASIC = /Basic\s+[A-Za-z0-9+/=]+/gi;

function collectSecrets(extra) {
  const out = new Set();
  for (const value of extra || []) {
    if (typeof value === 'string' && value.length >= 4) out.add(value);
  }
  return out;
}

function redactString(input, secrets) {
  if (typeof input !== 'string' || !input) return input;
  let out = input.replace(BEARER, 'Bearer [REDACTED]').replace(BASIC, 'Basic [REDACTED]');
  for (const secret of secrets) {
    if (!secret) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }
  return out;
}

function redact(value, extraSecrets) {
  const secrets = collectSecrets(extraSecrets);
  return redactValue(value, secrets, 0);
}

function redactValue(value, secrets, depth) {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = item == null || item === '' ? item : '[REDACTED]';
      } else {
        out[key] = redactValue(item, secrets, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function knownProcessSecrets(config) {
  const list = [];
  if (!config) return list;
  for (const key of [
    'sessionSecret',
    'discordClientSecret',
    'discordBotToken',
    'killfeedApiKey',
  ]) {
    if (config[key]) list.push(config[key]);
  }
  return list;
}

module.exports = { redact, redactString, knownProcessSecrets, SENSITIVE_KEY };
