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
  return newCode;
}

// ---------------------------------------------------------------------------
// resolveCode — public, no auth required
// ---------------------------------------------------------------------------

async function resolveCode(code) {
  const { data: shareRow } = await supabase
    .from('share_codes')
    .select('space_id, files_visible')
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

  return {
    space,
    filesVisible: shareRow.files_visible,
    files: shareRow.files_visible ? (files || []) : [],
    summary: summary?.data || null,
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
// community stats
// ---------------------------------------------------------------------------

async function getCommunity(spaceId) {
  const [collabRes, attemptsRes, masteryRes, activityRes] = await Promise.all([
    supabase.from('space_collaborators').select('user_id, role, profile:profiles(display_name, name, avatar_url)').eq('space_id', spaceId),
    supabase.from('quiz_attempts').select('user_id, score, quiz_id').eq('space_id', spaceId).not('completed_at', 'is', null),
    supabase.from('flashcard_mastery').select('user_id, flashcard:flashcards!inner(space_id)').eq('flashcard.space_id', spaceId),
    supabase.from('activity_logs').select('user_id, minutes_estimate').eq('space_id', spaceId),
  ]);

  const collaborators = collabRes.data || [];
  const attempts = attemptsRes.data || [];
  const mastery = masteryRes.data || [];
  const activity = activityRes.data || [];

  // Build member stats
  const memberIds = [...new Set(collaborators.map(c => c.user_id))];
  const stats = memberIds.map(memberId => {
    const memberAttempts = attempts.filter(a => a.user_id === memberId);
    const memberMastery = mastery.filter(m => m.user_id === memberId);
    const memberActivity = activity.filter(a => a.user_id === memberId);
    const scores = memberAttempts.map(a => Number(a.score) || 0);
    const collab = collaborators.find(c => c.user_id === memberId);
    const profile = collab?.profile || {};
    return {
      userId: memberId,
      name: profile.display_name || profile.name || 'Member',
      avatarUrl: profile.avatar_url || null,
      role: collab?.role || 'collaborator',
      quizzesTaken: memberAttempts.length,
      flashcardsMastered: memberMastery.length,
      avgScore: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      totalMinutes: memberActivity.reduce((sum, a) => sum + (Number(a.minutes_estimate) || 0), 0),
    };
  });

  // Merged leaderboard: best score per user across all quizzes in space
  const leaderboard = stats
    .map(m => ({ userId: m.userId, name: m.name, avgScore: m.avgScore, quizzesTaken: m.quizzesTaken }))
    .sort((a, b) => b.avgScore - a.avgScore)
    .map((m, idx) => ({ rank: idx + 1, ...m }));

  return { members: stats, leaderboard };
}

module.exports = { createShareLink, resolveCode, addCollaborator, removeCollaborator, getCommunity };
