const express = require("express");
const authRoutes = require("./authRoutes");
const spacesRoutes = require("./spacesRoutes");
const spaceRoutes = require("./spaceRoutes");
const {
  submitAttempt,
  getQuiz,
  takeQuiz,
  submitQuizInSpace,
  listHistory,
  getLeaderboard,
} = require("../controllers/quizController");
const { toggleMastery } = require("../controllers/flashcardController");
const { resolveShare } = require("../controllers/shareController");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/spaces", spacesRoutes);
router.use("/spaces/:id", spaceRoutes);

// Quiz attempts submission
router.post("/attempts/:attemptId/submit", submitAttempt);

// Direct quiz endpoints (for frontends that call /quizzes/:quizId without /spaces/:id prefix)
router.get("/quizzes/:quizId", getQuiz);
router.get("/quizzes/:quizId/take", takeQuiz);
router.post("/quizzes/:quizId/take", takeQuiz);
router.post("/quizzes/:quizId/submit", submitQuizInSpace);
router.get("/quizzes/:quizId/history", listHistory);
router.get("/quizzes/:quizId/leaderboard", getLeaderboard);

// Direct flashcard mastery endpoint
router.patch("/flashcards/:cardId/mastery", toggleMastery);

// Public share resolver
router.get("/s/:code", resolveShare);

module.exports = router;

