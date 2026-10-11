// controllers/quizController.js

const asyncHandler = require('../lib/asyncHandler');
const quizService = require('../services/quizService');

const listQuizzes = asyncHandler(async (req, res) => {
  const rows = await quizService.listForSpace(req.params.id);
  res.json({ data: rows });
});

const getQuiz = asyncHandler(async (req, res) => {
  const quiz = await quizService.getById({
    spaceId: req.params.id,
    quizId: req.params.quizId,
    userId: req.user.id,
  });
  res.json({ data: quiz });
});

const generateQuiz = asyncHandler(async (req, res) => {
  const { questionCount, difficulty, selectedTopics } = req.body || {};
  const quiz = await quizService.generate({
    spaceId: req.params.id,
    userId: req.user.id,
    questionCount,
    difficulty,
    selectedTopics,
  });
  res.status(201).json({ data: quiz });
});

const takeQuiz = asyncHandler(async (req, res) => {
  const result = await quizService.take({
    spaceId: req.params.id,
    quizId: req.params.quizId,
    userId: req.user.id,
  });
  res.status(201).json({ data: result });
});

const submitAttempt = asyncHandler(async (req, res) => {
  const { answers } = req.body || {};
  const result = await quizService.submit({
    attemptId: req.params.attemptId,
    userId: req.user.id,
    answers,
  });
  res.json({ data: result });
});

const submitQuizInSpace = asyncHandler(async (req, res) => {
  const { attemptId: bodyAttemptId, answers } = req.body || {};
  let targetAttemptId = bodyAttemptId;
  if (!targetAttemptId) {
    const takeResult = await quizService.take({
      spaceId: req.params.id,
      quizId: req.params.quizId,
      userId: req.user.id,
    });
    targetAttemptId = takeResult.attemptId;
  }
  const result = await quizService.submit({
    attemptId: targetAttemptId,
    userId: req.user.id,
    answers,
  });
  res.json({ data: result });
});

const listHistory = asyncHandler(async (req, res) => {
  const rows = await quizService.listHistory({
    spaceId: req.params.id,
    quizId: req.params.quizId || req.query.quizId,
    userId: req.user.id,
  });
  res.json({ data: rows });
});

const getLeaderboard = asyncHandler(async (req, res) => {
  const rows = await quizService.leaderboard({
    spaceId: req.params.id,
    quizId: req.params.quizId,
    limit: Number(req.query.limit) || 10,
  });
  res.json({ data: rows });
});

const deleteQuiz = asyncHandler(async (req, res) => {
  await quizService.deleteQuiz({
    spaceId: req.params.id,
    quizId: req.params.quizId,
    userId: req.user.id,
  });
  res.status(204).end();
});

module.exports = {
  listQuizzes,
  getQuiz,
  generateQuiz,
  takeQuiz,
  submitAttempt,
  submitQuizInSpace,
  listHistory,
  getLeaderboard,
  deleteQuiz,
};
