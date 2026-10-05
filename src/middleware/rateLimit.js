const { AppError } = require("../lib/errors");
const { HTTP_STATUS, ERROR_CODES, RATE_LIMIT } = require("../config/constants");

function createRateLimiter({
  windowMs = RATE_LIMIT.DEFAULT_WINDOW_MS,
  max = RATE_LIMIT.DEFAULT_MAX_REQUESTS,
  keyPrefix = "global",
  skipOn = null,
} = {}) {
  const hits = new Map();

  function pruneExpired(now) {
    for (const [k, v] of hits.entries()) {
      if (now > v.resetAt) hits.delete(k);
    }
  }

  return function rateLimiter(req, res, next) {
    if (typeof skipOn === "function" && skipOn(req)) return next();

    const userId = req.user?.id || req.user_id;
    const keyBase = userId ? `u:${userId}` : `ip:${req.ip || "unknown"}`;
    const key = `${keyPrefix}:${keyBase}`;

    const now = Date.now();
    pruneExpired(now);

    const cur = hits.get(key) || { count: 0, resetAt: now + windowMs };
    cur.count += 1;
    hits.set(key, cur);

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - cur.count)));
    res.setHeader(
      "X-RateLimit-Reset",
      String(Math.ceil(cur.resetAt / 1000)),
    );

    if (cur.count > max) {
      const retrySec = Math.ceil((cur.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retrySec));
      return next(
        new AppError({
          code: ERROR_CODES.RATE_LIMITED,
          message: `Too many requests, try again in ${retrySec}s`,
          status: HTTP_STATUS.TOO_MANY_REQUESTS,
          details: { windowMs, max, retryAfterSec: retrySec },
        }),
      );
    }

    next();
  };
}

module.exports = createRateLimiter;
