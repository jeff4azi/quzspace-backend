const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const config = require("./src/config");
const routes = require("./src/routes");
const authMiddleware = require("./src/middleware/auth");
const idempotencyMiddleware = require("./src/middleware/idempotency");
const { errorHandler, AppError } = require("./src/lib/errors");
const { HTTP_STATUS, ERROR_CODES } = require("./src/config/constants");

const app = express();
const PORT = config.PORT;
const API_PREFIX = config.API_PREFIX;

// ---------- Core middleware ---------------------------------------------------
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (config.CORS_ORIGINS.includes("*")) return callback(null, true);
      if (config.CORS_ORIGINS.includes(origin)) return callback(null, true);
      if (config.NODE_ENV === "development") return callback(null, true);
      return callback(
        new AppError({
          code: ERROR_CODES.FORBIDDEN,
          message: `Origin ${origin} not allowed by CORS`,
          status: HTTP_STATUS.FORBIDDEN,
        }),
      );
    },
    credentials: true,
    exposedHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
      "X-Idempotent-Hit",
    ],
  }),
);

app.use(
  express.json({
    limit: `${config.BODY_JSON_LIMIT_MB}mb`,
  }),
);

app.use(morgan(config.NODE_ENV === "production" ? "combined" : "dev"));

// ---------- Auth middleware (applies after CORS, before routes) --------------
app.use(authMiddleware());

// ---------- Idempotency middleware (before routes for POST/PATCH/PUT) --------
app.use(idempotencyMiddleware());

// ---------- Health endpoint (public, no auth per AUTH.SKIP_PATHS) ------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", env: config.NODE_ENV });
});

// ---------- API routes --------------------------------------------------------
app.use(API_PREFIX, routes);

// ---------- 404 fallback ------------------------------------------------------
app.use((req, _res, _next) => {
  throw new AppError({
    code: ERROR_CODES.NOT_FOUND,
    message: `Route ${req.method} ${req.originalUrl} does not exist.`,
    status: HTTP_STATUS.NOT_FOUND,
  });
});

// ---------- Central error handler (must be last) -----------------------------
// eslint-disable-next-line no-unused-vars
app.use(errorHandler);

// ---------- Unhandled exception safety ---------------------------------------
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error(
    `[${new Date().toISOString()}] UNHANDLED REJECTION:`,
    reason?.stack || reason?.message || reason,
  );
});

process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error(
    `[${new Date().toISOString()}] UNCAUGHT EXCEPTION:`,
    err?.stack || err?.message || err,
  );
  if (config.NODE_ENV === "production") process.exit(1);
});

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `\n  QuzSpace API · ${config.NODE_ENV}\n  Port ${PORT} · ${API_PREFIX}\n  CORS origins: ${config.CORS_ORIGINS.join(", ") || "(any)"}\n`,
    );
  });
}

module.exports = app;
