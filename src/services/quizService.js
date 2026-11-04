// services/quizService.js
// Full DB-backed quiz service — replaces the in-memory Map stub.
// Uses quizzes + quiz_questions + quiz_attempts + quiz_answers tables.

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');
const { assertSpaceRole } = require('../lib/access');
const aiService = require('./aiService');
const contextBuilder = require('./contextBuilder');

const QUIZ_SYSTEM = `You are a quiz generator. Create multiple-choice questions based on the study material.
Respond ONLY with a valid JSON object:
{
  "questions": [
    {
      "stem": "Question text?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswerIndex": 0,
      "explanation": "Brief explanation of why this is correct.",
      "topic": "Topic label"
    }
  ]
}
Each question must have exactly 4 options. correctAnswerIndex is 0-based. Make questions clear, educational, and test genuine understanding.`;

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

async function generate({ spaceId, userId, questionCount = 10, difficulty = 'Mixed', selectedTopics = [] }) {
  const count = Math.max(1, Math.min(50, Number(questionCount) || 10));
  const topics = Array.isArray(selectedTopics) ? selectedTopics.filter(t => typeof t === 'string') : [];
  const title = topics.length > 0
    ? `${topics.slice(0, 2).join(' & ')} Quiz (${difficulty})`
    : `${difficulty} Quiz`;

  // Build context
  const context = await contextBuilder.buildForQuiz(spaceId, topics);
  const topicsLine = topics.length > 0 ? `Focus on these topics: ${topics.join(', ')}.` : '';
  const userPrompt = `${topicsLine}\nDifficulty: ${difficulty}. Generate ${count} questions.\n\nMaterial:\n${context}`;

  let parsed;
  try {
    parsed = await aiService.completeJson({ systemPrompt: QUIZ_SYSTEM, userPrompt });
  } catch (err) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: 'AI failed to generate quiz: ' + err.message,
      status: HTTP_STATUS.INTERNAL,
    });
  }

  const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  if (rawQuestions.length === 0) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: 'AI returned no questions',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  const { provider, model } = aiService.getProviderInfo();

  // Build question rows first (quiz_questions uses question_index + question).
  const questionsToInsert = rawQuestions.slice(0, count).map((q, idx) => ({
    question_index: idx,
    question: q.stem || `Question ${idx + 1}`,
    options: Array.isArray(q.options) ? q.options : ['A', 'B', 'C', 'D'],
    correct_answer_index: typeof q.correctAnswerIndex === 'number' ? q.correctAnswerIndex : 0,
    explanation: q.explanation || '',
    topic: q.topic || (topics[0] || null),
  }));

  // Insert quiz row
  const { data: quiz, error: quizErr } = await supabase
    .from('quizzes')
    .insert({
      space_id: spaceId,
      created_by: userId,
      title,
      question_count: questionsToInsert.length,
      difficulty,
      selected_topics: topics,
      provider,
      model_used: model,
    })
    .select('*')
    .maybeSingle();

  if (quizErr || !quiz) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: quizErr?.message || 'Failed to insert quiz',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  // Insert quiz_questions
  const { error: qErr } = await supabase
    .from('quiz_questions')
    .insert(questionsToInsert.map((q) => ({ ...q, quiz_id: quiz.id })));

  if (qErr) {
    // Roll back the orphan quiz row so it never appears empty in the list.
    try {
      await supabase.from('quizzes').delete().eq('id', quiz.id);
    } catch (rollbackErr) {
      console.error('[quizService.generate] rollback failed for orphan quiz:', quiz.id, rollbackErr?.message || rollbackErr);
    }
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: qErr.message || 'Failed to insert quiz questions',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  return normalizeQuiz(quiz);
}

// ---------------------------------------------------------------------------
// listForSpace
// ---------------------------------------------------------------------------

async function listForSpace(spaceId) {
  const { data, error } = await supabase
    .from('quizzes')
    .select(`
      *,
      attempts:quiz_attempts(id, score_percent, submitted_at)
    `)
    .eq('space_id', spaceId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
  }

  return (data || []).map(quiz => {
    const attempts = Array.isArray(quiz.attempts) ? quiz.attempts.filter(a => a.submitted_at) : [];
    const bestScore = attempts.length > 0
      ? Math.max(...attempts.map(a => Number(a.score_percent) || 0))
      : null;
    return {
      ...normalizeQuiz(quiz),
      attempts_count: attempts.length,
      best_score: bestScore,
    };
  });
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

async function getById({ spaceId, quizId, userId }) {
  // spaceId is optional — the direct /quizzes/:quizId route omits it.
  let query = supabase.from('quizzes').select('*').eq('id', quizId);
  if (spaceId) query = query.eq('space_id', spaceId);
  const { data: quiz, error: quizErr } = await query.maybeSingle();

  if (quizErr || !quiz) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Quiz not found', status: HTTP_STATUS.NOT_FOUND });
  }

  // Direct /quizzes/:quizId route omits the space id — re-check membership here.
  if (!spaceId) {
    await assertSpaceRole({ spaceId: quiz.space_id, userId, min: 'viewer' });
  }

  const { data: questions, error: qErr } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('quiz_id', quizId)
    .order('question_index', { ascending: true });

  if (qErr) throw new AppError({ code: ERROR_CODES.INTERNAL, message: qErr.message, status: HTTP_STATUS.INTERNAL });

  const isOwner = quiz.created_by === userId;

  return {
    ...normalizeQuiz(quiz),
    questions: (questions || []).map(q => formatQuestion(q, isOwner)),
  };
}

// ---------------------------------------------------------------------------
// take: create quiz_attempt row
// ---------------------------------------------------------------------------

async function take({ spaceId, quizId, userId }) {
  // spaceId is optional — resolve it from the quiz when the direct route omits it.
  let query = supabase.from('quizzes').select('id, question_count, space_id').eq('id', quizId);
  if (spaceId) query = query.eq('space_id', spaceId);
  const { data: quiz } = await query.maybeSingle();

  if (!quiz) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Quiz not found', status: HTTP_STATUS.NOT_FOUND });
  }
  const resolvedSpaceId = quiz.space_id;

  // Direct /quizzes/:quizId routes omit the space id — re-check membership here.
  if (!spaceId) {
    await assertSpaceRole({ spaceId: resolvedSpaceId, userId, min: 'viewer' });
  }

  // Attempt numbering is unique per (quiz, user).
  const { count: priorAttempts } = await supabase
    .from('quiz_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('quiz_id', quizId)
    .eq('user_id', userId);

  const { data: attempt, error } = await supabase
    .from('quiz_attempts')
    .insert({
      quiz_id: quizId,
      space_id: resolvedSpaceId,
      user_id: userId,
      attempt_number: (priorAttempts || 0) + 1,
      total_questions: quiz.question_count || 0,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .maybeSingle();

  if (error || !attempt) {
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: error?.message || 'Failed to start attempt', status: HTTP_STATUS.INTERNAL });
  }

  // Return questions WITHOUT correctAnswerIndex
  const { data: questions, error: qErr } = await supabase
    .from('quiz_questions')
    .select('id, question_index, question, options, topic')
    .eq('quiz_id', quizId)
    .order('question_index', { ascending: true });

  if (qErr) throw new AppError({ code: ERROR_CODES.INTERNAL, message: qErr.message, status: HTTP_STATUS.INTERNAL });

  return {
    attemptId: attempt.id,
    attemptNumber: attempt.attempt_number,
    quizId,
    spaceId: resolvedSpaceId,
    startedAt: attempt.started_at,
    questions: (questions || []).map((q) => ({
      id: q.id,
      stem: q.question,
      options: q.options,
      topic: q.topic,
      position: q.question_index,
    })),
  };
}

// ---------------------------------------------------------------------------
// submit: grade attempt + write quiz_answers
// ---------------------------------------------------------------------------

async function submit({ attemptId, userId, answers }) {
  // Fetch attempt
  const { data: attempt, error: aErr } = await supabase
    .from('quiz_attempts')
    .select('*, quiz:quizzes(id, space_id, question_count)')
    .eq('id', attemptId)
    .eq('user_id', userId)
    .maybeSingle();

  if (aErr || !attempt) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Attempt not found', status: HTTP_STATUS.NOT_FOUND });
  }
  if (attempt.submitted_at) {
    throw new AppError({ code: ERROR_CODES.CONFLICT, message: 'Attempt already submitted', status: HTTP_STATUS.CONFLICT });
  }

  const quizId = attempt.quiz_id;
  const spaceId = attempt.quiz?.space_id || attempt.space_id;

  // Fetch questions
  const { data: questions, error: qErr } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('quiz_id', quizId)
    .order('question_index', { ascending: true });

  if (qErr) throw new AppError({ code: ERROR_CODES.INTERNAL, message: qErr.message, status: HTTP_STATUS.INTERNAL });

  const qMap = new Map((questions || []).map(q => [q.id, q]));

  // Grade
  const answersArr = Array.isArray(answers) ? answers : [];
  let correct = 0;
  const gradedAnswers = answersArr.map(a => {
    const q = qMap.get(a.questionId);
    if (!q) return null;
    const selected = typeof a.optionIndex === 'number' ? a.optionIndex : null;
    const isCorrect = selected !== null && selected === Number(q.correct_answer_index);
    if (isCorrect) correct++;
    return {
      attempt_id: attemptId,
      question_id: a.questionId,
      selected_index: selected,
      is_correct: isCorrect,
    };
  }).filter(Boolean);

  const totalQuestions = (questions || []).length;
  const scorePercent = totalQuestions > 0 ? Math.round((correct / totalQuestions) * 100) : 0;
  const now = new Date().toISOString();
  const startedAt = attempt.started_at ? new Date(attempt.started_at) : new Date();
  const timeTakenSec = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));

  // Write quiz_answers
  if (gradedAnswers.length > 0) {
    const { error: ansErr } = await supabase
      .from('quiz_answers')
      .upsert(gradedAnswers, { onConflict: 'attempt_id,question_id' });
    if (ansErr) throw new AppError({ code: ERROR_CODES.INTERNAL, message: ansErr.message, status: HTTP_STATUS.INTERNAL });
  }

  // Update attempt
  const { error: updErr } = await supabase
    .from('quiz_attempts')
    .update({
      submitted_at: now,
      score_percent: scorePercent,
      correct_count: correct,
      total_questions: totalQuestions,
      time_taken_sec: timeTakenSec,
    })
    .eq('id', attemptId);
  if (updErr) throw new AppError({ code: ERROR_CODES.INTERNAL, message: updErr.message, status: HTTP_STATUS.INTERNAL });

  // Log activity
  try {
    const progressService = require('./progressService');
    const estimateMin = (totalQuestions * 45) / 60;
    await progressService.logActivity(spaceId, userId, 'quiz_submitted', estimateMin);
  } catch (_e) {}

  // Return graded payload
  return {
    attemptId,
    scorePercent,
    correct,
    total: totalQuestions,
    timeTakenSec,
    questions: (questions || []).map(q => {
      const answer = gradedAnswers.find(g => g.question_id === q.id);
      const selected = answer ? answer.selected_index : null;
      return {
        id: q.id,
        stem: q.question,
        options: q.options,
        correctAnswerIndex: q.correct_answer_index,
        selectedIndex: selected,
        isCorrect: selected !== null ? selected === Number(q.correct_answer_index) : null,
        explanation: q.explanation,
        topic: q.topic,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async function listHistory({ spaceId, quizId, userId }) {
  // Direct /quizzes/:quizId/history route omits the space id — re-check membership.
  if (!spaceId && quizId) {
    await spaceIdForQuiz(quizId, userId);
  }

  let query = supabase
    .from('quiz_attempts')
    .select(`
      id, attempt_number, score_percent, correct_count, total_questions,
      time_taken_sec, started_at, submitted_at, quiz_id,
      quiz:quizzes(id, title, difficulty, question_count, selected_topics)
    `)
    .eq('user_id', userId)
    .not('submitted_at', 'is', null)
    .order('submitted_at', { ascending: false });

  if (spaceId) query = query.eq('space_id', spaceId);
  if (quizId) query = query.eq('quiz_id', quizId);

  const { data, error } = await query;
  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });

  // `score` / `completed_at` aliases keep the frontend contract stable.
  return (data || []).map(row => ({
    ...row,
    score: row.correct_count,
    completed_at: row.submitted_at,
  }));
}

// ---------------------------------------------------------------------------
// leaderboard
// ---------------------------------------------------------------------------

async function leaderboard({ spaceId, quizId, userId, limit = 10 }) {
  // Direct /quizzes/:quizId/leaderboard route omits the space id — re-check membership.
  if (!spaceId) {
    await spaceIdForQuiz(quizId, userId);
  }

  const { data, error } = await supabase
    .from('quiz_attempts')
    .select(`
      id, score_percent, time_taken_sec, submitted_at,
      user:profiles(id, display_name, name, avatar_url)
    `)
    .eq('quiz_id', quizId)
    .not('submitted_at', 'is', null)
    .order('score_percent', { ascending: false })
    .order('time_taken_sec', { ascending: true })
    .limit(limit);

  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });

  return (data || []).map((row, idx) => ({
    rank: idx + 1,
    score: row.score_percent,
    timeTakenSec: row.time_taken_sec,
    completedAt: row.submitted_at,
    user: row.user || { id: null, name: 'Anonymous' },
  }));
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function deleteQuiz({ spaceId, quizId, userId }) {
  // Verify ownership
  const { data: quiz } = await supabase
    .from('quizzes')
    .select('created_by')
    .eq('id', quizId)
    .eq('space_id', spaceId)
    .maybeSingle();

  if (!quiz) throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Quiz not found', status: HTTP_STATUS.NOT_FOUND });
  if (quiz.created_by !== userId) throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Only the creator can delete this quiz', status: HTTP_STATUS.FORBIDDEN });

  const { error } = await supabase.from('quizzes').delete().eq('id', quizId);
  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolve a quiz's space id and assert the caller holds at least `viewer`.
// Used by the direct /quizzes/:quizId/* routes, which omit the space prefix.
async function spaceIdForQuiz(quizId, userId) {
  const { data: quiz } = await supabase
    .from('quizzes')
    .select('space_id')
    .eq('id', quizId)
    .maybeSingle();
  if (!quiz) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Quiz not found', status: HTTP_STATUS.NOT_FOUND });
  }
  await assertSpaceRole({ spaceId: quiz.space_id, userId, min: 'viewer' });
  return quiz.space_id;
}

function normalizeQuiz(quiz) {
  return {
    id: quiz.id,
    space_id: quiz.space_id,
    title: quiz.title,
    question_count: quiz.question_count,
    difficulty: quiz.difficulty,
    selected_topics: Array.isArray(quiz.selected_topics) ? quiz.selected_topics : [],
    created_by: quiz.created_by,
    provider: quiz.provider,
    model_used: quiz.model_used,
    created_at: quiz.created_at,
    updated_at: quiz.updated_at,
  };
}

function formatQuestion(q, includeAnswer) {
  const base = {
    id: q.id,
    position: q.question_index,
    stem: q.question,
    options: q.options,
    topic: q.topic,
    explanation: q.explanation,
  };
  if (includeAnswer) base.correctAnswerIndex = q.correct_answer_index;
  return base;
}

module.exports = { generate, listForSpace, getById, take, submit, listHistory, leaderboard, deleteQuiz };
