// services/shareService.js
// Base62 8-char share codes + collaborators + community leaderboard.

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
// createShareLink
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
// addCollaborator
// ---------------------------------------------------------------------------

async function addCollaborator({ spaceId, userId, email, role = 'collaborator' }) {
  // Verify ownership
  const { data: space } = await supabase
    .from('study_spaces')
    .select('owner_id')
    .eq('id', spaceId)
    .maybeSingle();
  if (!space) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Space not found', status: HTTP_STATUS.NOT_FOUND });
  if (space.owner_id !== userId) throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Only the owner can add collaborators', status: HTTP_STATUS.FORBIDDEN });

  // Resolve email to user id via admin API
  let targetUserId = null;
  try {
    const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = (users?.users || []).find(u => u.email === email);
    if (found) targetUserId = found.id;
  } catch (err) {
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: 'Could not look up user: ' + err.message, status: HTTP_STATUS.INTERNAL });
  }

  if (!targetUserId) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: `No user found with email ${email}`, status: HTTP_STATUS.NOT_FOUND });
  }

  // Upsert collaborator row
  const { error } = await supabase
    .from('space_collaborators')
    .upsert({ space_id: spaceId, user_id: targetUserId, role }, { onConflict: 'space_id,user_id' });

  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });

  return { userId: targetUserId, email, role };
}

// ---------------------------------------------------------------------------
// removeCollaborator
// ---------------------------------------------------------------------------

async function removeCollaborator({ spaceId, userId, targetUserId }) {
  const { data: space } = await supabase.from('study_spaces').select('owner_id').eq('id', spaceId).maybeSingle();
  if (!space || space.owner_id !== userId) throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Only the owner can remove collaborators', status: HTTP_STATUS.FORBIDDEN });

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

// Builds the collaborator / visitor / leaderboard payload shared by
// getCommunity() (authed) and resolveCode() (public, userId = null).
async function buildCommunity(spaceId, userId = null) {
  const [spaceRes, collabRes, attemptsRes, masteryRes, activityRes] = await Promise.all([
    supabase.from('study_spaces').select('owner_id').eq('id', spaceId).maybeSingle(),
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
    supabase
      .from('activity_logs')
      .select('user_id, created_at, profile:profiles(id, name, display_name, avatar_url)')
      .eq('space_id', spaceId)
      .order('created_at', { ascending: false }),
  ]);

  const ownerId = spaceRes?.data?.owner_id || null;
  const collaborators = collabRes?.data || [];
  const attempts = attemptsRes?.data || [];
  const mastery = masteryRes?.data || [];
  const activity = activityRes?.data || [];

  const collaboratorIds = new Set(collaborators.map((c) => c.user_id));

  // Resolve display profiles from collaborators first, then activity rows.
  const profileByUser = new Map();
  for (const c of collaborators) if (c.profile) profileByUser.set(c.user_id, c.profile);
  for (const a of activity) {
    if (a.user_id && a.profile && !profileByUser.has(a.user_id)) profileByUser.set(a.user_id, a.profile);
  }

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

  // activity is ordered desc → the last write per user is their first visit.
  const firstVisitByUser = new Map();
  for (const row of activity) {
    if (row.user_id) firstVisitByUser.set(row.user_id, row.created_at);
  }

  const roleFor = (id) => {
    if (id === ownerId) return 'owner';
    const c = collaborators.find((x) => x.user_id === id);
    return c ? c.role || 'collaborator' : 'visitor';
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

  const collaboratorsOut = collaborators.map((c) =>
    entryFor(c.user_id, { role: c.role || 'collaborator', joined_at: c.joined_at || null })
  );

  // Visitors = anyone with activity/attempts here who is not the owner or a collaborator.
  const visitorIds = new Set();
  for (const id of [...activity.map((r) => r.user_id), ...attempts.map((r) => r.user_id)]) {
    if (!id || id === ownerId || collaboratorIds.has(id)) continue;
    visitorIds.add(id);
  }

  const visitorsOut = [...visitorIds].map((id) =>
    entryFor(id, { first_visited: firstVisitByUser.get(id) || null })
  );

  // Leaderboard: best score per member across the space.
  const memberIds = new Set([...collaboratorIds, ...visitorIds]);
  if (ownerId) memberIds.add(ownerId);
  const leaderboard = [...memberIds]
    .map((id) => entryFor(id))
    .sort((a, b) => b.best_score - a.best_score);

  return { collaborators: collaboratorsOut, visitors: visitorsOut, leaderboard };
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
    collaborators: community.collaborators,
    visitors: community.visitors,
    link_takers: community.visitors,
    leaderboard: community.leaderboard,
    share: {
      enabled: !!shareRow,
      share_code: shareRow?.code || null,
      share_url: shareRow ? `${origin || ''}/s/${shareRow.code}` : null,
      files_visible: shareRow?.files_visible ?? null,
      created_at: shareRow?.created_at || null,
    },
  };
}

module.exports = { createShareLink, resolveCode, addCollaborator, removeCollaborator, getCommunity };
