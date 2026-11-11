'use strict';

const { mapDiscounts } = require('./discounts');

// Elevated authorization (Trader OR Server Owner OR High Level Staff)
// always re-reads the signed-in user's current guild membership via the
// official self-only OAuth endpoint. Cached or caller-supplied role,
// identity, or mode parameters are ignored. Unconfigured staff IDs fail
// closed. The High Level Staff grant, when configured, is the verified
// unique Discord role "High Lvl Staff" (Design interpretation of Alex's
// 12:24 phrase "High Level Staff" as that known abbreviation — not a
// literal exact-name claim and not a fuzzy neighboring-admin alias).
// Discord Administrator is not treated as a grant.

async function currentMembership(session, oauth, config) {
  if (!session || !session.accessToken) return { inGuild: false, roles: [], member: null };
  const member = await oauth.getCurrentMember(session.accessToken, config.discordGuildId);
  if (!member) return { inGuild: false, roles: [], member: null };
  const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
  return { inGuild: true, roles, member };
}

function grantFlags(config, roles) {
  const set = new Set((roles || []).map(String));
  return {
    trader: Boolean(config.discordTraderRoleId && set.has(String(config.discordTraderRoleId))),
    server_owner: Boolean(config.discordServerOwnerRoleId && set.has(String(config.discordServerOwnerRoleId))),
    high_level_staff: Boolean(
      config.discordHighLevelStaffRoleId && set.has(String(config.discordHighLevelStaffRoleId))
    ),
  };
}

function hasElevatedAccess(config, roles) {
  const grants = grantFlags(config, roles);
  return Boolean(grants.trader || grants.server_owner || grants.high_level_staff);
}

function hasTraderRole(config, roles) {
  return grantFlags(config, roles).trader;
}

function elevatedRoleConfigured(config) {
  return Boolean(
    config.discordTraderRoleId || config.discordServerOwnerRoleId || config.discordHighLevelStaffRoleId
  );
}

function accessPayload(config, membership) {
  const grants = grantFlags(config, membership.roles || []);
  return {
    trader_mode_allowed: hasElevatedAccess(config, membership.roles),
    grants,
    trader_role_configured: Boolean(config.traderRoleConfigured),
    server_owner_role_configured: Boolean(config.serverOwnerRoleConfigured),
    high_level_staff_role_configured: Boolean(config.highLevelStaffRoleConfigured),
    writes: false,
    source: 'live_membership',
  };
}

async function evaluateElevatedAccess(session, oauth, config) {
  if (!elevatedRoleConfigured(config)) {
    return {
      allowed: false,
      status: 403,
      error: 'forbidden',
      reason: 'elevated_role_not_configured',
      in_guild: false,
      is_trader: false,
      access: accessPayload(config, { roles: [] }),
    };
  }
  const membership = await currentMembership(session, oauth, config);
  const access = accessPayload(config, membership);
  if (!access.trader_mode_allowed) {
    return {
      allowed: false,
      status: 403,
      error: 'forbidden',
      reason: 'elevated_role_required',
      in_guild: membership.inGuild,
      is_trader: false,
      access,
      membership,
    };
  }
  return {
    allowed: true,
    status: 200,
    in_guild: membership.inGuild,
    is_trader: access.grants.trader,
    access,
    membership,
  };
}

// Back-compat alias used by existing server routes.
async function evaluateTraderAccess(session, oauth, config) {
  return evaluateElevatedAccess(session, oauth, config);
}

function selfPayload(session, membership, config, extras) {
  const access = accessPayload(config, membership);
  return {
    identity: {
      id: session.discordUserId,
      username: session.username,
      global_name: session.globalName,
    },
    guild: {
      configured: Boolean(config.discordGuildId),
      in_guild: membership.inGuild,
    },
    roles: {
      current: membership.roles,
      trader_role_configured: Boolean(config.traderRoleConfigured),
      server_owner_role_configured: Boolean(config.serverOwnerRoleConfigured),
      high_level_staff_role_configured: Boolean(config.highLevelStaffRoleConfigured),
      is_trader: access.grants.trader,
      is_server_owner: access.grants.server_owner,
      is_high_level_staff: access.grants.high_level_staff,
      discounts: mapDiscounts(membership.roles, config.discordDiscountRoleMap),
    },
    access,
    ...(extras || {}),
  };
}

module.exports = {
  currentMembership,
  hasTraderRole,
  hasElevatedAccess,
  grantFlags,
  accessPayload,
  evaluateElevatedAccess,
  evaluateTraderAccess,
  selfPayload,
};
