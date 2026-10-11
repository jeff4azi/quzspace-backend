// services/summaryService.js
// Real summary service — replaces the DEFAULT_TOPICS stub.
// Status lifecycle: generating → ready | failed
// Auto-triggered on first file extraction (called from filesService).

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');
const aiService = require('./aiService');
const contextBuilder = require('./contextBuilder');

const SUMMARY_RATE_LIMIT_MS = 5 * 60 * 1000; // 5 min

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM = `You are a study assistant that creates concise academic summaries.
Analyze the provided study material and respond ONLY with a valid JSON object with:
{
  "topics": ["10 to 20 deduplicated topic label strings (short noun phrases)"],
  "summary": "A 2-4 paragraph prose summary of the key ideas and themes.",
  "key_points": ["4 to 6 concise high-yield takeaway bullets"],
  "definitions": [{"term": "Term", "definition": "Clear concise definition"}],
  "main_concepts": [{"title": "Concept Name", "description": "Explanation"}],
  "exam_tips": ["3 to 5 actionable test and study tips"]
}
Make topics distinct, specific, and useful as quiz/flashcard anchors.`;

// ---------------------------------------------------------------------------
// enqueue: upsert a summaries row with status = generating
// Idempotent: if already in generating state, returns existing row.
// ---------------------------------------------------------------------------

async function enqueue(spaceId) {
  // Check if already generating or recently ready (debounce: don't re-trigger within 30s)
  const { data: existing } = await supabase
    .from('summaries')
    .select('id, status, updated_at')
    .eq('space_id', spaceId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (existing.status === 'generating') return existing; // already in flight
    const age = Date.now() - new Date(existing.updated_at).getTime();
    if (existing.status === 'ready' && age < 30_000) return existing; // too fresh
  }

  const { data, error } = await supabase
    .from('summaries')
    .upsert(
      {
        space_id: spaceId,
        status: 'generating',
        data: {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'space_id' }
    )
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[summaryService.enqueue] error:', error.message);
    return null;
  }

  // Kick off generation asynchronously — don't block enqueue caller
  runGeneration(spaceId).catch(err =>
    console.error('[summaryService] runGeneration error:', err.message)
  );

  return data;
}

// ---------------------------------------------------------------------------
// runGeneration: actual AI call + write back to summaries
// ---------------------------------------------------------------------------

async function runGeneration(spaceId) {
  const start = Date.now();
  const { provider, model } = aiService.getProviderInfo();

  try {
    const context = await contextBuilder.buildForSummary(spaceId);
    const userPrompt = `Study material:\n\n${context}\n\nGenerate the JSON summary now.`;

    const parsed = await aiService.completeJson({
      systemPrompt: SUMMARY_SYSTEM,
      userPrompt,
    });

    const topics = Array.isArray(parsed.topics)
      ? [...new Set(parsed.topics.filter(t => typeof t === 'string' && t.trim()))].slice(0, 20)
      : [];
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const key_points = Array.isArray(parsed.key_points) ? parsed.key_points : [];
    const definitions = Array.isArray(parsed.definitions) ? parsed.definitions : [];
    const main_concepts = Array.isArray(parsed.main_concepts) ? parsed.main_concepts : [];
    const exam_tips = Array.isArray(parsed.exam_tips) ? parsed.exam_tips : [];

    // Fallbacks if not provided
    if (key_points.length === 0 && topics.length > 0) {
      key_points.push(...topics.slice(0, 5).map(t => `Key mastery topic: ${t}`));
    }

    const durationMs = Date.now() - start;

    const { error } = await supabase
      .from('summaries')
      .upsert(
        {
          space_id: spaceId,
          status: 'ready',
          data: {
            topics,
            summary,
            key_points,
            definitions,
            main_concepts,
            exam_tips,
            duration_ms: durationMs,
            provider,
            model_used: model,
          },
          provider,
          model_used: model,
          input_token_est: Math.ceil(context.length / 4),
          error_message: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'space_id' }
      );

    if (error) console.error('[summaryService.runGeneration] write error:', error.message);
  } catch (err) {
    console.error('[summaryService.runGeneration] AI error:', err.message);
    await supabase
      .from('summaries')
      .upsert(
        {
          space_id: spaceId,
          status: 'failed',
          error_message: err.message,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'space_id' }
      );
  }
}

// ---------------------------------------------------------------------------
// getSummary: returns the current summary row for a space
// Returns: { status, topics, summary, key_points, definitions, main_concepts, exam_tips, provider, modelUsed, durationMs, retryAfterMs?, errorMessage? }
// ---------------------------------------------------------------------------

async function getSummary(spaceId) {
  const { data, error } = await supabase
    .from('summaries')
    .select('*')
    .eq('space_id', spaceId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message,
      status: HTTP_STATUS.INTERNAL,
    });
  }

  if (!data) {
    return { status: 'not_started', retry_after_ms: 3000 };
  }

  if (data.status === 'generating') {
    return { status: 'generating', retry_after_ms: 3000 };
  }

  if (data.status === 'failed') {
    return {
      status: 'failed',
      error_message: data.error_message || 'Summary generation failed',
    };
  }

  const d = data.data || {};
  return {
    status: 'ready',
    topics: d.topics || [],
    summary: d.summary || '',
    key_points: d.key_points || (Array.isArray(d.topics) ? d.topics.slice(0, 5) : []),
    definitions: d.definitions || [],
    main_concepts: d.main_concepts || [],
    exam_tips: d.exam_tips || [],
    provider: data.provider,
    modelUsed: data.model_used,
    durationMs: d.duration_ms,
  };
}

// ---------------------------------------------------------------------------
// regenerate: rate limit 1 per space per 5 min + enqueue
// ---------------------------------------------------------------------------

async function regenerate(spaceId) {
  const { data: existing } = await supabase
    .from('summaries')
    .select('status, updated_at')
    .eq('space_id', spaceId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    const age = Date.now() - new Date(existing.updated_at).getTime();
    if (age < SUMMARY_RATE_LIMIT_MS) {
      const retryAfterMs = SUMMARY_RATE_LIMIT_MS - age;
      throw new AppError({
        code: ERROR_CODES.RATE_LIMITED,
        message: `Summary regeneration is rate limited. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
        status: HTTP_STATUS.TOO_MANY_REQUESTS,
        details: { retry_after_ms: retryAfterMs },
      });
    }
  }

  return enqueue(spaceId);
}

// ---------------------------------------------------------------------------
// getTopics: backward compat shim for old summaryController
// ---------------------------------------------------------------------------

async function getTopics(spaceId) {
  const result = await getSummary(spaceId);
  if (result.status === 'ready') {
    return { status: 'ready', topics: result.topics };
  }
  return { status: result.status || 'generating', topics: [], retry_after_ms: 3000 };
}

module.exports = { enqueue, runGeneration, getSummary, regenerate, getTopics };
