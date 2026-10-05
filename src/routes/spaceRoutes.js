// routes/spaceRoutes.js
// Mounted at /api/v1/spaces/:id/* — handles space-scoped endpoints.
// :id is already parsed by Express into req.params.id.

const express = require('express');
const { visitSpace } = require('../controllers/spacesController');
const { getSpaceTopics } = require('../controllers/summaryController');
const {
  listQuizzes,
  generateQuiz,
  deleteQuiz,
} = require('../controllers/quizController');

const router = express.Router({ mergeParams: true });

router.post('/visit', visitSpace);

// --- Topics / Summary -------------------------------------------------------
router.get('/topics', getSpaceTopics);

// --- Quizzes ----------------------------------------------------------------
router.get('/quizzes', listQuizzes);
router.post('/quizzes/generate', generateQuiz);
router.delete('/quizzes/:quizId', deleteQuiz);

module.exports = router;
