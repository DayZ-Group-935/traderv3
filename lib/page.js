'use strict';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage(status, notice) {
  const s = status || {};
  const noticeHtml = notice
    ? `<p class="notice">${escapeHtml(notice)}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Group 935 Calculator — local balance POC</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0b0c; --gold:#c9b28a; --ink:#eeeae2; --muted:#9a958c; --card:#161617; --line:#2a2a2c; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--ink); }
    main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    h1 { font-weight: 600; letter-spacing: .02em; font-size: 1.35rem; color: var(--gold); margin: 0 0 .4rem; }
    .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .95rem; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1.15rem 1.2rem; margin: 0 0 1rem; }
    .row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }
    button, .btn { appearance: none; border: 0; border-radius: 999px; padding: .55rem 1rem; background: var(--gold); color: #161513; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-block; }
    button.secondary, .btn.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    button:disabled, .btn[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }
    .flags { display: grid; grid-template-columns: 1fr 1fr; gap: .35rem .75rem; font-size: .85rem; color: var(--muted); }
    .flags b { color: var(--ink); font-weight: 600; }
    .notice { background: #2a2318; color: var(--gold); border-radius: 10px; padding: .7rem 0.9rem; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: .85rem; color: var(--ink); margin: .4rem 0 0; }
    label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: .35rem; }
    input { width: 100%; padding: .5rem .65rem; border-radius: 8px; border: 1px solid var(--line); background: #0f0f10; color: var(--ink); margin-bottom: .6rem; }
    h2 { font-size: .95rem; color: var(--gold); margin: 0 0 .6rem; }
  </style>
</head>
<body>
  <main>
    <h1>Group 935 Calculator</h1>
    <p class="sub">Local proof of concept for Discord sign-in and read-only balance lookup. This is not the live calculator and is not published.</p>
    ${noticeHtml}
    <div class="card" id="session-card">
      <p class="sub" id="session-status">Checking session…</p>
      <div class="row" id="session-actions"></div>
      <pre id="me-view" hidden></pre>
    </div>
    <div class="card">
      <h2>Trader customer lookup</h2>
      <p class="sub">Looking up another player requires a current Trader role, plus a separately configured read-only Discord bot. Balance figures also need a documented Killfeed mapping that is not confirmed yet. This form stays disabled until those providers are configured. It will not invent a result.</p>
      <label for="q">Player search</label>
      <input id="q" disabled placeholder="Not configured">
      <button type="button" disabled>Search</button>
    </div>
    <div class="card">
      <h2>Capability status</h2>
      <div class="flags">
        <div>Discord OAuth <b>${s.discord_oauth_configured ? 'configured' : 'not configured'}</b></div>
        <div>Trader role id <b>${s.trader_role_configured ? 'configured' : 'not configured'}</b></div>
        <div>Customer lookup bot <b>${s.customer_lookup_configured ? 'configured' : 'not configured'}</b></div>
        <div>Killfeed credentials <b>${s.killfeed_credentials_configured ? 'configured' : 'not configured'}</b></div>
        <div>Killfeed user id semantics <b>${s.killfeed_user_id_semantics_confirmed ? 'confirmed' : 'unconfirmed'}</b></div>
        <div>Killfeed field mapping <b>${s.killfeed_response_mapped ? 'mapped' : 'not mapped'}</b></div>
        <div>Usable balance provider <b>${s.killfeed_balance_configured ? 'yes' : 'no'}</b></div>
        <div>Balance writes <b>disabled</b></div>
      </div>
    </div>
  </main>
  <script>
    const actions = document.getElementById('session-actions');
    const statusEl = document.getElementById('session-status');
    const view = document.getElementById('me-view');

    function btn(href, label, className) {
      const a = document.createElement('a');
      a.href = href;
      a.className = 'btn' + (className ? ' ' + className : '');
      a.textContent = label;
      return a;
    }

    async function logout(ev) {
      ev.preventDefault();
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      location.href = '/';
    }

    async function load() {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        statusEl.textContent = 'Not signed in. Sign in with Discord to see your own identity, roles, and (when configured) your own balance.';
        actions.appendChild(btn('/auth/discord/login', 'Sign in with Discord'));
        return;
      }
      const data = await res.json();
      statusEl.textContent = 'Signed in. Identity and trader status come from the server session and a live membership check. Tokens stay on the server.';
      const out = document.createElement('button');
      out.className = 'secondary';
      out.textContent = 'Sign out';
      out.addEventListener('click', logout);
      actions.appendChild(out);
      view.hidden = false;
      view.textContent = JSON.stringify(data, null, 2);
    }
    load().catch(() => {
      statusEl.textContent = 'Could not load session status.';
    });
  </script>
</body>
</html>`;
}

module.exports = { renderPage, escapeHtml };
