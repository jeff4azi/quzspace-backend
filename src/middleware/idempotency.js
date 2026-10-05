const { IDEMPOTENCY, HTTP_STATUS } = require("../config/constants");

const store = new Map();

function pruneExpired(now) {
  for (const [k, v] of store.entries()) {
    if (now > v.expiresAt) store.delete(k);
  }
}

function buildFullKey(req) {
  const userPart = req.user?.id || req.user_id || `ip:${req.ip || "anon"}`;
  const headerKey = req.header(IDEMPOTENCY.HEADER);
  if (!headerKey) return null;
  return `${userPart}:${headerKey}`;
}

function idempotencyMiddleware({ ttlMs = IDEMPOTENCY.TTL_MS } = {}) {
  return function idempotency(req, res, next) {
    if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "PUT") {
      return next();
    }

    const fk = buildFullKey(req);
    if (!fk) return next();

    const now = Date.now();
    pruneExpired(now);

    const cached = store.get(fk);
    if (cached) {
      res.setHeader("X-Idempotent-Hit", "1");
      return res.status(cached.status).json(cached.body);
    }

    const originalJson = res.json.bind(res);
    let statusOverride = HTTP_STATUS.OK;
    const originalStatus = res.status.bind(res);
    res.status = (code) => {
      statusOverride = code;
      return originalStatus(code);
    };

    res.json = (body) => {
      const finalStatus =
        (res.statusCode && res.statusCode >= 200 && res.statusCode < 400)
          ? res.statusCode
          : statusOverride;
      if (finalStatus >= 200 && finalStatus < 400) {
        store.set(fk, {
          expiresAt: now + ttlMs,
          status: finalStatus,
          body,
        });
      }
      return originalJson(body);
    };

    next();
  };
}

module.exports = idempotencyMiddleware;
module.exports.buildFullKey = buildFullKey;
module.exports._store = store;
