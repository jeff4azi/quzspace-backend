const asyncHandler = require("../lib/asyncHandler");
const authService = require("../services/authService");

const signup = asyncHandler(async (req, res) => {
  const { email, password, name, displayName } = req.body || {};
  const result = await authService.signup({ email, password, name, displayName });
  res.status(201).json({
    data: {
      user: result.user,
      session: result.session,
      requiresLogin: !!result.requiresLogin,
    },
  });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const result = await authService.login({ email, password });
  res.json({
    data: {
      user: result.user,
      session: result.session,
    },
  });
});

const me = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.id);
  res.json({ data: user });
});

const updatePreferences = asyncHandler(async (req, res) => {
  const user = await authService.updatePreferences(req.user.id, req.body || {});
  res.json({ data: user });
});

module.exports = {
  signup,
  login,
  me,
  updatePreferences,
};
