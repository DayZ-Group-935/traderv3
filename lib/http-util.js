'use strict';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function cookieHeader(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge === 0 || opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

function clearCookie(name, opts = {}) {
  return cookieHeader(name, '', { ...opts, maxAge: 0 });
}

function sendJson(res, status, body, extraHeaders) {
  const data = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(data),
    ...(extraHeaders || {}),
  };
  res.writeHead(status, headers);
  res.end(data);
}

function sendHtml(res, status, html, extraHeaders) {
  const data = typeof html === 'string' ? html : String(html);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(data),
    ...(extraHeaders || {}),
  };
  res.writeHead(status, headers);
  res.end(data);
}

function sendRedirect(res, location, extraHeaders) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end();
}

// Path and query only. The Host header is not a base, so an absolute-form
// request-target cannot choose the origin used for routing.
function readUrl(req) {
  const raw = req && typeof req.url === 'string' ? req.url : '';
  if (!raw || raw.length > 8192) return null;
  if (raw.startsWith('//') || raw.includes('\\') || raw.includes('\0') || raw.includes('\r') || raw.includes('\n')) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(raw, 'http://127.0.0.1');
  } catch {
    return null;
  }
  try {
    return new URL(parsed.pathname + parsed.search, 'http://127.0.0.1');
  } catch {
    return null;
  }
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
}

// Minimal Discord / Killfeed rate-limit awareness. Tests inject a clock.
function createRateLimiter(options = {}) {
  const minIntervalMs = options.minIntervalMs || 200;
  const nowFn = options.now || Date.now;
  let nextAllowed = 0;
  let cooldownUntil = 0;

  async function waitForSlot() {
    const now = nowFn();
    const target = Math.max(nextAllowed, cooldownUntil);
    const delay = target - now;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    nextAllowed = nowFn() + minIntervalMs;
  }

  function header(headers, name) {
    if (headers.get) {
      return headers.get(name) || headers.get(name.toLowerCase());
    }
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  }

  function noteHeaders(headers) {
    if (!headers) return;
    const retry = header(headers, 'retry-after') || header(headers, 'RateLimit-Reset') || header(headers, 'ratelimit-reset');
    const remaining = header(headers, 'RateLimit-Remaining') || header(headers, 'ratelimit-remaining');
    // Official/live Killfeed family: RateLimit-Reset is seconds until the window.
    // Only pause when remaining is present and already exhausted, or Retry-After is set.
    const retryAfter = header(headers, 'retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        cooldownUntil = Math.max(cooldownUntil, nowFn() + seconds * 1000);
      }
      return;
    }
    if (remaining != null && remaining !== '' && Number(remaining) <= 0) {
      const seconds = Number(header(headers, 'RateLimit-Reset') || header(headers, 'ratelimit-reset'));
      if (Number.isFinite(seconds) && seconds > 0) {
        cooldownUntil = Math.max(cooldownUntil, nowFn() + seconds * 1000);
      }
    }
  }

  return { waitForSlot, noteHeaders };
}

module.exports = {
  parseCookies,
  cookieHeader,
  clearCookie,
  sendJson,
  sendHtml,
  sendRedirect,
  readUrl,
  securityHeaders,
  createRateLimiter,
};
