// services/shareService.js
// Base62 8-char share codes + membership (viewers/collaborators) + community leaderboard.

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function generateCode() {
  let code = '';
  const bytes = require('crypto').randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += BASE62[bytes[i] % 62];
  }
  return code;
}

// ---------------------------------------------------------------------------
// createShareLink / deleteShareLink
// ---------------------------------------------------------------------------

async function createShareLink({ spaceId, userId, filesVisible = true }) {
  // Verify ownership
  const { data: space } = await supabase
    .from('study_spaces')
    .select('owner_id')
    .eq('id', spaceId)
    .maybeSingle();

  if (!space) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Space not found', status: HTTP_STATUS.NOT_FOUND });
  if (space.owner_id !== userId) throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Only the owner can create share links', status: HTTP_STATUS.FORBIDDEN });

  // Check if a code already exists for this space
  const { data: existing } = await supabase
    .from('share_codes')
    .select('*')
    .eq('space_id', spaceId)
    .maybeSingle();

  if (existing) {
    // Update files_visible flag if changed
    if (existing.files_visible !== filesVisible) {
      await supabase.from('share_codes').update({ files_visible: filesVisible }).eq('id', existing.id);
    }
    return { ...existing, files_visible: filesVisible };
  }

  // Generate unique code
  let code;
  let attempts = 0;
  do {
    code = generateCode();
    const { data: taken } = await supabase.from('share_codes').select('id').eq('code', code).maybeSingle();
    if (!taken) break;
    attempts++;
  } while (attempts < 10);

  const { data: newCode, error } = await supabase
    .from('share_codes')
    .insert({ space_id: spaceId, code, files_visible: filesVisible, created_by: userId })
    .select('*')
    .maybeSingle();

  if (error || !newCode) {
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: error?.message || 'Failed to create share link', status: HTTP_STATUS.INTERNAL });
  }

  // Log activity (only when a new share link is actually created)
  try {
    const progressService = require('./progressService');
    await progressService.logActivity(spaceId, userId, 'space_shared', 0);
  } catch (e) {
    console.error('[shareService.createShareLink] logActivity error:', e.message);
  }

  return newCode;
}

async function deleteShareLink({ spaceId, userId }) {
  const { data: space } = await supabase.from('study_spaces').select('owner_id').eq('id', spaceId).maybeSingle();
  if (!space) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Space not found', status: HTTP_STATUS.NOT_FOUND });
  if (space.owner_id !== userId) throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Only the owner can revoke the share link', status: HTTP_STATUS.FORBIDDEN });

  const { error } = await supabase.from('share_codes').delete().eq('space_id', spaceId);
  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
}

// ---------------------------------------------------------------------------
// resolveCode — public, no auth required
// ---------------------------------------------------------------------------

async function resolveCode(code) {
  const { data: shareRow } = await supabase
    .from('share_codes')
    .select('space_id, files_visible, created_at')
    .eq('code', code)
    .maybeSingle();

  if (!shareRow) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Share link not found or expired', status: HTTP_STATUS.NOT_FOUND });
  }

  // Fetch space
  const { data: space } = await supabase
    .from('study_spaces')
    .select('id, title, subject, description, accent_style')
    .eq('id', shareRow.space_id)
    .maybeSingle();

  if (!space) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Space not found', status: HTTP_STATUS.NOT_FOUND });

  // Fetch files (redact extracted_text if !files_visible)
  const { data: files } = await supabase
    .from('files')
    .select('id, display_name, mime_type, status, char_count, created_at')
    .eq('space_id', shareRow.space_id)
    .eq('status', 'processed');

  // Fetch summary
  const { data: summary } = await supabase
    .from('summaries')
    .select('data')
    .eq('space_id', shareRow.space_id)
    .eq('status', 'ready')
    .maybeSingle();

  // Read-only preview material for visitors without an account.
  // Quizzes are exposed as metadata only — never with questions or answers.
  const { data: quizzes } = await supabase
    .from('quizzes')
    .select('id, title, difficulty, question_count, selected_topics, created_at')
    .eq('space_id', shareRow.space_id)
    .order('created_at', { ascending: false });

  const { data: flashcards } = await supabase
    .from('flashcards')
    .select('id, front, back, topic, difficulty, position')
    .eq('space_id', shareRow.space_id)
    .order('position', { ascending: true });

  // Community panels (leaderboard + active viewers) for the public page.
  let community = { leaderboard: [] };
  try {
    community = await buildCommunity(shareRow.space_id, null);
  } catch (e) {
    console.error('[shareService.resolveCode] community build failed:', e.message);
  }

  return {
    space,
    filesVisible: shareRow.files_visible,
    files: shareRow.files_visible ? (files || []) : [],
    summary: summary?.data || null,
    quizzes: quizzes || [],
    flashcards: flashcards || [],
    share: {
      share_code: code,
      files_visible: shareRow.files_visible,
      created_at: shareRow.created_at || null,
    },
    // Component-ready entries for <Leaderboard /> on SharedSpace.
    leaderboard: (community.leaderboard || []).map((e) => ({
      id: e.user_id,
      name: e.name,
      avatarInitials: e.avatar_initials,
      avatarColor: e.avatar_color,
      role: e.role,
      bestScore: e.best_score,
      quizzesTaken: e.quizzes_taken,
      flashcardsReviewed: e.flashcards_reviewed,
    })),
    active_viewers: await fetchActiveViewers(shareRow.space_id),
  };
}

// ---------------------------------------------------------------------------
// Membership (self-service) — replaces the old email-invite flow
// ---------------------------------------------------------------------------

// A logged-in user saves a shared space to their dashboard → becomes a `viewer`.
// Idempotent: re-joining never demotes an existing collaborator.
async function joinSpace({ spaceId, userId }) {
  const { data: space } = await supabase
    .from('study_spaces')
    .select('owner_id')
    .eq('id', spaceId)
    .maybeSingle();
  if (!space) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Space not found', status: HTTP_STATUS.NOT_FOUND });

  // The owner already has full access — nothing to join.
  if (space.owner_id === userId) return { role: 'owner', joined: false };

  const { data: existing } = await supabase
    .from('space_collaborators')
    .select('role')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) return { role: existing.role || 'viewer', joined: false };

  // Only spaces with an active share link accept new members.
  const { data: shareRow } = await supabase
    .from('share_codes')
    .select('id')
    .eq('space_id', spaceId)
    .maybeSingle();
  if (!shareRow) {
    throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'This space is not accepting new members', status: HTTP_STATUS.FORBIDDEN });
  }

  const { error } = await supabase
    .from('space_collaborators')
    .insert({ space_id: spaceId, user_id: userId, role: 'viewer' });
  if (error) {
    // Concurrent join → unique violation; treat as already joined.
    const { data: retry } = await supabase
      .from('space_collaborators')
      .select('role')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (retry) return { role: retry.role || 'viewer', joined: false };
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
  }

  return { role: 'viewer', joined: true };
}

// A viewer/collaborator removes the space from their own dashboard.
async function leaveSpace({ spaceId, userId }) {
  const { data: space } = await supabase.from('study_spaces').select('owner_id').eq('id', spaceId).maybeSingle();
  if (!space) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Space not found', status: HTTP_STATUS.NOT_FOUND });
  if (space.owner_id === userId) {
    throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Owners cannot leave their own space', status: HTTP_STATUS.FORBIDDEN });
  }

  const { error } = await supabase
    .from('space_collaborators')
    .delete()
    .eq('space_id', spaceId)
    .eq('user_id', userId);
  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
}

// Owner promotes a viewer → collaborator (or demotes back).
async function updateCollaboratorRole({ spaceId, userId, targetUserId, role }) {
  if (role !== 'viewer' && role !== 'collaborator') {
    throw new AppError({ code: ERROR_CODES.VALIDATION_ERROR, message: "role must be 'viewer' or 'collaborator'", status: HTTP_STATUS.BAD_REQUEST });
  }

  const { data: space } = await supabase.from('study_spaces').select('owner_id').eq('id', spaceId).maybeSingle();
  if (!space) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Space not found', status: HTTP_STATUS.NOT_FOUND });
  if (space.owner_id !== userId) throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Only the owner can change member roles', status: HTTP_STATUS.FORBIDDEN });
  if (targetUserId === space.owner_id) throw new AppError({ code: ERROR_CODES.VALIDATION_ERROR, message: 'The owner role cannot be changed', status: HTTP_STATUS.BAD_REQUEST });

  const { data: existing } = await supabase
    .from('space_collaborators')
    .select('user_id')
    .eq('space_id', spaceId)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (!existing) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Member not found in this space', status: HTTP_STATUS.NOT_FOUND });

  const { error } = await supabase
    .from('space_collaborators')
    .update({ role })
    .eq('space_id', spaceId)
    .eq('user_id', targetUserId);
  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });

  return { userId: targetUserId, role };
}

async function removeCollaborator({ spaceId, userId, targetUserId }) {
  const { data: space } = await supabase.from('study_spaces').select('owner_id').eq('id', spaceId).maybeSingle();
  if (!space || space.owner_id !== userId) throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Only the owner can remove members', status: HTTP_STATUS.FORBIDDEN });

  await supabase.from('space_collaborators').delete().eq('space_id', spaceId).eq('user_id', targetUserId);
}

// ---------------------------------------------------------------------------
// community helpers
// ---------------------------------------------------------------------------

// Deterministic avatar palette — mirrors the frontend AVATAR_COLORS list.
const AVATAR_COLORS = [
  'bg-brand', 'bg-purple-600', 'bg-emerald-600', 'bg-amber-600',
  'bg-rose-600', 'bg-blue-600', 'bg-teal-600', 'bg-indigo-600',
];

function buildAvatarInitials(name, email) {
  const src = (name || email || 'U').trim();
  if (!src) return 'U';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function pickAvatarColor(seed = '') {
  const s = String(seed);
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function profileName(profile) {
  const p = profile || {};
  return p.display_name || p.name || 'Member';
}

// Public-safe list of recently active viewers (for <AvatarStack /> on shared pages).
async function fetchActiveViewers(spaceId, windowMinutes = 15) {
  try {
    const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('activity_logs')
      .select('user_id, created_at, profile:profiles(id, name, display_name, avatar_url)')
      .eq('space_id', spaceId)
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error || !data) return [];

    const seen = new Set();
    const viewers = [];
    for (const row of data) {
      if (!row.user_id || seen.has(row.user_id)) continue;
      seen.add(row.user_id);
      const name = profileName(row.profile);
      viewers.push({
        id: row.user_id,
        name,
        avatarInitials: buildAvatarInitials(name, null),
        avatarColor: pickAvatarColor(row.user_id),
      });
    }
    return viewers;
  } catch (e) {
    console.error('[shareService.fetchActiveViewers] failed:', e.message);
    return [];
  }
}

// Builds the { owner, contributors, viewers, leaderboard, my_role } payload shared
// by getCommunity() (authed) and resolveCode() (public, userId = null).
async function buildCommunity(spaceId, userId = null) {
  const [spaceRes, membersRes, attemptsRes, masteryRes] = await Promise.all([
    supabase
      .from('study_spaces')
      .select('owner_id, created_at, owner_profile:profiles!study_spaces_owner_id_fkey(id, name, display_name, avatar_url)')
      .eq('id', spaceId)
      .maybeSingle(),
    supabase
      .from('space_collaborators')
      .select('user_id, role, joined_at, profile:profiles(id, name, display_name, avatar_url)')
      .eq('space_id', spaceId),
    supabase
      .from('quiz_attempts')
      .select('user_id, score_percent')
      .eq('space_id', spaceId)
      .not('submitted_at', 'is', null),
    supabase
      .from('flashcard_mastery')
      .select('user_id, flashcard:flashcards!inner(space_id)')
      .eq('flashcard.space_id', spaceId),
  ]);

  const ownerId = spaceRes?.data?.owner_id || null;
  const members = membersRes?.data || [];
  const attempts = attemptsRes?.data || [];
  const mastery = masteryRes?.data || [];

  const memberByUser = new Map();
  for (const m of members) memberByUser.set(m.user_id, m);

  const profileByUser = new Map();
  const ownerProfile = spaceRes?.data?.owner_profile;
  if (ownerId && ownerProfile) profileByUser.set(ownerId, ownerProfile);
  for (const m of members) if (m.profile) profileByUser.set(m.user_id, m.profile);

  // Per-user aggregates (submitted attempts only — filtered in the query above).
  const attemptsByUser = new Map();
  for (const a of attempts) {
    if (!a.user_id) continue;
    const cur = attemptsByUser.get(a.user_id) || { count: 0, best: 0, sum: 0 };
    const pct = Number(a.score_percent) || 0;
    cur.count += 1;
    cur.sum += pct;
    cur.best = Math.max(cur.best, pct);
    attemptsByUser.set(a.user_id, cur);
  }

  const masteryByUser = new Map();
  for (const m of mastery) {
    if (!m.user_id) continue;
    masteryByUser.set(m.user_id, (masteryByUser.get(m.user_id) || 0) + 1);
  }

  const roleFor = (id) => {
    if (!id) return null;
    if (id === ownerId) return 'owner';
    const m = memberByUser.get(id);
    if (!m) return null;
    return m.role === 'collaborator' ? 'collaborator' : 'viewer';
  };

  const entryFor = (id, extra = {}) => {
    const name = profileName(profileByUser.get(id));
    const stats = attemptsByUser.get(id);
    return {
      user_id: id,
      id,
      name,
      avatar_initials: buildAvatarInitials(name, null),
      avatar_color: pickAvatarColor(id),
      role: roleFor(id),
      quizzes_taken: stats?.count || 0,
      flashcards_reviewed: masteryByUser.get(id) || 0,
      avg_score: stats && stats.count ? Math.round(stats.sum / stats.count) : 0,
      best_score: stats ? Math.round(stats.best) : 0,
      is_current_user: !!userId && id === userId,
      ...extra,
    };
  };

  const ownerEntry = ownerId
    ? entryFor(ownerId, { joined_at: spaceRes?.data?.created_at || null })
    : null;

  const contributors = [];
  const viewers = [];
  for (const m of members) {
    const entry = entryFor(m.user_id, { joined_at: m.joined_at || null });
    if (entry.role === 'collaborator') contributors.push(entry);
    else viewers.push(entry);
  }
  contributors.sort((a, b) => b.best_score - a.best_score);
  viewers.sort((a, b) => b.best_score - a.best_score);

  const leaderboard = [ownerEntry, ...contributors, ...viewers]
    .filter(Boolean)
    .sort((a, b) => b.best_score - a.best_score);

  return {
    owner: ownerEntry,
    contributors,
    viewers,
    leaderboard,
    my_role: userId ? roleFor(userId) : null,
  };
}

// ---------------------------------------------------------------------------
// community stats (authed) — powers the Community tab
// ---------------------------------------------------------------------------

async function getCommunity(spaceId, userId = null, origin = null) {
  const community = await buildCommunity(spaceId, userId);

  const { data: shareRow } = await supabase
    .from('share_codes')
    .select('code, files_visible, created_at')
    .eq('space_id', spaceId)
    .maybeSingle();

  return {
    owner: community.owner,
    contributors: community.contributors,
    viewers: community.viewers,
    leaderboard: community.leaderboard,
    my_role: community.my_role,
    share: {
      enabled: !!shareRow,
      share_code: shareRow?.code || null,
      share_url: shareRow ? `${origin || ''}/s/${shareRow.code}` : null,
      files_visible: shareRow?.files_visible ?? null,
      created_at: shareRow?.created_at || null,
    },
  };
}

module.exports = {
  createShareLink,
  deleteShareLink,
  resolveCode,
  joinSpace,
  leaveSpace,
  updateCollaboratorRole,
  removeCollaborator,
  getCommunity,
  buildCommunity,
};
