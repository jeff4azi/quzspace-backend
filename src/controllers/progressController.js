// controllers/progressController.js

const asyncHandler = require('../lib/asyncHandler');
const progressService = require('../services/progressService');

const getProgress = asyncHandler(async (req, res) => {
  const data = await progressService.getProgress(req.params.id, req.user.id);
  res.json({ data });
});

module.exports = { getProgress };
