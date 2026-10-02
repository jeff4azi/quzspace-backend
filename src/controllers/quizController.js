// controllers/quizController.js
const { quizService } = require("../services/quizService");

const service = quizService();

async function listQuizzes(req, res) {
  const spaceId = req.params.id;
  const rows = service.listForSpace(spaceId);
  res.json({ data: rows });
}

async function generateQuiz(req, res) {
  const spaceId = req.params.id;
  const { questionCount, difficulty, selectedTopics } = req.body || {};
  const idempotencyKey = req.headers["idempotency-key"];

  const quiz = service.generate({
    spaceId,
    questionCount,
    difficulty,
    selectedTopics,
  });

  res.status(201).json({
    data: {
      quiz,
    },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

async function deleteQuiz(req, res) {
  const spaceId = req.params.id;
  const quizId = req.params.quizId;
  const deleted = service.delete(spaceId, quizId);
  res.json({ data: { deleted, id: quizId } });
}

module.exports = {
  listQuizzes,
  generateQuiz,
  deleteQuiz,
};
