const { HTTP_STATUS, ERROR_CODES } = require("../config/constants");
const { AppError } = require("./errors");

function buildZodDetails(result) {
  if (!result || !result.error || !Array.isArray(result.error.issues)) {
    return undefined;
  }
  return result.error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
    code: i.code,
  }));
}

function validate(schema, { source = "body", strict = true } = {}) {
  return (req, _res, next) => {
    const input = source === "body"
      ? req.body
      : source === "params"
        ? req.params
        : source === "query"
          ? req.query
          : source === "headers"
            ? req.headers
            : undefined;

    const result = schema.safeParse(input);
    if (result.success) {
      if (strict) {
        if (source === "body") req.body = result.data;
        else if (source === "params") req.params = result.data;
        else if (source === "query") req.query = result.data;
      }
      return next();
    }

    throw new AppError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: "Request failed validation",
      status: HTTP_STATUS.BAD_REQUEST,
      details: buildZodDetails(result),
    });
  };
}

function validateBody(schema) {
  return validate(schema, { source: "body" });
}
function validateParams(schema) {
  return validate(schema, { source: "params" });
}
function validateQuery(schema) {
  return validate(schema, { source: "query" });
}
function validateHeaders(schema) {
  return validate(schema, { source: "headers", strict: false });
}

module.exports = {
  validate,
  validateBody,
  validateParams,
  validateQuery,
  validateHeaders,
};
