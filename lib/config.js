'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomId } = require('./crypto-util');
const { resolveKillfeedApiKey } = require('./secrets');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_GUILD_ID = '1213578527522431046';
const DEFAULT_REDIRECT = 'http://localhost:8787/auth/discord/callback';
const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DEFAULT_KILLFEED_BASE = 'https://api.killfeed.xyz';
const KILLFEED_DOCS = 'https://dayz-plus-plus-api.readme.io/';
const KILLFEED_ECONOMY_ROUTE = 'GET /guilds/{guild_id}/economy/users/{user_id}';
const SCOPES = 'identify guilds.members.read';

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function firstPresent(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function truthy(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function loadEnvFileIfPresent() {
  return parseEnvFile(path.join(ROOT, '.env'));
}

const RUNTIME_IDS_PATH = path.join(ROOT, 'runtime-ids.json');
const RUNTIME_KEYS = {
  discord_client_id: 'DISCORD_CLIENT_ID',
  discord_guild_id: 'DISCORD_GUILD_ID',
  discord_trader_role_id: 'DISCORD_TRADER_ROLE_ID',
  discord_server_owner_role_id: 'DISCORD_SERVER_OWNER_ROLE_ID',
  discord_high_level_staff_role_id: 'DISCORD_HIGH_LEVEL_STAFF_ROLE_ID',
  discord_redirect_uri: 'DISCORD_REDIRECT_URI',
};

function loadDiscountRoleMap() {
  try {
    if (!fs.existsSync(RUNTIME_IDS_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(RUNTIME_IDS_PATH, 'utf8'));
    const { parseVerifiedMap } = require('./discounts');
    const { builtinNames } = require('./role-rules');
    const known = builtinNames();
    const parsed = parseVerifiedMap(raw && raw.discount_role_map);
    const out = {};
    Object.entries(parsed).forEach(([id, label]) => {
      if (known.has(label)) out[id] = label;
    });
    return out;
  } catch {
    return {};
  }
}

// Nonsecret IDs only. Unknown keys, especially anything that looks like a secret, are ignored.
function loadRuntimeIds() {
  try {
    if (!fs.existsSync(RUNTIME_IDS_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(RUNTIME_IDS_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [from, to] of Object.entries(RUNTIME_KEYS)) {
      const value = raw[from];
      if (typeof value === 'string' && value.trim()) out[to] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}


function fromSources(fileEnv, processEnv, overrides, options = {}) {
  const src = { ...fileEnv, ...processEnv, ...(overrides || {}) };
  const get = (key, fallback = '') => firstPresent(src[key], fallback);
  const liveDefaults = Boolean(options.liveDefaults);
  const killfeedKey = resolveKillfeedApiKey(get, { readSecretFiles: Boolean(options.readSecretFiles) });

  const sessionSecret = get('SESSION_SECRET') || randomId(32);
  const sessionSecretGenerated = !get('SESSION_SECRET');

  const config = {
    root: ROOT,
    port: Number(get('PORT', '8787')) || 8787,
    sessionSecret,
    sessionSecretGenerated,
    cookieSecure: truthy(get('COOKIE_SECURE'), false),
    cookieSameSite: get('COOKIE_SAMESITE', 'Lax') || 'Lax',
    discordClientId: get('DISCORD_CLIENT_ID'),
    discordClientSecret: get('DISCORD_CLIENT_SECRET'),
    discordRedirectUri: get('DISCORD_REDIRECT_URI', DEFAULT_REDIRECT) || DEFAULT_REDIRECT,
    discordApiBase: (get('DISCORD_API_BASE', DEFAULT_API_BASE) || DEFAULT_API_BASE).replace(/\/+$/, ''),
    discordAuthorizeUrl: get('DISCORD_AUTHORIZE_URL', DEFAULT_AUTHORIZE) || DEFAULT_AUTHORIZE,
    discordGuildId: get('DISCORD_GUILD_ID', DEFAULT_GUILD_ID) || DEFAULT_GUILD_ID,
    discordTraderRoleId: get('DISCORD_TRADER_ROLE_ID'),
    discordServerOwnerRoleId: get('DISCORD_SERVER_OWNER_ROLE_ID'),
    // Configured to the verified unique Discord role "High Lvl Staff" when
    // present in runtime-ids.json. That ID is a Design interpretation of
    // Alex's 12:24 phrase "High Level Staff" as a known abbreviation, not a
    // literal exact-name claim and not a fuzzy neighboring-admin alias.
    discordHighLevelStaffRoleId: get('DISCORD_HIGH_LEVEL_STAFF_ROLE_ID'),
    // Verified nonsecret role IDs from runtime-ids.json. An env JSON object
    // replaces that file. Isolated test config stays empty unless a test
    // passes discordDiscountRoleMap.
    discordDiscountRoleMap: liveDefaults ? loadDiscountRoleMap() : {},
    discordBotToken: get('DISCORD_BOT_TOKEN'),
    discordScopes: SCOPES,
    killfeedApiBase: (get('KILLFEED_API_BASE', DEFAULT_KILLFEED_BASE) || DEFAULT_KILLFEED_BASE).replace(/\/+$/, ''),
    killfeedApiKey: killfeedKey.key,
    killfeedApiKeySource: killfeedKey.source,
    killfeedGuildId: get('KILLFEED_GUILD_ID') || (liveDefaults ? DEFAULT_GUILD_ID : ''),
    killfeedUserIdSemantics: get('KILLFEED_USER_ID_SEMANTICS') || (liveDefaults ? 'discord_user_id' : ''),
    killfeedDocs: KILLFEED_DOCS,
    killfeedEconomyRoute: KILLFEED_ECONOMY_ROUTE,
    appName: 'Group 935 Calculator',
  };

  const envMap = get('DISCORD_DISCOUNT_ROLE_MAP');
  if (envMap) {
    const { parseVerifiedMap } = require('./discounts');
    const parsed = parseVerifiedMap(envMap);
    if (Object.keys(parsed).length) config.discordDiscountRoleMap = parsed;
  }
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'discordDiscountRoleMap')) {
    config.discordDiscountRoleMap = overrides.discordDiscountRoleMap;
  }

  config.discordOAuthConfigured = Boolean(config.discordClientId && config.discordClientSecret);
  config.traderRoleConfigured = Boolean(config.discordTraderRoleId);
  config.serverOwnerRoleConfigured = Boolean(config.discordServerOwnerRoleId);
  config.highLevelStaffRoleConfigured = Boolean(config.discordHighLevelStaffRoleId);
  config.elevatedAccessConfigured = Boolean(
    config.traderRoleConfigured || config.serverOwnerRoleConfigured || config.highLevelStaffRoleConfigured
  );
  config.discountRolesConfigured = Boolean(
    config.discordDiscountRoleMap && Object.keys(config.discordDiscountRoleMap).length
  );
  config.customerLookupConfigured = Boolean(config.discordBotToken && config.discordGuildId);
  config.killfeedCredentialsConfigured = Boolean(config.killfeedApiKey && config.killfeedGuildId);
  config.killfeedUserIdSemanticsConfirmed = config.killfeedUserIdSemantics === 'discord_user_id';
  // Strict mapper enabled after the 2026-11-11 12:15 America/Toronto schema evidence.
  config.killfeedResponseMapped = true;
  config.killfeedSearchConfigured = false;
  config.killfeedBalanceConfigured = Boolean(
    config.killfeedCredentialsConfigured &&
      config.killfeedUserIdSemanticsConfirmed &&
      config.killfeedResponseMapped
  );

  return config;
}

function loadConfig(overrides) {
  return fromSources({ ...loadRuntimeIds(), ...loadEnvFileIfPresent() }, process.env, overrides, {
    liveDefaults: true,
    readSecretFiles: true,
  });
}

// Isolated config for tests: ignores process.env, any local .env, and the
// real secrets/killfeed-api-key file unless a test passes KILLFEED_API_KEY
// or KILLFEED_API_KEY_FILE explicitly.
function buildConfig(overrides) {
  return fromSources({}, {}, overrides, {
    liveDefaults: false,
    readSecretFiles: false,
  });
}

function publicStatus(config) {
  return {
    ok: true,
    service: 'group-935-calculator-poc',
    app_name: config.appName,
    listen: `http://localhost:${config.port}`,
    callback: 'http://localhost:8787/auth/discord/callback',
    scopes: config.discordScopes,
    guild_configured: Boolean(config.discordGuildId),
    discord_oauth_configured: Boolean(config.discordOAuthConfigured),
    trader_role_configured: Boolean(config.traderRoleConfigured),
    server_owner_role_configured: Boolean(config.serverOwnerRoleConfigured),
    high_level_staff_role_configured: Boolean(config.highLevelStaffRoleConfigured),
    elevated_access_configured: Boolean(config.elevatedAccessConfigured),
    discount_roles_configured: Boolean(config.discountRolesConfigured),
    customer_lookup_configured: Boolean(config.customerLookupConfigured),
    killfeed_credentials_configured: Boolean(config.killfeedCredentialsConfigured),
    killfeed_credentials_source: config.killfeedApiKeySource || 'none',
    killfeed_user_id_semantics_confirmed: Boolean(config.killfeedUserIdSemanticsConfirmed),
    killfeed_response_mapped: Boolean(config.killfeedResponseMapped),
    killfeed_balance_configured: Boolean(config.killfeedBalanceConfigured),
    killfeed_search_configured: false,
    killfeed_docs: KILLFEED_DOCS,
    killfeed_route: KILLFEED_ECONOMY_ROUTE,
    balance_writes: false,
    discord_gateway: false,
  };
}

module.exports = {
  ROOT,
  DEFAULT_GUILD_ID,
  DEFAULT_REDIRECT,
  DEFAULT_KILLFEED_BASE,
  KILLFEED_DOCS,
  KILLFEED_ECONOMY_ROUTE,
  SCOPES,
  loadConfig,
  buildConfig,
  publicStatus,
  parseEnvFile,
  loadRuntimeIds,
  loadDiscountRoleMap,
  RUNTIME_IDS_PATH,
};
