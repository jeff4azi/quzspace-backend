const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES, FILES, PROGRESS } = require('../config/constants');

function buildAvatarInitials(name, email) {
  const src = (name || email || 'U').trim();
  if (!src) return 'U';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function buildMemberFromProfile({ profile, authEmail, roleOverride }) {
  const p = profile || {};
  const email = authEmail || null;
  const name = p.display_name || p.name || (email ? email.split('@')[0] : 'User');
  return {
    id: p.id || null,
    name,
    email,
    role: roleOverride || 'collaborator',
    avatarInitials: buildAvatarInitials(name, email),
    avatarColor: 'bg-brand',
    avatarUrl: p.avatar_url || null,
  };
}

async function hydrateAggregates({ spaceIds, userId }) {
  const ids = Array.isArray(spaceIds) ? spaceIds : [spaceIds];
  const safeIds = ids.filter(Boolean);

  const fileCountMap = {};
  const progressMap = {};
  const membersMap = {};
  for (const sid of safeIds) {
    fileCountMap[sid] = 0;
    progressMap[sid] = {
      quiz_avg: 0,
      flashcard_ratio: 0,
      summary_present: 0,
      last_accessed: new Date().toISOString(),
      progress_percent: 0,
    };
    membersMap[sid] = [];
  }

  if (safeIds.length === 0) {
    return { fileCountMap, progressMap, membersMap };
  }

  const weights = (PROGRESS && PROGRESS.MASTERY_WEIGHTS) || {
    QUIZ_SCORE: 0.4,
    FLASHCARD_RATIO: 0.4,
    SUMMARY_PRESENCE: 0.2,
  };

  const [
    filesRows,
    quizzesRows,
    attemptsRows,
    flashcardsRows,
    masteryRows,
    summariesRows,
    activityRows,
    ownerRows,
    collabRows,
    spaceRows,
  ] = await Promise.all([
    (async () => {
      try {
        const { data } = await supabase.from('files').select('space_id').in('space_id', safeIds);
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase.from('quizzes').select('id, space_id').in('space_id', safeIds);
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase.from('quiz_attempts').select('quiz_id, score, user_id').eq('user_id', userId);
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase.from('flashcards').select('id, space_id').in('space_id', safeIds);
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase.from('flashcard_mastery').select('flashcard_id, user_id').eq('user_id', userId);
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase
          .from('summaries')
          .select('space_id, status')
          .in('space_id', safeIds)
          .in('status', ['processed', 'ready', 'complete']);
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase
          .from('activity_logs')
          .select('space_id, created_at, event_type, user_id')
          .in('space_id', safeIds)
          .eq('event_type', 'space_visit')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase
          .from('study_spaces')
          .select('id, owner_id, updated_at')
          .in('id', safeIds);
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase
          .from('space_collaborators')
          .select('space_id, user_id, role, joined_at')
          .in('space_id', safeIds)
          .order('joined_at', { ascending: false });
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
    (async () => {
      try {
        const { data } = await supabase.from('profiles').select('id, display_name, name, avatar_url').in('id', []);
        return Array.isArray(data) ? data : [];
      } catch (_e) { return []; }
    })(),
  ]);

  const updatedAtById = {};
  const ownerIdById = {};
  for (const r of ownerRows) {
    updatedAtById[r.id] = r.updated_at;
    ownerIdById[r.id] = r.owner_id;
  }
  const profileUserIds = new Set();
  for (const r of ownerRows) if (r.owner_id) profileUserIds.add(r.owner_id);
  for (const r of collabRows) if (r.user_id) profileUserIds.add(r.user_id);

  let profilesRows = [];
  if (profileUserIds.size > 0) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id, display_name, name, avatar_url')
        .in('id', Array.from(profileUserIds));
      profilesRows = Array.isArray(data) ? data : [];
    } catch (_e) { profilesRows = []; }
  }
  const profilesById = {};
  for (const p of profilesRows) profilesById[p.id] = p;

  // Aggregate: file count
  for (const f of filesRows) {
    if (f.space_id) fileCountMap[f.space_id] = (fileCountMap[f.space_id] || 0) + 1;
  }

  // Aggregate: quiz average (current user's attempts joined through quiz)
  const quizIdToSpaceId = {};
  for (const q of quizzesRows) quizIdToSpaceId[q.id] = q.space_id;

  const quizScoresBySpace = {};
  for (const sid of safeIds) quizScoresBySpace[sid] = { total: 0, count: 0 };
  for (const attempt of attemptsRows) {
    const spaceId = quizIdToSpaceId[attempt.quiz_id];
    if (!spaceId) continue;
    let score = attempt.score;
    if (typeof score === 'number' && score > 1.01) score = score / 100;
    if (typeof score === 'number' && !Number.isNaN(score)) {
      quizScoresBySpace[spaceId].total += Math.max(0, Math.min(1, score));
      quizScoresBySpace[spaceId].count += 1;
    }
  }

  // Aggregate: flashcards + mastery (current user's mastery)
  const flashCountBySpace = {};
  for (const f of flashcardsRows) {
    flashCountBySpace[f.space_id] = (flashCountBySpace[f.space_id] || 0) + 1;
  }
  const flashcardIdSet = new Set(flashcardsRows.map(f => f.id));
  const masteryCountBySpace = {};
  for (const sid of safeIds) masteryCountBySpace[sid] = 0;
  for (const m of masteryRows) {
    if (!flashcardIdSet.has(m.flashcard_id)) continue;
    const flash = flashcardsRows.find(f => f.id === m.flashcard_id);
    if (flash && flash.space_id) masteryCountBySpace[flash.space_id] += 1;
  }

  // Aggregate: summary presence
  const summaryPresentSet = new Set();
  for (const s of summariesRows) if (s.space_id) summaryPresentSet.add(s.space_id);

  // Aggregate: last_accessed (per current user, scoped via activity_logs user_id filter above)
  const lastVisitBySpace = {};
  for (const a of activityRows) {
    if (!a.space_id || lastVisitBySpace[a.space_id]) continue;
    lastVisitBySpace[a.space_id] = a.created_at;
  }

  // Finalize progressMap per space
  for (const sid of safeIds) {
    const q = quizScoresBySpace[sid];
    const quiz_avg = q.count > 0 ? q.total / q.count : 0;

    const flashTotal = flashCountBySpace[sid] || 0;
    const flashMastered = masteryCountBySpace[sid] || 0;
    const flashcard_ratio = flashTotal > 0 ? flashMastered / flashTotal : 0;

    const summary_present = summaryPresentSet.has(sid) ? 1 : 0;

    const lastVisit = lastVisitBySpace[sid];
    const updTs = updatedAtById[sid];
    let last_accessed = null;
    const tsVisit = lastVisit ? new Date(lastVisit).getTime() : 0;
    const tsUpd = updTs ? new Date(updTs).getTime() : 0;
    if (tsVisit > 0 || tsUpd > 0) last_accessed = new Date(Math.max(tsVisit, tsUpd)).toISOString();
    if (!last_accessed) last_accessed = new Date().toISOString();

    const progress_percent = Math.round(
      (weights.QUIZ_SCORE * quiz_avg +
        weights.FLASHCARD_RATIO * flashcard_ratio +
        weights.SUMMARY_PRESENCE * summary_present) * 100
    );

    progressMap[sid] = {
      quiz_avg,
      flashcard_ratio,
      summary_present,
      last_accessed,
      progress_percent: Math.max(0, Math.min(100, progress_percent)),
    };
  }

  // Aggregate: active members
  for (const row of ownerRows) {
    const ownerId = row.owner_id;
    const ownerProfile = profilesById[ownerId] || {};
    const member = buildMemberFromProfile({
      profile: ownerProfile,
      authEmail: null,
      roleOverride: 'owner',
    });
    if (!member.id) member.id = ownerId;
    membersMap[row.id] = [member];
  }

  const collabsAddedCount = {};
  for (const sid of safeIds) collabsAddedCount[sid] = 0;
  for (const row of collabRows) {
    const sid = row.space_id;
    if (!sid || collabsAddedCount[sid] >= 3) continue;
    const profile = profilesById[row.user_id] || {};
    const member = buildMemberFromProfile({
      profile: profile,
      authEmail: null,
      roleOverride: row.role || 'collaborator',
    });
    if (!member.id) member.id = row.user_id;
    membersMap[sid] = [...(membersMap[sid] || []), member];
    collabsAddedCount[sid] += 1;
  }

  return { fileCountMap, progressMap, membersMap };
}

async function listForUser(userId) {
  let rows = [];
  let error = null;
  try {
    const res = await supabase
      .from('study_spaces')
      .select('*')
      .or(`owner_id.eq.${userId},space_collaborators.user_id.eq.${userId}`)
      .order('updated_at', { ascending: false });
    rows = Array.isArray(res.data) ? res.data : [];
    error = res.error;
  } catch (raw) {
    error = raw;
  }

  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Failed to list spaces',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  const spaceIds = rows.map(r => r.id);
  const { fileCountMap, progressMap, membersMap } = spaceIds.length
    ? await hydrateAggregates({ spaceIds, userId })
    : { fileCountMap: {}, progressMap: {}, membersMap: {} };

  return rows.map(space => {
    const agg = progressMap[space.id] || {
      progress_percent: 0,
      last_accessed: space.updated_at || new Date().toISOString(),
    };
    return {
      id: space.id,
      title: space.title,
      subject: space.subject,
      accent_style: space.accent_style,
      description: space.description || null,
      owner_id: space.owner_id,
      files_visible: typeof space.files_visible === 'boolean' ? space.files_visible : true,
      file_count: fileCountMap[space.id] || 0,
      progress_percent: agg.progress_percent || 0,
      last_accessed: agg.last_accessed || space.updated_at || new Date().toISOString(),
      active_members: Array.isArray(membersMap[space.id]) && membersMap[space.id].length > 0
        ? membersMap[space.id]
        : [{
            id: space.owner_id,
            name: 'You',
            email: null,
            role: 'owner',
            avatarInitials: 'YO',
            avatarColor: 'bg-brand',
          }],
      created_at: space.created_at,
      updated_at: space.updated_at,
    };
  });
}

async function create({ userId, title, subject, accentStyle, pastedText }) {
  const insertData = {
    title,
    subject: subject || 'General',
    accent_style: accentStyle || 'earth',
    owner_id: userId,
  };

  let space = null;
  let error = null;
  try {
    const res = await supabase
      .from('study_spaces')
      .insert(insertData)
      .select('*')
      .maybeSingle();
    space = res.data;
    error = res.error;
  } catch (raw) { error = raw; }

  if (error || !space) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error?.message || 'Failed to create space',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  if (typeof pastedText === 'string' && pastedText.trim().length > 0) {
    const maxChars = FILES.MAX_EXTRACTED_TEXT_CHARS || 2000000;
    const charCount = pastedText.length;
    const extracted = pastedText.slice(0, maxChars);
    try {
      await supabase.from('files').insert({
        space_id: space.id,
        uploader_id: userId,
        source_kind: 'pasted_text',
        display_name: 'Pasted Text',
        file_extension: 'txt',
        mime_type: 'text/plain',
        size_bytes: Buffer.byteLength(extracted, 'utf8'),
        status: FILES.STATUS ? FILES.STATUS.PROCESSED : 'processed',
        extracted_text: extracted,
        text_truncated: charCount > maxChars,
        char_count: charCount,
      });
    } catch (_e) {}
  }

  return getById({ spaceId: space.id, userId });
}

async function getById({ spaceId, userId }) {
  let row = null;
  let error = null;
  try {
    const res = await supabase
      .from('study_spaces')
      .select('*')
      .eq('id', spaceId)
      .maybeSingle();
    row = res.data;
    error = res.error;
  } catch (raw) { error = raw; }

  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Failed to fetch space',
      status: HTTP_STATUS.INTERNAL,
    });
  }
  if (!row) {
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: `Space ${spaceId} not found`,
      status: HTTP_STATUS.NOT_FOUND,
    });
  }

  let role = null;
  if (row.owner_id === userId) {
    role = 'owner';
  } else {
    try {
      const cr = await supabase
        .from('space_collaborators')
        .select('role')
        .eq('space_id', spaceId)
        .eq('user_id', userId)
        .maybeSingle();
      if (cr && cr.data) role = cr.data.role || 'collaborator';
    } catch (_e) {}
  }

  if (!role) {
    throw new AppError({
      code: ERROR_CODES.FORBIDDEN,
      message: 'You do not have access to this space',
      status: HTTP_STATUS.FORBIDDEN,
    });
  }

  const { fileCountMap, progressMap, membersMap } = await hydrateAggregates({
    spaceIds: [spaceId], userId,
  });
  const agg = progressMap[spaceId] || {
    progress_percent: 0,
    last_accessed: row.updated_at || new Date().toISOString(),
  };

  const activeMembers = Array.isArray(membersMap[spaceId]) && membersMap[spaceId].length > 0
    ? membersMap[spaceId]
    : [{
        id: row.owner_id,
        name: 'You',
        email: null,
        role: 'owner',
        avatarInitials: 'YO',
        avatarColor: 'bg-brand',
      }];

  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    accent_style: row.accent_style,
    description: row.description || null,
    owner_id: row.owner_id,
    files_visible: typeof row.files_visible === 'boolean' ? row.files_visible : true,
    file_count: fileCountMap[spaceId] || 0,
    progress_percent: agg.progress_percent || 0,
    last_accessed: agg.last_accessed || row.updated_at || new Date().toISOString(),
    active_members: activeMembers,
    created_at: row.created_at,
    updated_at: row.updated_at,
    role,
  };
}

async function update({ spaceId, userId, patch }) {
  const existing = await getById({ spaceId, userId });
  if (existing.role !== 'owner') {
    throw new AppError({
      code: ERROR_CODES.FORBIDDEN,
      message: 'Only the owner can update this space',
      status: HTTP_STATUS.FORBIDDEN,
    });
  }

  const allowedKeys = ['title', 'subject', 'accent_style', 'description', 'files_visible'];
  const cleaned = {};
  if (patch && typeof patch === 'object') {
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) cleaned[key] = patch[key];
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'accentStyle')) cleaned.accent_style = patch.accentStyle;
  }

  if (Object.keys(cleaned).length === 0) return existing;

  let updated = null;
  let error = null;
  try {
    const res = await supabase
      .from('study_spaces')
      .update(cleaned)
      .eq('id', spaceId)
      .select('*')
      .maybeSingle();
    updated = res.data;
    error = res.error;
  } catch (raw) { error = raw; }

  if (error || !updated) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error?.message || 'Failed to update space',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  return getById({ spaceId, userId });
}

async function remove({ spaceId, userId }) {
  const existing = await getById({ spaceId, userId });
  if (existing.role !== 'owner') {
    throw new AppError({
      code: ERROR_CODES.FORBIDDEN,
      message: 'Only the owner can delete this space',
      status: HTTP_STATUS.FORBIDDEN,
    });
  }
  let error = null;
  try {
    const res = await supabase.from('study_spaces').delete().eq('id', spaceId);
    error = res.error;
  } catch (raw) { error = raw; }
  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Failed to delete space',
      status: HTTP_STATUS.INTERNAL,
    });
  }
}

async function recordVisit({ spaceId, userId }) {
  await getById({ spaceId, userId });
  try {
    await supabase.from('activity_logs').insert({
      space_id: spaceId,
      user_id: userId,
      event_type: 'space_visit',
      minutes_estimate: 0,
      meta: {},
    });
  } catch (_e) {}
  return new Date().toISOString();
}

module.exports = {
  buildAvatarInitials,
  hydrateAggregates,
  listForUser,
  create,
  getById,
  update,
  remove,
  recordVisit,
};
