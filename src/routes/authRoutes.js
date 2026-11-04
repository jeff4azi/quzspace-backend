const express = require("express");
const { z } = require("zod");
const { validateBody } = require("../lib/validate");
const {
  signup,
  login,
  me,
  updateProfile,
  updatePreferences,
} = require("../controllers/authController");

const signupSchema = z.object({
  email: z.string().trim().min(1, "email is required").email("Invalid email format"),
  password: z.string().min(6, "Password must be at least 6 characters").max(128),
  name: z.string().trim().min(1).max(100).optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().min(1, "email is required").email("Invalid email format"),
  password: z.string().min(1, "password is required").max(128),
});

const preferencesSchema = z.object({
  emailNotifications: z.boolean().optional(),
  studyReminders: z.boolean().optional(),
  weeklyReport: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
  defaultDifficulty: z.enum(["Easy", "Medium", "Hard", "Mixed"]).optional(),
  aiProviderPref: z.enum(["stub", "openai", "anthropic", "gemini"]).nullable().optional(),
  uiTheme: z.enum(["earth", "ocean", "sunset", "forest", "lavender"]).optional(),
}).strict();

const profileSchema = z.object({
  full_name: z.string().trim().min(1).max(100).optional(),
  avatar_initials: z.string().trim().min(1).max(3).optional(),
  avatar_color: z.string().trim().min(1).max(40).optional(),
}).strict();

const router = express.Router();

router.post("/signup", validateBody(signupSchema), signup);
router.post("/login", validateBody(loginSchema), login);
router.get("/me", me);
router.patch("/me/profile", validateBody(profileSchema), updateProfile);
router.patch("/preferences", validateBody(preferencesSchema), updatePreferences);

module.exports = router;
