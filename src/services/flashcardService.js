// services/flashcardService.js
// Flashcard generation via aiService (Strategy-B diverse clusters).
// Per-user mastery via flashcard_mastery junction table.
// Debounce via space_ai_generation_flags.flashcards_generated_at (10-min gap).

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');
const aiService = require('./aiService');
const contextBuilder = require('./contextBuilder');

const FLASHCARD_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

const FLASHCARD_SYSTEM = `You are a flashcard creator for students. Based on the study material, create high-quality flashcards.
Respond ONLY with a valid JSON object:
{
  "flashcards": [
    {
      "front": "Question or prompt on the front of the card",
      "back": "Concise, clear answer or explanation",
      "topic": "Topic label",
      "difficulty": "Easy|Medium|Hard"
    }
  ]
}
Generate 20-30 flashcards. Cover a diverse range of topics. Each card must test one specific concept.`;

// ---------------------------------------------------------------------------
// Debounce check via space_ai_generation_flags
// ---------------------------------------------------------------------------

async function checkAndSetGenerationFlag(spaceId) {
  const now = new Date().toISOString();

  // Try to get existing flag row
  const { data: existing } = await supabase
    .from('space_ai_generation_flags')
    .select('flashcards_generated_at')
    .eq('space_id', spaceId)
    .maybeSingle();

  if (existing?.flashcards_generated_at) {
    const age = Date.now() - new Date(existing.flashcards_generated_at).getTime();
    if (age < FLASHCARD_COOLDOWN_MS) {
      throw new AppError({
        code: ERROR_CODES.RATE_LIMITED,
        message: `Flashcard generation is rate limited. Try again in ${Math.ceil((FLASHCARD_COOLDOWN_MS - age) / 1000)}s.`,
        status: HTTP_STATUS.TOO_MANY_REQUESTS,
        details: { retry_after_ms: FLASHCARD_COOLDOWN_MS - age },
      });
    }
  }

  // Upsert flag
  await supabase
    .from('space_ai_generation_flags')
    .upsert(
      { space_id: spaceId, flashcards_generated_at: now },
      { onConflict: 'space_id' }
    );
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

async function generate(spaceId, userId, { regenerate = false } = {}) {
  await checkAndSetGenerationFlag(spaceId);

  if (regenerate) {
    // Delete existing flashcards for this space
    await supabase.from('flashcards').delete().eq('space_id', spaceId);
  }

  const context = await contextBuilder.buildForFlashcards(spaceId);
  const userPrompt = `Study material:\n${context}\n\nGenerate the flashcards now.`;

  let parsed;
  try {
    parsed = await aiService.completeJson({ systemPrompt: FLASHCARD_SYSTEM, userPrompt });
  } catch (err) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: 'AI failed to generate flashcards: ' + err.message,
      status: HTTP_STATUS.INTERNAL,
    });
  }

  const rawCards = Array.isArray(parsed?.flashcards) ? parsed.flashcards : [];
  if (rawCards.length === 0) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: 'AI returned no flashcards',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  const { provider, model } = aiService.getProviderInfo();
  const rows = rawCards.map((c, idx) => ({
    space_id: spaceId,
    created_by: userId,
    front: c.front || `Card ${idx + 1}`,
    back: c.back || '',
    topic: c.topic || null,
    difficulty: ['Easy', 'Medium', 'Hard'].includes(c.difficulty) ? c.difficulty : 'Medium',
    position: idx,
    provider,
    model_used: model,
  }));

  const { data: inserted, error } = await supabase
    .from('flashcards')
    .insert(rows)
    .select('id, front, back, topic, difficulty, position, created_at');

  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Failed to insert flashcards',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  return inserted || [];
}

// ---------------------------------------------------------------------------
// list — with per-user mastery
// ---------------------------------------------------------------------------

async function list(spaceId, userId) {
  const { data: cards, error } = await supabase
    .from('flashcards')
    .select('id, front, back, topic, difficulty, position, created_at')
    .eq('space_id', spaceId)
    .order('position', { ascending: true });

  if (error) {
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
  }

  if (!cards || cards.length === 0) return { status: 'empty', cards: [] };

  // Fetch mastery for user
  const cardIds = cards.map(c => c.id);
  const { data: mastery } = await supabase
    .from('flashcard_mastery')
    .select('flashcard_id')
    .eq('user_id', userId)
    .in('flashcard_id', cardIds);

  const masteredSet = new Set((mastery || []).map(m => m.flashcard_id));

  return {
    status: 'ready',
    cards: cards.map(c => ({ ...c, mastered: masteredSet.has(c.id) })),
  };
}

// ---------------------------------------------------------------------------
// toggleMastery
// ---------------------------------------------------------------------------

async function toggleMastery({ spaceId, cardId, userId }) {
  // Verify card belongs to space
  const { data: card } = await supabase
    .from('flashcards')
    .select('id')
    .eq('id', cardId)
    .eq('space_id', spaceId)
    .maybeSingle();

  if (!card) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Flashcard not found', status: HTTP_STATUS.NOT_FOUND });
  }

  // Check existing mastery
  const { data: existing } = await supabase
    .from('flashcard_mastery')
    .select('id')
    .eq('flashcard_id', cardId)
    .eq('user_id', userId)
    .maybeSingle();

  let mastered;
  if (existing) {
    await supabase.from('flashcard_mastery').delete().eq('id', existing.id);
    mastered = false;
  } else {
    await supabase.from('flashcard_mastery').insert({ flashcard_id: cardId, user_id: userId });
    mastered = true;
  }

  // Log activity
  try {
    const progressService = require('./progressService');
    await progressService.logActivity(spaceId, userId, 'flashcard_mastery', 0.5);
  } catch (_e) {}

  return { mastered };
}

module.exports = { generate, list, toggleMastery };
