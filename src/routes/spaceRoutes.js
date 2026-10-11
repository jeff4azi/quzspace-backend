// routes/spaceRoutes.js
// Mounted at /api/v1/spaces/:id/* — all space-scoped endpoints.

const express = require('express');
const createRateLimiter = require('../middleware/rateLimit');
const idempotencyMiddleware = require('../middleware/idempotency');
const { RATE_LIMIT } = require('../config/constants');

// Controllers
const { visitSpace } = require('../controllers/spacesController');
const { getSummary, getSpaceTopics, regenerateSummary } = require('../controllers/summaryController');
const {
  listQuizzes, getQuiz, generateQuiz, takeQuiz,
  submitQuizInSpace, listHistory, getLeaderboard, deleteQuiz,
} = require('../controllers/quizController');
const { listFiles, uploadFile, textUpload, deleteFile } = require('../controllers/filesController');
const { listFlashcards, generateFlashcards, regenerateFlashcards, toggleMastery } = require('../controllers/flashcardController');
const { getWeakAreas, refreshWeakAreas } = require('../controllers/weakAreasController');
const { getMessages, sendMessage, clearMessages, getSuggestedPrompts } = require('../controllers/chatController');
const { getProgress } = require('../controllers/progressController');
const { createShare, addCollaborator, removeCollaborator, getCommunity } = require('../controllers/shareController');

const router = express.Router({ mergeParams: true });

// Rate limiters
const aiGenLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000, max: 1, keyPrefix: 'ai-gen',
});
const summaryRegenLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, max: 1, keyPrefix: 'summary-regen',
});
const chatLimiter = createRateLimiter({
  windowMs: RATE_LIMIT.AI_WINDOW_MS, max: RATE_LIMIT.AI_MAX_REQUESTS, keyPrefix: 'chat',
});

// --- Visit ------------------------------------------------------------------
router.post('/visit', visitSpace);

// --- Files ------------------------------------------------------------------
router.get('/files', listFiles);
router.post('/files', ...uploadFile);
router.post('/text-upload', textUpload);
router.delete('/files/:fileId', deleteFile);

// --- Summary ----------------------------------------------------------------
router.get('/summary', getSummary);
router.post('/summary/regenerate', summaryRegenLimiter, idempotencyMiddleware(), regenerateSummary);
router.get('/topics', getSpaceTopics); // backward compat

// --- Quizzes ----------------------------------------------------------------
router.get('/quizzes', listQuizzes);
router.get('/quizzes/history', listHistory);
router.post('/quizzes/generate', aiGenLimiter, idempotencyMiddleware(), generateQuiz);
router.get('/quizzes/:quizId', getQuiz);
router.delete('/quizzes/:quizId', deleteQuiz);
router.get('/quizzes/:quizId/take', takeQuiz);
router.post('/quizzes/:quizId/take', takeQuiz);
router.post('/quizzes/:quizId/submit', submitQuizInSpace);
router.get('/quizzes/:quizId/history', listHistory);
router.get('/quizzes/:quizId/leaderboard', getLeaderboard);

// --- Flashcards -------------------------------------------------------------
router.get('/flashcards', listFlashcards);
router.post('/flashcards/generate', aiGenLimiter, idempotencyMiddleware(), generateFlashcards);
router.post('/flashcards/regenerate', aiGenLimiter, idempotencyMiddleware(), regenerateFlashcards);
router.patch('/flashcards/:cardId', toggleMastery);
router.patch('/flashcards/:cardId/mastery', toggleMastery);

// --- Weak Areas -------------------------------------------------------------
router.get('/weak-areas', getWeakAreas);
router.post('/weak-areas/refresh', refreshWeakAreas);

// --- Chat -------------------------------------------------------------------
router.get('/chat/messages', getMessages);
router.post('/chat/messages', chatLimiter, sendMessage);
router.delete('/chat/messages', clearMessages);
router.get('/chat/suggested-prompts', getSuggestedPrompts);

// --- Progress ---------------------------------------------------------------
router.get('/progress', getProgress);

// --- Share / Collaborators --------------------------------------------------
router.post('/share', createShare);
router.post('/collaborators', addCollaborator);
router.delete('/collaborators/:userId', removeCollaborator);
router.get('/community', getCommunity);

module.exports = router;
