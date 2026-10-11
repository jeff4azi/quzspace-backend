// services/contextBuilder.js
// RAG v2 — 3 retrieval strategies.
// Strategy-A anchored: query vector → top-60 → rerank top-12 (chat, topic quiz)
// Strategy-B diverse clusters: spread across position ranges (summary, flashcards)
// Strategy-C weak-area biased: weight chunks near weak topics 2× (T9)
// Always prepend: space_metadata + cached summary JSON at context head.
// Falls back to v1 char-packing if vector search fails (RAG Phase E).

const aiService = require('./aiService');
const chunkingService = require('./chunkingService');
const supabase = require('../lib/supabaseClient');
const { AI } = require('../config/constants');

const MAX_CONTEXT_CHARS = AI.MAX_CONTEXT_CHARS || 60000;
const MAX_FILE_CONTEXT_CHARS = AI.MAX_FILE_CONTEXT_CHARS || 10000;

// ---------------------------------------------------------------------------
// v1 fallback: first-N chars of processed files
// ---------------------------------------------------------------------------

async function buildContextV1(spaceId) {
  try {
    const { data: files } = await supabase
      .from('files')
      .select('display_name, extracted_text')
      .eq('space_id', spaceId)
      .eq('status', 'processed')
      .order('created_at', { ascending: true });

    let text = '';
    for (const f of (files || [])) {
      if (!f.extracted_text) continue;
      text += `\n--- ${f.display_name} ---\n${f.extracted_text.slice(0, MAX_FILE_CONTEXT_CHARS)}\n`;
      if (text.length >= MAX_CONTEXT_CHARS) break;
    }
    return text.slice(0, MAX_CONTEXT_CHARS);
  } catch (_e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Cached summary fetch
// ---------------------------------------------------------------------------

async function getCachedSummary(spaceId) {
  try {
    const { data } = await supabase
      .from('summaries')
      .select('data')
      .eq('space_id', spaceId)
      .eq('status', 'ready')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.data || null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Space metadata header
// ---------------------------------------------------------------------------

async function buildMetaHeader(spaceId) {
  try {
    const { data: space } = await supabase
      .from('study_spaces')
      .select('title, subject, description')
      .eq('id', spaceId)
      .maybeSingle();
    if (!space) return '';
    return `[SPACE: ${space.title} | Subject: ${space.subject || 'General'}${space.description ? ' | ' + space.description : ''}]\n`;
  } catch (_e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Reranker: pick top-K by keyword overlap with query (cheap, no AI)
// ---------------------------------------------------------------------------

function rerank(chunks, query, topK = 12) {
  const qWords = new Set(
    query.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  );
  const scored = chunks.map(c => {
    const words = c.content.toLowerCase().split(/\W+/);
    const hits = words.filter(w => qWords.has(w)).length;
    return { ...c, _score: hits };
  });
  return scored.sort((a, b) => b._score - a._score).slice(0, topK);
}

// ---------------------------------------------------------------------------
// Strategy A — anchored (chat, topic quiz)
// embed query → top-60 → rerank top-12
// ---------------------------------------------------------------------------

async function buildForChat(spaceId, userQuery) {
  const metaHeader = await buildMetaHeader(spaceId);
  const summary = await getCachedSummary(spaceId);
  const summaryBlock = summary
    ? `[SUMMARY]\n${summary.summary || ''}\nTopics: ${(summary.topics || []).join(', ')}\n\n`
    : '';

  let chunksBlock = '';
  try {
    const [queryVec] = await aiService.embed([userQuery]);
    const top60 = await chunkingService.searchChunks(spaceId, queryVec, 60);
    const top12 = rerank(top60, userQuery, 12);
    chunksBlock = top12.map(c => c.content).join('\n\n');
  } catch (_e) {
    chunksBlock = await buildContextV1(spaceId);
  }

  const raw = `${metaHeader}${summaryBlock}[CONTEXT]\n${chunksBlock}`;
  return raw.slice(0, MAX_CONTEXT_CHARS);
}

// ---------------------------------------------------------------------------
// Strategy B — diverse clusters (summary, flashcards, blind quiz)
// Spread evenly across the full text range
// ---------------------------------------------------------------------------

async function buildForFlashcards(spaceId) {
  const metaHeader = await buildMetaHeader(spaceId);
  const summary = await getCachedSummary(spaceId);
  const summaryBlock = summary
    ? `[SUMMARY]\n${summary.summary || ''}\nTopics: ${(summary.topics || []).join(', ')}\n\n`
    : '';

  let chunksBlock = '';
  try {
    const allChunks = await chunkingService.getChunksForSpace(spaceId, 200);
    if (allChunks.length > 0) {
      // Pick ~24 evenly spaced chunks
      const step = Math.max(1, Math.floor(allChunks.length / 24));
      const diverse = allChunks.filter((_, i) => i % step === 0).slice(0, 24);
      chunksBlock = diverse.map(c => c.content).join('\n\n');
    } else {
      chunksBlock = await buildContextV1(spaceId);
    }
  } catch (_e) {
    chunksBlock = await buildContextV1(spaceId);
  }

  const raw = `${metaHeader}${summaryBlock}[CONTEXT]\n${chunksBlock}`;
  return raw.slice(0, MAX_CONTEXT_CHARS);
}

// ---------------------------------------------------------------------------
// Strategy C — weak-area biased (T9 weak explanations)
// weight chunks near weak topics 2×
// ---------------------------------------------------------------------------

async function buildForWeakArea(spaceId, weakTopicLabel) {
  const metaHeader = await buildMetaHeader(spaceId);
  const summary = await getCachedSummary(spaceId);
  const summaryBlock = summary
    ? `[SUMMARY]\n${summary.summary || ''}\n\n`
    : '';

  let chunksBlock = '';
  try {
    const [topicVec] = await aiService.embed([weakTopicLabel]);
    const top60 = await chunkingService.searchChunks(spaceId, topicVec, 60);
    // Double-weight: include all top-60 but duplicate top-12 for emphasis
    const top12 = rerank(top60, weakTopicLabel, 12);
    chunksBlock = [...top12, ...top12, ...top60.slice(12, 24)]
      .map(c => c.content).join('\n\n');
  } catch (_e) {
    chunksBlock = await buildContextV1(spaceId);
  }

  const raw = `${metaHeader}${summaryBlock}[TOPIC: ${weakTopicLabel}]\n[CONTEXT]\n${chunksBlock}`;
  return raw.slice(0, MAX_CONTEXT_CHARS);
}

// ---------------------------------------------------------------------------
// buildForQuiz — Strategy-A if topics given, else Strategy-B
// ---------------------------------------------------------------------------

async function buildForQuiz(spaceId, selectedTopics = []) {
  if (selectedTopics.length > 0) {
    return buildForChat(spaceId, selectedTopics.join(' '));
  }
  return buildForFlashcards(spaceId);
}

// ---------------------------------------------------------------------------
// buildForSummary — Strategy-B (whole-document view)
// ---------------------------------------------------------------------------

async function buildForSummary(spaceId) {
  return buildForFlashcards(spaceId);
}

module.exports = {
  buildForChat,
  buildForFlashcards,
  buildForQuiz,
  buildForSummary,
  buildForWeakArea,
  buildContextV1,
};
