// controllers/summaryController.js
// GET /spaces/:id/summary → 425 if generating, 200 if ready, 500 if failed
// GET /spaces/:id/topics  → backward-compat topics-only endpoint
// POST /spaces/:id/summary/regenerate → rate-limited re-trigger

const asyncHandler = require('../lib/asyncHandler');
const summaryService = require('../services/summaryService');
const { HTTP_STATUS } = require('../config/constants');

const getSummary = asyncHandler(async (req, res) => {
  const spaceId = req.params.id;
  const result = await summaryService.getSummary(spaceId);

  if (result.status === 'generating' || result.status === 'not_started') {
    return res.status(HTTP_STATUS.TOO_EARLY).json({
      data: { status: result.status, retry_after_ms: result.retry_after_ms || 3000 },
    });
  }

  if (result.status === 'failed') {
    return res.status(HTTP_STATUS.INTERNAL).json({
      error: { code: 'SUMMARY_FAILED', message: result.error_message || 'Summary generation failed' },
    });
  }

  res.json({ data: result });
});

const regenerateSummary = asyncHandler(async (req, res) => {
  const spaceId = req.params.id;
  await summaryService.regenerate(spaceId);
  res.status(202).json({ data: { status: 'generating', retry_after_ms: 3000 } });
});

// Backward-compat: GET /spaces/:id/topics
const getSpaceTopics = asyncHandler(async (req, res) => {
  const spaceId = req.params.id;
  const simulatePending = req.query.simulate_pending === '1';

  if (simulatePending) {
    return res.status(425).json({
      data: { status: 'not_generated', topics: [], retry_after_ms: 1500 },
    });
  }

  const result = await summaryService.getTopics(spaceId);

  if (result.status !== 'ready') {
    return res.status(425).json({
      data: { status: result.status, topics: [], retry_after_ms: result.retry_after_ms || 3000 },
    });
  }

  res.json({ data: { status: 'ready', topics: result.topics } });
});

module.exports = { getSummary, regenerateSummary, getSpaceTopics };
