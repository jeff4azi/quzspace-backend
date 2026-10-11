// controllers/flashcardController.js

const asyncHandler = require('../lib/asyncHandler');
const flashcardService = require('../services/flashcardService');
const { HTTP_STATUS } = require('../config/constants');

// GET /spaces/:id/flashcards
const listFlashcards = asyncHandler(async (req, res) => {
  const result = await flashcardService.list(req.params.id, req.user.id);
  if (result.status === 'empty') {
    return res.status(HTTP_STATUS.TOO_EARLY).json({
      data: { status: 'not_generated', retry_after_ms: 3000 },
    });
  }
  res.json({ data: result.cards });
});

// POST /spaces/:id/flashcards/generate
const generateFlashcards = asyncHandler(async (req, res) => {
  const cards = await flashcardService.generate(req.params.id, req.user.id);
  res.status(201).json({ data: cards });
});

// POST /spaces/:id/flashcards/regenerate
const regenerateFlashcards = asyncHandler(async (req, res) => {
  const cards = await flashcardService.generate(req.params.id, req.user.id, { regenerate: true });
  res.status(201).json({ data: cards });
});

// PATCH /spaces/:id/flashcards/:cardId
const toggleMastery = asyncHandler(async (req, res) => {
  const result = await flashcardService.toggleMastery({
    spaceId: req.params.id,
    cardId: req.params.cardId,
    userId: req.user.id,
  });
  res.json({ data: result });
});

module.exports = { listFlashcards, generateFlashcards, regenerateFlashcards, toggleMastery };
