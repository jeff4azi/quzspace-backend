// services/progressService.js
// Progress aggregator + activity logging.

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

// ---------------------------------------------------------------------------
// logActivity — called from other services
// ---------------------------------------------------------------------------

async function logActivity(spaceId, userId, eventType, minutesEstimate = 0) {
  try {
    await supabase.from('activity_logs').insert({
      space_id: spaceId,
      user_id: userId,
      event_type: eventType,
      minutes_estimate: Math.max(0, Number(minutesEstimate) || 0),
      meta: {},
    });
  } catch (err) {
    console.error('[progressService.logActivity] error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Helper: consecutive day streak
// ---------------------------------------------------------------------------

function computeStreak(activityRows) {
  if (!activityRows || activityRows.length === 0) return 0;

  // Get unique calendar dates (UTC) from activity logs in last 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const dateSets = new Set();
  for (const row of activityRows) {
    const ts = new Date(row.created_at).getTime();
    if (ts < cutoff) continue;
    const dateStr = new Date(row.created_at).toISOString().slice(0, 10);
    dateSets.add(dateStr);
  }

  const dates = Array.from(dateSets).sort().reverse(); // most recent first
  if (dates.length === 0) return 0;

  // Walk backward from today
  let streak = 0;
  const today = new Date().toISOString().slice(0, 10);
  let cursor = today;

  for (const date of dates) {
    if (date === cursor) {
      streak++;
      const d = new Date(cursor);
      d.setDate(d.getDate() - 1);
      cursor = d.toISOString().slice(0, 10);
    } else if (date < cursor) {
      break;
    }
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Helper: weekly activity (7 bins Sun–Sat)
// ---------------------------------------------------------------------------

function computeWeeklyActivity(activityRows) {
  const bins = new Array(7).fill(0); // 0=Sun, 6=Sat
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const row of (activityRows || [])) {
    const ts = new Date(row.created_at).getTime();
    if (ts < weekAgo) continue;
    const day = new Date(row.created_at).getDay();
    bins[day] += Math.round(row.minutes_estimate || 1);
  }
  return bins;
}

// ---------------------------------------------------------------------------
// Helper: mastery over time (last 6 weeks)
// ---------------------------------------------------------------------------

function computeMasteryOverTime(masteryRows) {
  // Simple: count mastery events per week for last 6 weeks
  const now = Date.now();
  const bins = new Array(6).fill(0);
  for (const row of (masteryRows || [])) {
    const ts = new Date(row.created_at).getTime();
    const weekAgo = (now - ts) / (7 * 24 * 60 * 60 * 1000);
    const idx = Math.floor(weekAgo);
    if (idx >= 0 && idx < 6) bins[5 - idx]++;
  }
  return bins;
}

// ---------------------------------------------------------------------------
// Rule-based motivational copy
// ---------------------------------------------------------------------------

function buildMotivational(streak, avgScore) {
  if (streak >= 7 && avgScore >= 80) {
    return {
      heading: '🔥 On Fire!',
      text: `${streak}-day streak with ${avgScore}% average — you're mastering this material. Keep it up!`,
    };
  }
  if (streak >= 3) {
    return {
      heading: '💪 Great Consistency!',
      text: `${streak} days in a row! Consistent studying is the key to long-term retention.`,
    };
  }
  if (avgScore >= 80) {
    return {
      heading: '🌟 Excellent Scores!',
      text: `Your ${avgScore}% average is impressive. Try to study daily to lock in that knowledge.`,
    };
  }
  if (avgScore >= 60) {
    return {
      heading: '📈 Good Progress!',
      text: 'You\'re getting there! Review weak areas and retake quizzes to push your score higher.',
    };
  }
  if (streak === 0) {
    return {
      heading: '🚀 Ready to Start?',
      text: 'Begin your study streak today. Even 15 minutes a day makes a huge difference!',
    };
  }
  return {
    heading: '📚 Keep Studying!',
    text: 'Review your flashcards daily and focus on the topics where you need the most improvement.',
  };
}

// ---------------------------------------------------------------------------
// getProgress
// ---------------------------------------------------------------------------

async function getProgress(spaceId, userId) {
  const [activityRes, masteryRes, attemptsRes, flashcardCountRes] = await Promise.all([
    supabase
      .from('activity_logs')
      .select('event_type, minutes_estimate, created_at')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('flashcard_mastery')
      .select('flashcard_id, created_at, flashcard:flashcards!inner(space_id)')
      .eq('flashcard:flashcards.space_id', spaceId)
      .eq('user_id', userId),
    supabase
      .from('quiz_attempts')
      .select('score, completed_at')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .not('completed_at', 'is', null),
    supabase
      .from('flashcards')
      .select('id', { count: 'exact', head: true })
      .eq('space_id', spaceId),
  ]);

  const activityRows = activityRes.data || [];
  const masteryRows = masteryRes.data || [];
  const attempts = attemptsRes.data || [];

  const quizzesCompleted = attempts.length;
  const scores = attempts.map(a => Number(a.score) || 0);
  const averageScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const flashcardsStudied = masteryRows.length;
  const studyStreak = computeStreak(activityRows);
  const weeklyActivity = computeWeeklyActivity(activityRows);
  const masteryOverTime = computeMasteryOverTime(masteryRows);
  const { heading: motivationalHeading, text: motivationalText } = buildMotivational(studyStreak, averageScore);

  return {
    quizzesCompleted,
    flashcardsStudied,
    averageScore,
    studyStreak,
    weeklyActivity,
    masteryOverTime,
    motivationalHeading,
    motivationalText,
  };
}

module.exports = { logActivity, getProgress };
