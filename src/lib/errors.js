const { HTTP_STATUS, ERROR_CODES } = require("../config/constants");

class AppError extends Error {
  constructor({ code, message, status = HTTP_STATUS.INTERNAL, details }) {
    super(message || "An unexpected error occurred");
    this.name = "AppError";
    this.code = code || ERROR_CODES.INTERNAL;
    this.status = status;
    this.details = details || undefined;
  }
}

function isZodError(err) {
  return Boolean(
    err &&
      typeof err === "object" &&
      (err.name === "ZodError" ||
        (err.issues && Array.isArray(err.issues) && err._def)),
  );
}

function formatZodDetails(err) {
  if (!err || !Array.isArray(err.issues)) return undefined;
  return err.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
    code: i.code,
  }));
}

function errorHandler(err, req, res, _next) {
  // eslint-disable-next-line no-console
  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}  →  ${
        err?.name || "Error"
      }: ${err?.message || "(no message)"}`,
    );
    if (err && err.stack && !(err instanceof AppError)) {
      // eslint-disable-next-line no-console
      console.error(err.stack);
    }
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  if (isZodError(err)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: "Request failed validation",
        details: formatZodDetails(err),
      },
    });
  }

  if (err && err.type === "entity.parse.failed") {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: "Invalid JSON body",
      },
    });
  }

  return res.status(HTTP_STATUS.INTERNAL).json({
    error: {
      code: ERROR_CODES.INTERNAL,
      message: process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err?.message || "Internal server error",
    },
  });
}

module.exports = {
  AppError,
  errorHandler,
  isZodError,
  formatZodDetails,
};
