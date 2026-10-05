const asyncHandler = require("../lib/asyncHandler");
const { AppError } = require("../lib/errors");
const { HTTP_STATUS, ERROR_CODES, AUTH } = require("../config/constants");

let supabase = null;

function resolvePublicSkip(req) {
  const method = req.method;
  const path = req.path;
  for (const rule of AUTH.SKIP_PATHS) {
    if (rule.method && rule.method !== method) continue;
    if (rule.path) {
      if (rule.path === path) return true;
      continue;
    }
    if (rule.pathPrefix && path.startsWith(rule.pathPrefix)) {
      if (!rule.methodPrefix || rule.methodPrefix === method) return true;
      if (!rule.methodPrefix) return true;
    }
  }
  return false;
}

function authMiddleware() {
  return asyncHandler(async (req, res, next) => {
    if (resolvePublicSkip(req)) {
      return next();
    }

    const header = req.headers.authorization;
    if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new AppError({
        code: ERROR_CODES.UNAUTHORIZED,
        message: "Missing or invalid Authorization header",
        status: HTTP_STATUS.UNAUTHORIZED,
      });
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      throw new AppError({
        code: ERROR_CODES.UNAUTHORIZED,
        message: "Authorization token is empty",
        status: HTTP_STATUS.UNAUTHORIZED,
      });
    }

    if (process.env.NODE_ENV === "test" && token.startsWith("test-token-")) {
      const parts = token.split(":");
      req.user = {
        id: parts[1] || "test-user-id",
        email: parts[2] || "test@example.com",
        role: "authenticated",
      };
      return next();
    }

    if (!supabase) {
      supabase = require("../lib/supabaseClient");
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      throw new AppError({
        code: ERROR_CODES.UNAUTHORIZED,
        message: error?.message || "Invalid or expired token",
        status: HTTP_STATUS.UNAUTHORIZED,
      });
    }

    req.user = {
      id: data.user.id,
      email: data.user.email || null,
      role: "authenticated",
    };

    next();
  });
}

module.exports = authMiddleware;
module.exports.resolvePublicSkip = resolvePublicSkip;
