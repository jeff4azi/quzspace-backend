// lib/access.js
// Single source of truth for study-space role resolution.
// Roles, ascending privilege: viewer < collaborator < owner.
// Anonymous share-link readers hold no role (null) — they only hit GET /s/:code.
//
// `viewer`        = a regular member (joined from a share link); can study.
// `collaborator`  = a contributor; can do everything the owner can except
//                   space/member/share administration.

const supabase = require('./supabaseClient');
const { AppError } = require('./errors');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

const ROLES = ['viewer', 'collaborator', 'owner'];
const ROLE_RANK = { viewer: 1, collaborator: 2, owner: 3 };

function roleAtLeast(role, min) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 0);
}

// Returns 'owner' | 'collaborator' | 'viewer' | null (null = no access).
async function getSpaceRole(spaceId, userId) {
  if (!spaceId || !userId) return null;

  const { data: space, error } = await supabase
    .from('study_spaces')
    .select('id, owner_id')
    .eq('id', spaceId)
    .maybeSingle();

  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Space lookup failed',
      status: HTTP_STATUS.INTERNAL,
    });
  }
  if (!space) return null;
  if (space.owner_id === userId) return 'owner';

  let member = null;
  try {
    const res = await supabase
      .from('space_collaborators')
      .select('role')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .maybeSingle();
    member = res.data;
  } catch (_e) {
    member = null;
  }
  if (!member) return null;
  return member.role === 'collaborator' ? 'collaborator' : 'viewer';
}

// Throws 403 unless the caller holds at least `min`. Returns the resolved role.
async function assertSpaceRole({ spaceId, userId, min = 'viewer' }) {
  const role = await getSpaceRole(spaceId, userId);
  if (!role) {
    throw new AppError({
      code: ERROR_CODES.FORBIDDEN,
      message: 'You do not have access to this space',
      status: HTTP_STATUS.FORBIDDEN,
    });
  }
  if (!roleAtLeast(role, min)) {
    throw new AppError({
      code: ERROR_CODES.FORBIDDEN,
      message: 'You do not have permission to perform this action',
      status: HTTP_STATUS.FORBIDDEN,
    });
  }
  return role;
}

module.exports = { ROLES, ROLE_RANK, roleAtLeast, getSpaceRole, assertSpaceRole };
