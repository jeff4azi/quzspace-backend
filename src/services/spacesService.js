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

function buildMember({ profile, ownerId, userId, roleOverride }) {
  const id = userId || ownerId || (profile && profile.id) || null;
  const p = profile || {};
  const email = null;
  const name = p.display_name || p.name || 'Member';
  return {
    id,
    name,
    email,
    role: roleOverride || 'collaborator',
    avatarInitials: buildAvatarInitials(name, email),
    avatarColor: 'bg-brand',
    avatarUrl: p.avatar_url || null,
  };
}

async function verifyAccess({ spaceId, userId }) {
  let row = null;
  let error = null;
  try {
    const res = await supabase
      .from('study_spaces')
      .select('id, owner_id, updated_at')
      .eq('id', spaceId)
      .maybeSingle();
    row = res.data;
    error = res.error;
  } catch (raw) { error = raw; }
  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Space lookup failed',
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
  if (row.owner_id === userId) role = 'owner';
  else {
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
  return { row, role };
}

async function hydrateAggregates({ baseRows, userId }) {
  const safeIds = (Array.isArray(baseRows) ? baseRows : []).map(r => r.id).filter(Boolean);
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

  const updatedAtById = {};
  const ownerIdById = {};
  const ownerProfileById = {};
  for (const r of baseRows) {
    updatedAtById[r.id] = r.updated_at;
    ownerIdById[r.id] = r.owner_id;
    if (r.owner_profile && typeof r.owner_profile === 'object') {
      ownerProfileById[r.owner_id] = r.owner_profile;
    }
  }

  const weights = (PROGRESS && PROGRESS.MASTERY_WEIGHTS) || {
    QUIZ_SCORE: 0.4, FLASHCARD_RATIO: 0.4, SUMMARY_PRESENCE: 0.2,
  };

  let batchSimple = null;
  let batchProgress = null;
  try {
    const res = await supabase
      .from('study_spaces')
      .select(`
        id,
        files!left(space_id),
        summaries!left(space_id, status),
        visits:activity_logs!left(space_id, user_id, event_type, created_at),
        space_collaborators!left(space_id, user_id, role, joined_at, profile:profiles!user_id(id, display_name, name, avatar_url))
      `)
      .in('id', safeIds);
    batchSimple = Array.isArray(res.data) ? res.data : [];
  } catch (_e) { batchSimple = []; }

  try {
    const res = await supabase
      .from('study_spaces')
      .select(`
        id,
        flashcards!left(id, space_id, mastery:flashcard_mastery!left(user_id)),
        quizzes!left(id, space_id, attempts:quiz_attempts!left(user_id, score))
      `)
      .in('id', safeIds);
    batchProgress = Array.isArray(res.data) ? res.data : [];
  } catch (_e) { batchProgress = []; }

  const filesRows = [];
  const summariesRows = [];
  const activityRows = [];
  const collabRows = [];
  for (const row of batchSimple || []) {
    const sid = row.id;
    if (Array.isArray(row.files)) {
      for (const f of row.files) filesRows.push({ space_id: sid, ...f });
    }
    if (Array.isArray(row.summaries)) {
      for (const s of row.summaries) {
        const st = s && (s.status === 'processed' || s.status === 'ready' || s.status === 'complete');
        if (st) summariesRows.push({ space_id: sid, status: s.status });
      }
    }
    if (Array.isArray(row.visits)) {
      for (const v of row.visits) {
        if (v && v.user_id === userId && v.event_type === 'space_visit') {
          activityRows.push({ space_id: sid, created_at: v.created_at });
        }
      }
    }
    if (Array.isArray(row.space_collaborators)) {
      for (const c of row.space_collaborators) {
        collabRows.push({ space_id: sid, user_id: c.user_id, role: c.role, joined_at: c.joined_at, profile: c.profile });
      }
    }
  }
  activityRows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  collabRows.sort((a, b) => new Date(b.joined_at) - new Date(a.joined_at));

  const flashData = [];
  const attemptsRows = [];
  for (const row of batchProgress || []) {
    const sid = row.id;
    if (Array.isArray(row.flashcards)) {
      for (const f of row.flashcards) flashData.push({ space_id: sid, ...f });
    }
    if (Array.isArray(row.quizzes)) {
      for (const q of row.quizzes) {
        if (!q || !Array.isArray(q.attempts)) continue;
        for (const a of q.attempts) attemptsRows.push({ score: a.score, quiz: { space_id: sid } });
      }
    }
  }

  for (const f of filesRows) {
    if (f.space_id) fileCountMap[f.space_id] = (fileCountMap[f.space_id] || 0) + 1;
  }

  const quizScoreBySpace = {};
  for (const sid of safeIds) quizScoreBySpace[sid] = { total: 0, count: 0 };
  for (const a of attemptsRows) {
    const q = a.quiz;
    const spaceId = Array.isArray(q) ? q[0] && q[0].space_id : q && q.space_id;
    if (!spaceId) continue;
    let score = a.score;
    if (typeof score === 'number' && score > 1.01) score = score / 100;
    if (typeof score === 'number' && !Number.isNaN(score)) {
      quizScoreBySpace[spaceId].total += Math.max(0, Math.min(1, score));
      quizScoreBySpace[spaceId].count += 1;
    }
  }

  const flashCountBySpace = {};
  const masteryCountBySpace = {};
  const flashcardIdSpaceMap = new Map();
  for (const sid of safeIds) { flashCountBySpace[sid] = 0; masteryCountBySpace[sid] = 0; }
  for (const f of flashData) {
    if (!f.space_id) continue;
    flashCountBySpace[f.space_id] += 1;
    flashcardIdSpaceMap.set(f.id, f.space_id);
    const userMastery = Array.isArray(f.mastery)
      ? f.mastery.find(m => m && m.user_id === userId)
      : null;
    if (userMastery) masteryCountBySpace[f.space_id] += 1;
  }

  const summaryPresentSet = new Set();
  for (const s of summariesRows) if (s.space_id) summaryPresentSet.add(s.space_id);

  const lastVisitBySpace = {};
  for (const a of activityRows) {
    if (!a.space_id || lastVisitBySpace[a.space_id]) continue;
    lastVisitBySpace[a.space_id] = a.created_at;
  }

  for (const sid of safeIds) {
    const q = quizScoreBySpace[sid];
    const quiz_avg = q.count > 0 ? q.total / q.count : 0;
    const flashTotal = flashCountBySpace[sid] || 0;
    const flashMastered = masteryCountBySpace[sid] || 0;
    const flashcard_ratio = flashTotal > 0 ? flashMastered / flashTotal : 0;
    const summary_present = summaryPresentSet.has(sid) ? 1 : 0;
    const lastVisit = lastVisitBySpace[sid];
    const updTs = updatedAtById[sid];
    const tsVisit = lastVisit ? new Date(lastVisit).getTime() : 0;
    const tsUpd = updTs ? new Date(updTs).getTime() : 0;
    let last_accessed = (tsVisit > 0 || tsUpd > 0)
      ? new Date(Math.max(tsVisit, tsUpd)).toISOString()
      : new Date().toISOString();
    const progress_percent = Math.round(
      (weights.QUIZ_SCORE * quiz_avg +
        weights.FLASHCARD_RATIO * flashcard_ratio +
        weights.SUMMARY_PRESENCE * summary_present) * 100
    );
    progressMap[sid] = {
      quiz_avg, flashcard_ratio, summary_present, last_accessed,
      progress_percent: Math.max(0, Math.min(100, progress_percent)),
    };
  }

  for (const sid of safeIds) {
    const ownerId = ownerIdById[sid];
    const ownerProfile = ownerProfileById[ownerId] || {};
    membersMap[sid] = [buildMember({
      profile: ownerProfile,
      userId: ownerId,
      roleOverride: 'owner',
    })];
  }
  const collabsSeen = {};
  for (const sid of safeIds) collabsSeen[sid] = 0;
  for (const row of collabRows) {
    const sid = row.space_id;
    if (!sid || collabsSeen[sid] >= 3) continue;
    const profile = row.profile || {};
    membersMap[sid].push(buildMember({
      profile,
      userId: row.user_id,
      roleOverride: row.role || 'collaborator',
    }));
    collabsSeen[sid] += 1;
  }
  return { fileCountMap, progressMap, membersMap };
}

async function listForUser(userId) {
  let rows = [];
  let error = null;
  try {
    const res = await supabase
      .from('study_spaces')
      .select(`
        *,
        owner_profile:profiles!study_spaces_owner_id_fkey(id, display_name, name, avatar_url)
      `)
      .or(`owner_id.eq.${userId},space_collaborators!inner.user_id.eq.${userId}`)
      .order('updated_at', { ascending: false });
    rows = Array.isArray(res.data) ? res.data : [];
    error = res.error;
  } catch (raw) { error = raw; }
  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Failed to list spaces',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  const { fileCountMap, progressMap, membersMap } = rows.length
    ? await hydrateAggregates({ baseRows: rows, userId })
    : { fileCountMap: {}, progressMap: {}, membersMap: {} };

  return rows.map(space => {
    const agg = progressMap[space.id] || {
      progress_percent: 0,
      last_accessed: space.updated_at || new Date().toISOString(),
    };
    const members = Array.isArray(membersMap[space.id]) && membersMap[space.id].length > 0
      ? membersMap[space.id]
      : [{
          id: space.owner_id,
          name: 'You',
          email: null,
          role: 'owner',
          avatarInitials: 'YO',
          avatarColor: 'bg-brand',
        }];
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
      active_members: members,
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
    const fileInsert = {
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
    };
    let fErr = null;
    try {
      const { error } = await supabase.from('files').insert(fileInsert);
      fErr = error;
    } catch (raw) { fErr = raw; }
    if (fErr) {
      try {
        await supabase.from('study_spaces').delete().eq('id', space.id);
      } catch (rollbackErr) {
        console.error('[spacesService.create] rollback failed for orphan space:', space.id, rollbackErr && rollbackErr.message ? rollbackErr.message : rollbackErr);
      }
      throw new AppError({
        code: ERROR_CODES.INTERNAL,
        message: fErr.message || 'Failed to create pasted text file',
        status: HTTP_STATUS.INTERNAL,
      });
    }
  }

  return getById({ spaceId: space.id, userId });
}

async function getById({ spaceId, userId }) {
  let row = null;
  let error = null;
  try {
    const res = await supabase
      .from('study_spaces')
      .select(`
        *,
        owner_profile:profiles!study_spaces_owner_id_fkey(id, display_name, name, avatar_url)
      `)
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
  if (row.owner_id === userId) role = 'owner';
  else {
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
    baseRows: [row], userId,
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
  const { row, role } = await verifyAccess({ spaceId, userId });
  if (role !== 'owner') {
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
  if (Object.keys(cleaned).length === 0) return getById({ spaceId, userId });

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
  const { role } = await verifyAccess({ spaceId, userId });
  if (role !== 'owner') {
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
  await verifyAccess({ spaceId, userId });
  let inserted = null;
  let error = null;
  try {
    const res = await supabase
      .from('activity_logs')
      .insert({
        space_id: spaceId,
        user_id: userId,
        event_type: 'space_visit',
        minutes_estimate: 0,
        meta: {},
      })
      .select('created_at')
      .maybeSingle();
    inserted = res.data;
    error = res.error;
  } catch (raw) { error = raw; }
  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Failed to record space visit',
      status: HTTP_STATUS.INTERNAL,
    });
  }
  const dbTs = inserted && inserted.created_at ? new Date(inserted.created_at).toISOString() : null;
  return dbTs || new Date().toISOString();
}

module.exports = {
  buildAvatarInitials,
  hydrateAggregates,
  verifyAccess,
  listForUser,
  create,
  getById,
  update,
  remove,
  recordVisit,
};
