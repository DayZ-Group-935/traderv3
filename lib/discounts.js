'use strict';

// Fail-closed calculator discount mapping.
// A membership role applies a calculator discount only when a verified
// Discord role snowflake has been explicitly supplied after a live Copy
// Role ID. Candidate *names* (catalog or calculator labels) are not IDs
// and must never be matched. Discount percentages are not invented here.

function parseVerifiedMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [id, label] of Object.entries(raw)) {
      const key = String(id || '').trim();
      if (!/^\d{17,20}$/.test(key)) continue;
      if (label == null || String(label).trim() === '') continue;
      out[key] = String(label).trim();
    }
    return out;
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return parseVerifiedMap(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return {};
}

function mapDiscounts(roleIds, verifiedMap) {
  const map = parseVerifiedMap(verifiedMap);
  const configured = Object.keys(map).length > 0;
  if (!configured) {
    return {
      configured: false,
      applied: [],
      amounts_mapped: false,
      reason: 'discount_role_ids_unverified',
    };
  }

  const current = new Set((roleIds || []).map((id) => String(id)));
  const applied = [];
  for (const [id, label] of Object.entries(map)) {
    if (current.has(id)) applied.push({ role_id: id, label });
  }

  return {
    configured: true,
    applied,
    amounts_mapped: false,
    reason: applied.length ? 'verified_role_match' : 'no_verified_discount_roles_present',
  };
}

module.exports = { parseVerifiedMap, mapDiscounts };
