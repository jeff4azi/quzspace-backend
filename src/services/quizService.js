// services/quizService.js
// Full DB-backed quiz service — replaces the in-memory Map stub.
// Uses quizzes + quiz_questions + quiz_attempts + quiz_answers tables.

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');
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

  // Insert quiz row
  const { data: quiz, error: quizErr } = await supabase
    .from('quizzes')
    .insert({
      space_id: spaceId,
      created_by: userId,
      title,
      question_count: rawQuestions.length,
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
  const questionsToInsert = rawQuestions.slice(0, count).map((q, idx) => ({
    quiz_id: quiz.id,
    space_id: spaceId,
    position: idx,
    stem: q.stem || `Question ${idx + 1}`,
    options: Array.isArray(q.options) ? q.options : ['A', 'B', 'C', 'D'],
    correct_answer_index: typeof q.correctAnswerIndex === 'number' ? q.correctAnswerIndex : 0,
    explanation: q.explanation || '',
    topic: q.topic || (topics[0] || null),
    difficulty,
  }));

  const { error: qErr } = await supabase.from('quiz_questions').insert(questionsToInsert);
  if (qErr) console.error('[quizService.generate] questions insert error:', qErr.message);

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
      attempts:quiz_attempts(id, score, completed_at)
    `)
    .eq('space_id', spaceId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
  }

  return (data || []).map(quiz => {
    const attempts = Array.isArray(quiz.attempts) ? quiz.attempts.filter(a => a.completed_at) : [];
    const bestScore = attempts.length > 0
      ? Math.max(...attempts.map(a => Number(a.score) || 0))
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
  const { data: quiz, error: quizErr } = await supabase
    .from('quizzes')
    .select('*')
    .eq('id', quizId)
    .eq('space_id', spaceId)
    .maybeSingle();

  if (quizErr || !quiz) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Quiz not found', status: HTTP_STATUS.NOT_FOUND });
  }

  const { data: questions, error: qErr } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('quiz_id', quizId)
    .order('position', { ascending: true });

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
  // Verify quiz exists in space
  const { data: quiz } = await supabase
    .from('quizzes')
    .select('id, question_count')
    .eq('id', quizId)
    .eq('space_id', spaceId)
    .maybeSingle();

  if (!quiz) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Quiz not found', status: HTTP_STATUS.NOT_FOUND });
  }

  const { data: attempt, error } = await supabase
    .from('quiz_attempts')
    .insert({
      quiz_id: quizId,
      space_id: spaceId,
      user_id: userId,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .maybeSingle();

  if (error || !attempt) {
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: error?.message || 'Failed to start attempt', status: HTTP_STATUS.INTERNAL });
  }

  // Return questions WITHOUT correctAnswerIndex
  const { data: questions } = await supabase
    .from('quiz_questions')
    .select('id, position, stem, options, topic, difficulty')
    .eq('quiz_id', quizId)
    .order('position', { ascending: true });

  return {
    attemptId: attempt.id,
    quizId,
    spaceId,
    startedAt: attempt.started_at,
    questions: questions || [],
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
  if (attempt.completed_at) {
    throw new AppError({ code: ERROR_CODES.CONFLICT, message: 'Attempt already submitted', status: HTTP_STATUS.CONFLICT });
  }

  const quizId = attempt.quiz_id;
  const spaceId = attempt.quiz?.space_id || attempt.space_id;

  // Fetch questions
  const { data: questions } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('quiz_id', quizId)
    .order('position', { ascending: true });

  const qMap = new Map((questions || []).map(q => [q.id, q]));

  // Grade
  const answersArr = Array.isArray(answers) ? answers : [];
  let correct = 0;
  const gradedAnswers = answersArr.map(a => {
    const q = qMap.get(a.questionId);
    if (!q) return null;
    const isCorrect = Number(a.optionIndex) === Number(q.correct_answer_index);
    if (isCorrect) correct++;
    return {
      quiz_attempt_id: attemptId,
      question_id: a.questionId,
      selected_option_index: Number(a.optionIndex),
      is_correct: isCorrect,
    };
  }).filter(Boolean);

  const totalAnswered = answersArr.length || 1;
  const scorePercent = Math.round((correct / Math.max(1, questions?.length || totalAnswered)) * 100);
  const now = new Date().toISOString();
  const startedAt = attempt.started_at ? new Date(attempt.started_at) : new Date(Date.now() - 60000);
  const timeTakenSec = Math.round((Date.now() - startedAt.getTime()) / 1000);

  // Write quiz_answers
  if (gradedAnswers.length > 0) {
    await supabase.from('quiz_answers').insert(gradedAnswers);
  }

  // Update attempt
  await supabase
    .from('quiz_attempts')
    .update({ completed_at: now, score: scorePercent, time_taken_sec: timeTakenSec })
    .eq('id', attemptId);

  // Log activity
  try {
    const progressService = require('./progressService');
    const estimateMin = ((questions || []).length * 45) / 60;
    await progressService.logActivity(spaceId, userId, 'quiz_submit', estimateMin);
  } catch (_e) {}

  // Return graded payload
  return {
    attemptId,
    scorePercent,
    correct,
    total: questions?.length || 0,
    timeTakenSec,
    questions: (questions || []).map(q => {
      const answer = answersArr.find(a => a.questionId === q.id);
      const selected = answer ? Number(answer.optionIndex) : null;
      return {
        id: q.id,
        stem: q.stem,
        options: q.options,
        correctAnswerIndex: q.correct_answer_index,
        selectedIndex: selected,
        isCorrect: selected !== null ? selected === q.correct_answer_index : null,
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
  let query = supabase
    .from('quiz_attempts')
    .select(`
      id, started_at, completed_at, score, time_taken_sec, quiz_id,
      quiz:quizzes(id, title, difficulty, question_count, selected_topics)
    `)
    .eq('user_id', userId)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false });

  if (spaceId) query = query.eq('space_id', spaceId);
  if (quizId) query = query.eq('quiz_id', quizId);

  const { data, error } = await query;
  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
  return data || [];
}

// ---------------------------------------------------------------------------
// leaderboard
// ---------------------------------------------------------------------------

async function leaderboard({ spaceId, quizId, limit = 10 }) {
  const { data, error } = await supabase
    .from('quiz_attempts')
    .select(`
      id, score, time_taken_sec, completed_at,
      user:profiles(id, display_name, name, avatar_url)
    `)
    .eq('quiz_id', quizId)
    .not('completed_at', 'is', null)
    .order('score', { ascending: false })
    .order('time_taken_sec', { ascending: true })
    .limit(limit);

  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });

  return (data || []).map((row, idx) => ({
    rank: idx + 1,
    score: row.score,
    timeTakenSec: row.time_taken_sec,
    completedAt: row.completed_at,
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
    position: q.position,
    stem: q.stem,
    options: q.options,
    topic: q.topic,
    difficulty: q.difficulty,
    explanation: q.explanation,
  };
  if (includeAnswer) base.correctAnswerIndex = q.correct_answer_index;
  return base;
}

module.exports = { generate, listForSpace, getById, take, submit, listHistory, leaderboard, deleteQuiz };
