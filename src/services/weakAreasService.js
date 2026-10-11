// services/weakAreasService.js
// On-demand derivation + 6h cache.
// Groups quiz_answers by topic, skips topics with < 5 answers,
// calls aiService per weak topic for explanation + keyTips.

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES, PROGRESS } = require('../config/constants');
const aiService = require('./aiService');
const contextBuilder = require('./contextBuilder');

const CACHE_TTL_MS = PROGRESS.WEAK_AREA_CACHE_TTL_MS || 6 * 60 * 60 * 1000;
const MIN_ANSWERS = PROGRESS.MIN_ANSWERS_PER_TOPIC_FOR_WEAK_AREA || 5;

// In-memory lock to prevent concurrent derivation for same (spaceId, userId)
const derivingLock = new Set();

const WEAK_AREA_SYSTEM = `You are a tutoring assistant identifying weak areas for a student.
For a topic where the student answered many questions incorrectly, provide:
- A clear, encouraging explanation of the concept
- 3-5 concrete study tips
Respond ONLY with a valid JSON object:
{
  "explanation": "2-3 sentence explanation of the topic",
  "keyTips": ["Tip 1", "Tip 2", "Tip 3"]
}`;

// ---------------------------------------------------------------------------
// derive — the actual AI derivation
// ---------------------------------------------------------------------------

async function derive(spaceId, userId) {
  const lockKey = `${spaceId}:${userId}`;
  if (derivingLock.has(lockKey)) return; // already computing
  derivingLock.add(lockKey);

  try {
    // Mark as computing
    await supabase
      .from('weak_areas')
      .upsert(
        { space_id: spaceId, user_id: userId, status: 'computing', data: [], expires_at: null },
        { onConflict: 'space_id,user_id' }
      );

    // Fetch quiz answers with topic info
    const { data: attempts } = await supabase
      .from('quiz_attempts')
      .select(`
        id,
        quiz:quizzes(selected_topics),
        answers:quiz_answers(question_id, is_correct,
          question:quiz_questions(topic))
      `)
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .not('completed_at', 'is', null);

    // Group wrong answers by topic
    const topicBuckets = {}; // topic → { wrong, total }
    for (const attempt of (attempts || [])) {
      for (const answer of (attempt.answers || [])) {
        const topic = answer.question?.topic || (attempt.quiz?.selected_topics?.[0]) || 'General';
        if (!topicBuckets[topic]) topicBuckets[topic] = { wrong: 0, total: 0 };
        topicBuckets[topic].total++;
        if (!answer.is_correct) topicBuckets[topic].wrong++;
      }
    }

    // Filter: need >= MIN_ANSWERS and > 50% wrong
    const weakTopics = Object.entries(topicBuckets)
      .filter(([, b]) => b.total >= MIN_ANSWERS && b.wrong / b.total > 0.5)
      .sort((a, b) => (b[1].wrong / b[1].total) - (a[1].wrong / a[1].total))
      .slice(0, 8) // cap at 8 weak areas
      .map(([topic, b]) => ({ topic, errorRate: Math.round((b.wrong / b.total) * 100) }));

    if (weakTopics.length === 0) {
      await supabase
        .from('weak_areas')
        .upsert(
          { space_id: spaceId, user_id: userId, status: 'insufficient_data', data: [], expires_at: null },
          { onConflict: 'space_id,user_id' }
        );
      return;
    }

    // Per-topic AI call (batched sequentially to avoid parallel rate limits)
    const results = [];
    for (const { topic, errorRate } of weakTopics) {
      try {
        const context = await contextBuilder.buildForWeakArea(spaceId, topic);
        const userPrompt = `Topic: ${topic}\nError rate: ${errorRate}%\n\nMaterial:\n${context.slice(0, 8000)}\n\nProvide the JSON explanation now.`;
        const parsed = await aiService.completeJson({ systemPrompt: WEAK_AREA_SYSTEM, userPrompt });
        results.push({
          topic,
          errorRate,
          explanation: parsed.explanation || '',
          keyTips: Array.isArray(parsed.keyTips) ? parsed.keyTips : [],
        });
      } catch (err) {
        console.error(`[weakAreasService] AI error for topic "${topic}":`, err.message);
        results.push({
          topic,
          errorRate,
          explanation: `This is an area where you need more practice. Review the related material.`,
          keyTips: ['Review the definitions', 'Practice with more questions', 'Connect to related concepts'],
        });
      }
    }

    const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
    await supabase
      .from('weak_areas')
      .upsert(
        { space_id: spaceId, user_id: userId, status: 'ready', data: results, expires_at: expiresAt },
        { onConflict: 'space_id,user_id' }
      );
  } catch (err) {
    console.error('[weakAreasService.derive] error:', err.message);
    await supabase
      .from('weak_areas')
      .upsert(
        { space_id: spaceId, user_id: userId, status: 'failed', data: [], expires_at: null },
        { onConflict: 'space_id,user_id' }
      );
  } finally {
    derivingLock.delete(lockKey);
  }
}

// ---------------------------------------------------------------------------
// get — lazy trigger if cache stale/missing
// ---------------------------------------------------------------------------

async function get(spaceId, userId, { forceRefresh = false } = {}) {
  const { data: existing } = await supabase
    .from('weak_areas')
    .select('*')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .maybeSingle();

  const isStale = !existing
    || forceRefresh
    || (existing.expires_at && new Date(existing.expires_at).getTime() < Date.now());

  if (isStale && existing?.status !== 'computing') {
    // Kick off async — don't block
    derive(spaceId, userId).catch(err =>
      console.error('[weakAreasService] async derive error:', err.message)
    );
  }

  if (!existing || isStale) {
    return { status: 'computing', retry_after_ms: 3000 };
  }

  if (existing.status === 'computing') {
    return { status: 'computing', retry_after_ms: 3000 };
  }

  if (existing.status === 'insufficient_data') {
    return { status: 'insufficient_data', data: [] };
  }

  if (existing.status === 'failed') {
    return { status: 'failed', data: [] };
  }

  return { status: 'ready', data: existing.data || [] };
}

module.exports = { derive, get };
