'use strict';

const CALLBACK_PATH = '/auth/discord/callback';

// The only public origin is the operator's DISCORD_REDIRECT_URI. Nothing here
// reads the request, RENDER_EXTERNAL_HOSTNAME, or an onrender.com guess.
function canonicalFromRedirect(redirectUri) {
  let url;
  try {
    url = new URL(String(redirectUri || ''));
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== CALLBACK_PATH) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  if (url.protocol === 'https:') {
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return null;
    if (url.port && url.port !== '443') return null;
    return { mode: 'https', origin: url.origin, host };
  }
  if (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) {
    return { mode: 'local', origin: url.origin, host };
  }
  return null;
}

function authorizeOrigin(config) {
  try {
    const url = new URL(config && config.discordAuthorizeUrl ? config.discordAuthorizeUrl : '');
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function singleHeader(req, name) {
  const raw = req && req.headers ? req.headers[name] : undefined;
  if (raw == null || raw === '') return { present: false, value: '' };
  if (Array.isArray(raw)) return { present: true, value: null };
  const value = String(raw);
  if (value.includes(',') || value.includes('\r') || value.includes('\n')) return { present: true, value: null };
  return { present: true, value: value.trim() };
}

function hostnameFromHost(value) {
  if (!value || value.length > 255) return null;
  if (/[\s,@\\]/.test(value) || value.includes('://')) return null;
  let url;
  try {
    url = new URL(`http://${value}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  return { hostname: url.hostname.toLowerCase(), port: url.port };
}

function originAllowed(value, canon, pathname, method, discordOrigin) {
  if (!value || value === 'null') return true;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  if (url.origin === canon.origin) return true;
  if (method === 'GET' && pathname === CALLBACK_PATH && discordOrigin && url.origin === discordOrigin) return true;
  return false;
}

function assessRequest(config, req, pathname, method) {
  const canon = canonicalFromRedirect(config && config.discordRedirectUri);
  if (!canon) return { ok: false, status: 400, error: 'invalid_origin_config' };
  if (canon.mode === 'https' && !config.cookieSecure) return { ok: false, status: 400, error: 'invalid_origin_config' };
  if (canon.mode === 'local' && config.cookieSecure) return { ok: false, status: 400, error: 'invalid_origin_config' };

  const health = pathname === '/health' || pathname === '/status';
  const hostHeader = singleHeader(req, 'host');
  let hostOk = false;
  if (!hostHeader.present) {
    hostOk = health;
  } else if (hostHeader.value) {
    const parsed = hostnameFromHost(hostHeader.value);
    if (canon.mode === 'local') {
      hostOk = Boolean(parsed && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'));
    } else {
      hostOk = Boolean(parsed && parsed.hostname === canon.host && (parsed.port === '' || parsed.port === '443'));
    }
  }
  if (!hostOk) return { ok: false, status: 421, error: 'invalid_host' };

  // Health probes are plain HTTP inside Render and may omit X-Forwarded-Proto.
  // The header is never a scheme, cookie, or redirect input.
  if (!health && canon.mode === 'https') {
    const forwarded = singleHeader(req, 'x-forwarded-proto');
    if (forwarded.present && (forwarded.value == null || forwarded.value.toLowerCase() !== 'https')) {
      return { ok: false, status: 400, error: 'invalid_forwarded_proto' };
    }
  }

  const origin = singleHeader(req, 'origin');
  if (origin.present) {
    if (origin.value == null || !originAllowed(origin.value, canon, pathname, method, authorizeOrigin(config))) {
      return { ok: false, status: 403, error: 'invalid_origin' };
    }
  }
  return { ok: true };
}

function safeAuthorizeLocation(location, config) {
  const allow = authorizeOrigin(config);
  if (!allow) return null;
  let url;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== allow || url.username || url.password) return null;
  return url.toString();
}

module.exports = {
  CALLBACK_PATH,
  canonicalFromRedirect,
  assessRequest,
  safeAuthorizeLocation,
};
