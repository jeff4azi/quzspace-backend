// services/chunkingService.js
// 800-char / 150-overlap chunker + batch embed + persist to space_content_chunks.
// Cap: 4000 chunks per space (enforced by DB trigger + service-side double-check).
// Deduplication: SHA-256 hash of content.

const crypto = require('crypto');
const supabase = require('../lib/supabaseClient');
const aiService = require('./aiService');
const { AI } = require('../config/constants');

const CHUNK_SIZE = AI.CHUNK_SIZE_CHARS || 800;
const CHUNK_OVERLAP = AI.CHUNK_OVERLAP_CHARS || 150;
const MAX_CHUNKS_PER_SPACE = AI.MAX_CHUNKS_PER_SPACE || 4000;
const EMBED_BATCH_SIZE = 20; // embed in batches to avoid request limits

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * splitIntoChunks(text) → { content, contentHash, charStart, charEnd }[]
 */
function splitIntoChunks(text) {
  if (!text || typeof text !== 'string') return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    const content = text.slice(start, end);
    chunks.push({
      content,
      contentHash: crypto.createHash('sha256').update(content).digest('hex'),
      charStart: start,
      charEnd: end,
    });
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * estimateTokens(text) → integer (4-chars-per-token heuristic)
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ---------------------------------------------------------------------------
// Batch embed helper
// ---------------------------------------------------------------------------

async function batchEmbed(texts) {
  const all = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vecs = await aiService.embed(batch);
    all.push(...vecs);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

/**
 * persistChunksForFile(fileId, spaceId, extractedText, sourceKind)
 * - Splits text into chunks
 * - Embeds in batches
 * - Upserts to space_content_chunks (dedup by content_sha256)
 * - Enforces MAX_CHUNKS_PER_SPACE: deletes oldest if over cap
 * Silently ignores errors (RAG phase E compat-fallback)
 */
async function persistChunksForFile({ fileId, spaceId, extractedText, sourceKind = 'file' }) {
  if (!extractedText || !extractedText.trim()) return;

  let chunks;
  try {
    chunks = splitIntoChunks(extractedText);
    if (!chunks.length) return;
  } catch (err) {
    console.error('[chunkingService] split error:', err.message);
    return;
  }

  let embeddings;
  try {
    embeddings = await batchEmbed(chunks.map(c => c.content));
  } catch (err) {
    console.error('[chunkingService] embed error:', err.message);
    return;
  }

  // Check existing chunk count for space
  let existingCount = 0;
  try {
    const { count } = await supabase
      .from('space_content_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('space_id', spaceId);
    existingCount = count || 0;
  } catch (_e) { existingCount = 0; }

  // How many we can insert without busting cap
  const available = Math.max(0, MAX_CHUNKS_PER_SPACE - existingCount);
  const toInsert = chunks.slice(0, available);

  if (toInsert.length === 0) {
    // Over cap — delete oldest batch to make room
    try {
      const { data: oldest } = await supabase
        .from('space_content_chunks')
        .select('id')
        .eq('space_id', spaceId)
        .order('created_at', { ascending: true })
        .limit(chunks.length);
      if (oldest && oldest.length > 0) {
        await supabase
          .from('space_content_chunks')
          .delete()
          .in('id', oldest.map(r => r.id));
      }
    } catch (_e) {}
    // Try again with all chunks
    toInsert.push(...chunks);
  }

  const rows = toInsert.map((chunk, idx) => ({
    space_id: spaceId,
    file_id: fileId,
    source_kind: sourceKind,
    content: chunk.content,
    content_sha256: chunk.contentHash,
    char_start: chunk.charStart,
    char_end: chunk.charEnd,
    token_estimate: estimateTokens(chunk.content),
    embedding: embeddings[idx] || null,
  }));

  // Upsert with dedup on (space_id, content_sha256)
  try {
    await supabase
      .from('space_content_chunks')
      .upsert(rows, { onConflict: 'space_id,content_sha256', ignoreDuplicates: true });
  } catch (err) {
    console.error('[chunkingService] upsert error:', err.message);
  }
}

/**
 * getChunksForSpace(spaceId, limit) → { content, embedding, id }[]
 */
async function getChunksForSpace(spaceId, limit = MAX_CHUNKS_PER_SPACE) {
  try {
    const { data } = await supabase
      .from('space_content_chunks')
      .select('id, content, embedding, char_start, char_end')
      .eq('space_id', spaceId)
      .order('char_start', { ascending: true })
      .limit(limit);
    return data || [];
  } catch (_e) {
    return [];
  }
}

/**
 * searchChunks(spaceId, queryEmbedding, topK) — cosine sim via pgvector operator
 */
async function searchChunks(spaceId, queryEmbedding, topK = 60) {
  try {
    // Use pgvector similarity search if available
    const { data } = await supabase
      .rpc('match_space_chunks', {
        p_space_id: spaceId,
        query_embedding: queryEmbedding,
        match_count: topK,
      });
    return data || [];
  } catch (_e) {
    // Fallback: return first topK chunks ordered by char_start
    return getChunksForSpace(spaceId, topK);
  }
}

module.exports = {
  splitIntoChunks,
  estimateTokens,
  batchEmbed,
  persistChunksForFile,
  getChunksForSpace,
  searchChunks,
};
