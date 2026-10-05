const asyncHandler = require("../lib/asyncHandler");
const { summaryService } = require("../services/summaryService");

const service = summaryService();

const getSpaceTopics = asyncHandler(async (req, res) => {
  const spaceId = req.params.id;
  const simulatePending = req.query.simulate_pending === "1";

  const result = service.getTopics(spaceId, { simulatePending });

  if (result.status === "not_generated") {
    return res.status(425).json({
      data: {
        status: "not_generated",
        topics: [],
        retry_after_ms: result.retry_after_ms || 1500,
      },
    });
  }

  res.json({
    data: {
      status: "ready",
      topics: result.topics,
    },
  });
});

module.exports = {
  getSpaceTopics,
};
