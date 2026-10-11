// services/chatService.js
// Chat messages with RAG Strategy-A context builder.
// Rate limit: 20 msgs / user / hour (enforced in route middleware).
// Always writes 2 rows: USER + ASSISTANT (even on AI failure).

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES, AI } = require('../config/constants');
const aiService = require('./aiService');
const contextBuilder = require('./contextBuilder');

const MAX_HISTORY_TURNS = AI.MAX_CHAT_HISTORY_TURNS || 20;

const SUGGESTED_PROMPTS = [
  'Summarize the core ideas from the study material.',
  'Quiz me on the most important concepts.',
  'What are the 3 most important things to remember?',
  'Explain the key differences and trade-offs between the main topics.',
];

const CHAT_SYSTEM = `You are a helpful study assistant. Use the provided context to answer student questions accurately and concisely.
If the answer is not in the context, say so honestly but still try to help based on general knowledge.
Keep responses focused and educational.`;

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

async function getMessages(spaceId, userId) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, role, content, created_at')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(MAX_HISTORY_TURNS * 2);

  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
  return data || [];
}

// ---------------------------------------------------------------------------
// sendMessage — writes USER row, calls AI, writes ASSISTANT row
// ---------------------------------------------------------------------------

async function sendMessage(spaceId, userId, userContent) {
  const now = new Date().toISOString();

  // Write USER row immediately
  const { data: userMsg, error: uErr } = await supabase
    .from('chat_messages')
    .insert({ space_id: spaceId, user_id: userId, role: 'user', content: userContent })
    .select('id, role, content, created_at')
    .maybeSingle();

  if (uErr) {
    throw new AppError({ code: ERROR_CODES.INTERNAL, message: uErr.message || 'Failed to save message', status: HTTP_STATUS.INTERNAL });
  }

  // Build context (Strategy-A) + history tail
  let assistantContent;
  try {
    const context = await contextBuilder.buildForChat(spaceId, userContent);
    const historyRows = await getMessages(spaceId, userId);
    const historyTail = historyRows.slice(-MAX_HISTORY_TURNS * 2);
    const historyText = historyTail
      .map(m => `${m.role === 'user' ? 'Student' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const userPrompt = `[Study Context]\n${context}\n\n[Conversation History]\n${historyText}\n\nStudent: ${userContent}\n\nAssistant:`;
    assistantContent = await aiService.complete({ systemPrompt: CHAT_SYSTEM, userPrompt });
  } catch (err) {
    console.error('[chatService.sendMessage] AI error:', err.message);
    assistantContent = "I'm sorry, I encountered an error while processing your question. Please try again in a moment.";
  }

  // Write ASSISTANT row
  const { data: assistantMsg } = await supabase
    .from('chat_messages')
    .insert({ space_id: spaceId, user_id: userId, role: 'assistant', content: assistantContent })
    .select('id, role, content, created_at')
    .maybeSingle();

  // Log activity
  try {
    const progressService = require('./progressService');
    await progressService.logActivity(spaceId, userId, 'chat_send', 1);
  } catch (_e) {}

  return {
    userMessage: userMsg,
    assistantMessage: assistantMsg || { role: 'assistant', content: assistantContent },
  };
}

// ---------------------------------------------------------------------------
// clearHistory
// ---------------------------------------------------------------------------

async function clearHistory(spaceId, userId) {
  const { error } = await supabase
    .from('chat_messages')
    .delete()
    .eq('space_id', spaceId)
    .eq('user_id', userId);

  if (error) throw new AppError({ code: ERROR_CODES.INTERNAL, message: error.message, status: HTTP_STATUS.INTERNAL });
}

// ---------------------------------------------------------------------------
// getSuggestedPrompts — rule-based 4-chip default
// ---------------------------------------------------------------------------

async function getSuggestedPrompts(spaceId) {
  // If we have a cached summary with topics, personalize the first chip
  try {
    const { data: summary } = await supabase
      .from('summaries')
      .select('data')
      .eq('space_id', spaceId)
      .eq('status', 'ready')
      .maybeSingle();

    if (summary?.data?.topics?.length > 0) {
      const topTopic = summary.data.topics[0];
      return [
        `Explain ${topTopic} in simple terms.`,
        SUGGESTED_PROMPTS[1],
        SUGGESTED_PROMPTS[2],
        `Compare and contrast the main topics covered in this material.`,
      ];
    }
  } catch (_e) {}

  return SUGGESTED_PROMPTS;
}

module.exports = { getMessages, sendMessage, clearHistory, getSuggestedPrompts };
