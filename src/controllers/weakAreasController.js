// controllers/weakAreasController.js

const asyncHandler = require('../lib/asyncHandler');
const weakAreasService = require('../services/weakAreasService');
const { HTTP_STATUS } = require('../config/constants');

const getWeakAreas = asyncHandler(async (req, res) => {
  const result = await weakAreasService.get(req.params.id, req.user.id);

  if (result.status === 'computing') {
    return res.status(HTTP_STATUS.TOO_EARLY).json({
      data: { status: 'computing', retry_after_ms: result.retry_after_ms || 3000 },
    });
  }
  if (result.status === 'insufficient_data') {
    return res.status(HTTP_STATUS.NO_CONTENT).end();
  }
  res.json({ data: result.data || [] });
});

const refreshWeakAreas = asyncHandler(async (req, res) => {
  weakAreasService.derive(req.params.id, req.user.id).catch(err =>
    console.error('[weakAreasController] refresh error:', err.message)
  );
  res.status(202).json({ data: { status: 'computing', retry_after_ms: 3000 } });
});

module.exports = { getWeakAreas, refreshWeakAreas };
