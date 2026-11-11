'use strict';

const { catalogEditAllowed, validateOverlay, diffChanges } = require('./catalog-rules');
const { currentMembership } = require('./access');
const { requireMutationOrigin } = require('./request-guard');
const { effectiveRoleRules, validateRoleRules, builtinNames } = require('./role-rules');

const BODY_LIMIT = 64 * 1024;
const AUDIT_LIMIT = 100;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      const err = new Error('too_large');
      err.status = 413;
      reject(err);
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        req.resume();
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('too_large');
        err.status = 413;
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function publicCatalog(store) {
  const loaded = store.load();
  if (!loaded.ok && loaded.reason === 'catalog_store_unreadable') {
    return { error: loaded.reason };
  }
  return {
    configured: store.ready(),
    revision: loaded.doc.revision,
    changes: loaded.doc.changes,
    role_rules: effectiveRoleRules(loaded.ok ? loaded.doc.role_rules : null),
    pricing_map: 'unverified',
  };
}

function actorName(session) {
  return String(session.username || session.globalName || '').replace(/[<>]/g, '').slice(0, 32);
}

async function handleCatalogRoutes(ctx) {
  const { req, res, path, method, sendJson, logReq, logger } = ctx;
  if (path !== '/api/catalog' && path !== '/api/catalog/roles') return false;

  if (path === '/api/catalog/roles' && method === 'GET') {
    const session = await ctx.sessionFromRequest(req);
    if (!session) {
      sendJson(res, 401, { error: 'unauthorized' });
      logger.request(logReq, 401);
      return true;
    }
    let membership;
    try {
      membership = await currentMembership(session, ctx.oauth, ctx.config);
    } catch {
      sendJson(res, 503, { error: 'membership_unavailable' });
      logger.request(logReq, 503, { reason: 'membership_unavailable' });
      return true;
    }
    if (!catalogEditAllowed(ctx.config, membership)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'catalog_edit_required' });
      logger.request(logReq, 403, { reason: 'catalog_edit_required' });
      return true;
    }
    let discord = [];
    let reason = 'not_configured';
    if (ctx.botLookup && ctx.botLookup.isConfigured()) {
      const listed = await ctx.botLookup.listRoles();
      if (listed.ok && Array.isArray(listed.data)) {
        discord = listed.data
          .filter((role) => role && typeof role.name === 'string' && /^\d{17,20}$/.test(String(role.id || '')) && !/[<>]/.test(role.name))
          .map((role) => ({ id: String(role.id), name: role.name.slice(0, 80) }));
        reason = null;
      } else {
        reason = 'provider_unavailable';
      }
    }
    sendJson(res, 200, {
      discord,
      calculator: [...builtinNames()].sort(),
      reason,
    });
    logger.request(logReq, 200);
    return true;
  }

  if (method === 'GET') {
    const body = publicCatalog(ctx.catalogStore);
    if (body.error) {
      sendJson(res, 503, { error: body.error, configured: false, revision: 0, changes: [] });
      logger.request(logReq, 503, { reason: body.error });
      return true;
    }
    sendJson(res, 200, body);
    logger.request(logReq, 200);
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    logger.request(logReq, 405);
    return true;
  }

  const session = await ctx.sessionFromRequest(req);
  if (!session) {
    sendJson(res, 401, { error: 'unauthorized' });
    logger.request(logReq, 401);
    return true;
  }
  let membership;
  try {
    membership = await currentMembership(session, ctx.oauth, ctx.config);
  } catch {
    sendJson(res, 503, { error: 'membership_unavailable' });
    logger.request(logReq, 503, { reason: 'membership_unavailable' });
    return true;
  }
  if (!catalogEditAllowed(ctx.config, membership)) {
    sendJson(res, 403, { error: 'forbidden', reason: 'catalog_edit_required' });
    logger.request(logReq, 403, { reason: 'catalog_edit_required' });
    return true;
  }
  const origin = requireMutationOrigin(ctx.config, req);
  if (!origin.ok) {
    sendJson(res, origin.status, { error: origin.error });
    logger.request(logReq, origin.status, { reason: origin.error });
    return true;
  }
  if (!ctx.catalogStore.ready()) {
    sendJson(res, 503, { error: ctx.catalogStore.reason(), configured: false });
    logger.request(logReq, 503, { reason: ctx.catalogStore.reason() });
    return true;
  }

  let text = '';
  try {
    text = await readBody(req, BODY_LIMIT);
  } catch (err) {
    const status = err && err.status === 413 ? 413 : 400;
    sendJson(res, status, { error: status === 413 ? 'payload_too_large' : 'invalid_body' });
    logger.request(logReq, status);
    return true;
  }
  let parsed;
  try {
    parsed = JSON.parse(text || '');
  } catch {
    sendJson(res, 400, { error: 'invalid_body' });
    logger.request(logReq, 400);
    return true;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'invalid_body' });
    logger.request(logReq, 400);
    return true;
  }
  if (Object.keys(parsed).some((key) => key !== 'revision' && key !== 'changes' && key !== 'role_rules')) {
    sendJson(res, 400, { error: 'invalid_body' });
    logger.request(logReq, 400);
    return true;
  }
  if (!Number.isInteger(parsed.revision)) {
    sendJson(res, 400, { error: 'invalid_body' });
    logger.request(logReq, 400);
    return true;
  }

  const loaded = ctx.catalogStore.load();
  if (!loaded.ok) {
    sendJson(res, 503, { error: loaded.reason, configured: false });
    logger.request(logReq, 503, { reason: loaded.reason });
    return true;
  }
  if (parsed.revision !== loaded.doc.revision) {
    sendJson(res, 409, { error: 'stale_revision', revision: loaded.doc.revision });
    logger.request(logReq, 409, { reason: 'stale_revision' });
    return true;
  }
  const validated = validateOverlay(ctx.baseCatalog, parsed.changes);
  if (validated.error) {
    sendJson(res, 400, { error: validated.error });
    logger.request(logReq, 400, { reason: validated.error });
    return true;
  }
  let roleRules = loaded.doc.role_rules || null;
  if (Object.prototype.hasOwnProperty.call(parsed, 'role_rules')) {
    const checked = validateRoleRules(parsed.role_rules, ctx.baseCatalog);
    if (checked.error) {
      sendJson(res, 400, { error: checked.error });
      logger.request(logReq, 400, { reason: checked.error });
      return true;
    }
    roleRules = checked.rules;
  }
  const auditChanges = diffChanges(loaded.doc.changes, validated.changes);
  const roleChanged = JSON.stringify(roleRules || []) !== JSON.stringify(loaded.doc.role_rules || []);
  if (!auditChanges.length && !roleChanged) {
    sendJson(res, 200, {
      configured: true,
      revision: loaded.doc.revision,
      changes: loaded.doc.changes,
      role_rules: effectiveRoleRules(loaded.doc.role_rules),
      saved: false,
    });
    logger.request(logReq, 200, { reason: 'unchanged' });
    return true;
  }
  const revision = loaded.doc.revision + 1;
  const audit = loaded.doc.audit.concat([{
    at: new Date().toISOString(),
    actor_id: String(session.discordUserId || ''),
    actor_name: actorName(session),
    revision,
    changes: auditChanges,
    role_rules_changed: roleChanged,
  }]).slice(-AUDIT_LIMIT);
  const doc = {
    revision,
    updated_at: new Date().toISOString(),
    changes: validated.changes,
    role_rules: roleRules,
    audit,
  };
  const saved = ctx.catalogStore.save(doc);
  if (!saved.ok) {
    sendJson(res, 503, { error: saved.reason, configured: false });
    logger.request(logReq, 503, { reason: saved.reason });
    return true;
  }
  sendJson(res, 200, { configured: true, revision, changes: doc.changes, role_rules: effectiveRoleRules(doc.role_rules), saved: true });
  logger.request(logReq, 200, { user: session.discordUserId, revision });
  return true;
}

module.exports = { handleCatalogRoutes, publicCatalog };
