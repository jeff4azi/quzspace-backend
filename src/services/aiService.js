// services/aiService.js
// Provider abstraction: Stub / OpenAI / Anthropic / Gemini using direct HTTPS fetch — NO SDK deps.
// Selection: AI_PROVIDER env var. AI_API_KEY, AI_MODEL, AI_BASE_URL for overrides.

const config = require('../config');
const { AI } = require('../config/constants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProvider() {
  return (config.AI_PROVIDER || AI.DEFAULT_PROVIDER).toLowerCase();
}

function resolveModel(provider) {
  if (config.AI_MODEL) return config.AI_MODEL;
  switch (provider) {
    case AI.PROVIDERS.OPENAI:     return 'gpt-4o-mini';
    case AI.PROVIDERS.ANTHROPIC:  return 'claude-3-haiku-20240307';
    case AI.PROVIDERS.GEMINI:     return 'gemini-1.5-flash';
    default:                      return 'stub';
  }
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI API error ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Stub provider — deterministic, zero cost
// ---------------------------------------------------------------------------

const STUB_TOPICS = [
  'Core Concepts', 'Key Definitions', 'Fundamental Principles',
  'Historical Context', 'Practical Applications', 'Common Misconceptions',
  'Advanced Techniques', 'Case Studies', 'Comparative Analysis',
  'Future Directions', 'Summary & Synthesis', 'Critical Thinking',
];

function stubComplete({ systemPrompt, userPrompt, jsonMode }) {
  if (jsonMode) {
    if (systemPrompt && systemPrompt.includes('flashcard')) {
      return JSON.stringify({
        flashcards: Array.from({ length: 10 }, (_, i) => ({
          front: `Question ${i + 1}: What is the key concept here?`,
          back: `Answer ${i + 1}: This refers to the fundamental principle described in the material.`,
          topic: STUB_TOPICS[i % STUB_TOPICS.length],
          difficulty: ['Easy', 'Medium', 'Hard'][i % 3],
        })),
      });
    }
    if (systemPrompt && systemPrompt.includes('quiz')) {
      return JSON.stringify({
        questions: Array.from({ length: 10 }, (_, i) => ({
          stem: `Question ${i + 1}: Which of the following best describes the concept?`,
          options: ['Option A', 'Option B', 'Option C', 'Option D'],
          correctAnswerIndex: 0,
          explanation: `Option A is correct because it accurately captures the principle.`,
          topic: STUB_TOPICS[i % STUB_TOPICS.length],
        })),
      });
    }
    if (systemPrompt && systemPrompt.includes('weak')) {
      return JSON.stringify({
        explanation: 'You need to review this topic more carefully. The key ideas are foundational.',
        keyTips: ['Review the definitions', 'Practice with examples', 'Connect to related concepts'],
      });
    }
    // Summary
    return JSON.stringify({
      topics: STUB_TOPICS.slice(0, 12),
      summary: 'This material covers a range of important concepts. Students should focus on the core definitions, understand the practical applications, and be able to apply critical thinking to novel scenarios. The content builds progressively from fundamentals to advanced topics.',
      key_points: [
        'Understand foundational definitions and core mechanics before tackling complex scenarios.',
        'Apply principles to practical real-world problems and case studies.',
        'Review edge cases and common misconceptions identified across modules.',
        'Synthesize theoretical knowledge with active problem-solving drills.',
      ],
      definitions: [
        { term: 'Core Concept', definition: 'The central thematic pillar upon which all downstream formulas and conclusions rely.' },
        { term: 'Fundamental Principle', definition: 'The governing rule or law that dictates behavior in standard conditions.' },
        { term: 'Synthesis', definition: 'Combining multiple distinct ideas into a unified, coherent understanding.' },
      ],
      main_concepts: [
        { title: 'Foundational Structure', description: 'Establishing basic definitions and the boundary conditions governing the subject matter.' },
        { title: 'Methodological Application', description: 'Applying established heuristics systematically to solve unfamiliar problems under time constraints.' },
      ],
      exam_tips: [
        'Focus on high-weight conceptual questions before diving into calculation details.',
        'Memorize core definitions so you can quickly eliminate wrong choices on multiple-choice sections.',
        'Practice time-boxing: allocate no more than 60 seconds per question on the first pass.',
      ],
    });
  }
  // Chat
  return `I've reviewed your study material. Based on the context provided, here is my response to your question:\n\n${userPrompt.slice(0, 100)}...\n\nThis is a stub response. Configure AI_PROVIDER and AI_API_KEY in your .env file to enable real AI responses.`;
}

function stubEmbed(texts) {
  // Return deterministic zero-vectors (dimension 1536 for text-embedding-3-small compat)
  return texts.map(() => new Array(1536).fill(0).map((_, i) => Math.sin(i * 0.01)));
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

async function openaiComplete({ systemPrompt, userPrompt, jsonMode, model }) {
  const url = (config.AI_BASE_URL || 'https://api.openai.com') + '/v1/chat/completions';
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt || 'You are a helpful study assistant.' },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
  const result = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.AI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return result.choices?.[0]?.message?.content || '';
}

async function openaiEmbed(texts, model = 'text-embedding-3-small') {
  const url = (config.AI_BASE_URL || 'https://api.openai.com') + '/v1/embeddings';
  const result = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.AI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });
  return (result.data || []).map(d => d.embedding);
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

async function anthropicComplete({ systemPrompt, userPrompt, jsonMode, model }) {
  const url = (config.AI_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
  const prompt = jsonMode
    ? userPrompt + '\n\nRespond with valid JSON only, no markdown code fences.'
    : userPrompt;
  const body = {
    model,
    max_tokens: 4096,
    system: systemPrompt || 'You are a helpful study assistant.',
    messages: [{ role: 'user', content: prompt }],
  };
  const result = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  return result.content?.[0]?.text || '';
}

// Anthropic doesn't have an embedding API — fall back to stub
async function anthropicEmbed(texts) {
  console.warn('[aiService] Anthropic does not support embeddings — using stub zero-vectors');
  return stubEmbed(texts);
}

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

async function geminiComplete({ systemPrompt, userPrompt, jsonMode, model }) {
  const baseUrl = config.AI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${config.AI_API_KEY}`;
  const prompt = jsonMode
    ? userPrompt + '\n\nRespond with valid JSON only, no markdown code fences.'
    : userPrompt;
  const body = {
    contents: [{ role: 'user', parts: [{ text: (systemPrompt ? systemPrompt + '\n\n' : '') + prompt }] }],
    generationConfig: { temperature: 0.7 },
  };
  const result = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return result.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function geminiEmbed(texts, model = 'text-embedding-004') {
  const baseUrl = config.AI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const embeddings = [];
  for (const text of texts) {
    const url = `${baseUrl}/v1beta/models/${model}:embedContent?key=${config.AI_API_KEY}`;
    const result = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] } }),
    });
    embeddings.push(result.embedding?.values || new Array(768).fill(0));
  }
  return embeddings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * complete({ systemPrompt, userPrompt, jsonMode })
 * Returns raw string (JSON string if jsonMode=true).
 */
async function complete({ systemPrompt = '', userPrompt, jsonMode = false }) {
  const provider = resolveProvider();
  const model = resolveModel(provider);

  try {
    switch (provider) {
      case AI.PROVIDERS.OPENAI:
        return await openaiComplete({ systemPrompt, userPrompt, jsonMode, model });
      case AI.PROVIDERS.ANTHROPIC:
        return await anthropicComplete({ systemPrompt, userPrompt, jsonMode, model });
      case AI.PROVIDERS.GEMINI:
        return await geminiComplete({ systemPrompt, userPrompt, jsonMode, model });
      case AI.PROVIDERS.STUB:
      default:
        return stubComplete({ systemPrompt, userPrompt, jsonMode });
    }
  } catch (err) {
    console.error('[aiService.complete] error:', err.message);
    // Fallback to stub on error so we never throw to the user
    return stubComplete({ systemPrompt, userPrompt, jsonMode });
  }
}

/**
 * completeJson({ systemPrompt, userPrompt })
 * Parses and returns the JSON object. Throws if parse fails.
 */
async function completeJson({ systemPrompt, userPrompt }) {
  const raw = await complete({ systemPrompt, userPrompt, jsonMode: true });
  // Strip markdown fences if provider returned them despite instruction
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('[aiService.completeJson] JSON parse error. Raw:', cleaned.slice(0, 300));
    throw new Error('AI returned non-JSON response');
  }
}

/**
 * embed(texts: string[]) → number[][]
 * Batch-embed texts. Silently falls back to stub on error.
 */
async function embed(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const provider = resolveProvider();
  try {
    switch (provider) {
      case AI.PROVIDERS.OPENAI:
        return await openaiEmbed(texts);
      case AI.PROVIDERS.ANTHROPIC:
        return await anthropicEmbed(texts);
      case AI.PROVIDERS.GEMINI:
        return await geminiEmbed(texts);
      default:
        return stubEmbed(texts);
    }
  } catch (err) {
    console.error('[aiService.embed] error:', err.message, '— falling back to stub zeros');
    return stubEmbed(texts);
  }
}

/**
 * getProviderInfo() — for metadata stored in summaries/flashcards rows.
 */
function getProviderInfo() {
  const provider = resolveProvider();
  return { provider, model: resolveModel(provider) };
}

module.exports = { complete, completeJson, embed, getProviderInfo };
