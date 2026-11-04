// routes/spaceRoutes.js
// Mounted at /api/v1/spaces/:id/* — all space-scoped endpoints.
// Every route is gated by `requireSpaceRole(min)`:
//   viewer       → any tracked member (owner / collaborator / viewer)
//   collaborator → content authority (files, generation, weak areas)
//   owner        → space, member and share administration

const express = require('express');
const createRateLimiter = require('../middleware/rateLimit');
const idempotencyMiddleware = require('../middleware/idempotency');
const { requireSpaceRole } = require('../middleware/spaceAccess');
const { validateBody } = require('../lib/validate');
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
const {
  createShare, revokeShare, joinMembership, leaveMembership,
  updateCollaborator, removeCollaborator, getCommunity, roleBodySchema,
} = require('../controllers/shareController');

const router = express.Router({ mergeParams: true });

// Role guards
const requireViewer = requireSpaceRole('viewer');
const requireCollaborator = requireSpaceRole('collaborator');
const requireOwner = requireSpaceRole('owner');

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
router.post('/visit', requireViewer, visitSpace);

// --- Files ------------------------------------------------------------------
router.get('/files', requireViewer, listFiles);
router.post('/files', requireCollaborator, ...uploadFile);
router.post('/text-upload', requireCollaborator, textUpload);
router.delete('/files/:fileId', requireCollaborator, deleteFile);

// --- Summary ----------------------------------------------------------------
router.get('/summary', requireViewer, getSummary);
router.post('/summary/regenerate', requireCollaborator, summaryRegenLimiter, idempotencyMiddleware(), regenerateSummary);
router.get('/topics', requireViewer, getSpaceTopics); // backward compat

// --- Quizzes ----------------------------------------------------------------
router.get('/quizzes', requireViewer, listQuizzes);
router.get('/quizzes/history', requireViewer, listHistory);
router.post('/quizzes/generate', requireCollaborator, aiGenLimiter, idempotencyMiddleware(), generateQuiz);
router.get('/quizzes/:quizId', requireViewer, getQuiz);
router.delete('/quizzes/:quizId', requireCollaborator, deleteQuiz);
router.get('/quizzes/:quizId/take', requireViewer, takeQuiz);
router.post('/quizzes/:quizId/take', requireViewer, takeQuiz);
router.post('/quizzes/:quizId/submit', requireViewer, submitQuizInSpace);
router.get('/quizzes/:quizId/history', requireViewer, listHistory);
router.get('/quizzes/:quizId/leaderboard', requireViewer, getLeaderboard);

// --- Flashcards -------------------------------------------------------------
router.get('/flashcards', requireViewer, listFlashcards);
router.post('/flashcards/generate', requireCollaborator, aiGenLimiter, idempotencyMiddleware(), generateFlashcards);
router.post('/flashcards/regenerate', requireCollaborator, aiGenLimiter, idempotencyMiddleware(), regenerateFlashcards);
router.patch('/flashcards/:cardId', requireViewer, toggleMastery);
router.patch('/flashcards/:cardId/mastery', requireViewer, toggleMastery);

// --- Weak Areas -------------------------------------------------------------
router.get('/weak-areas', requireViewer, getWeakAreas);
router.post('/weak-areas/refresh', requireCollaborator, refreshWeakAreas);

// --- Chat -------------------------------------------------------------------
router.get('/chat/messages', requireViewer, getMessages);
router.post('/chat/messages', requireViewer, chatLimiter, sendMessage);
router.delete('/chat/messages', requireViewer, clearMessages);
router.get('/chat/suggested-prompts', requireViewer, getSuggestedPrompts);

// --- Progress ---------------------------------------------------------------
router.get('/progress', requireViewer, getProgress);

// --- Membership (self-service) ----------------------------------------------
// Joining is open to any authenticated user (that is the point — they are not
// a member yet). Leaving requires membership and is rejected for owners.
router.post('/membership', joinMembership);
router.delete('/membership/me', requireViewer, leaveMembership);

// --- Share / community ------------------------------------------------------
router.post('/share', requireOwner, createShare);
router.delete('/share', requireOwner, revokeShare);
router.patch('/collaborators/:userId', requireOwner, validateBody(roleBodySchema), updateCollaborator);
router.delete('/collaborators/:userId', requireOwner, removeCollaborator);
router.get('/community', requireViewer, getCommunity);

module.exports = router;
