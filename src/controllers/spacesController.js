const asyncHandler = require("../lib/asyncHandler");
const { z } = require("zod");

const stubStore = [];

const createSpaceBodySchema = z.object({
  title: z.string().min(1, "title is required").max(200),
  subject: z.string().max(100).optional().default("General"),
  pastedText: z.string().max(500000).optional(),
  accentStyle: z.enum(["earth", "ocean", "sunset", "forest", "lavender"]).optional(),
});

const listSpaces = asyncHandler(async (_req, res) => {
  res.json({ data: stubStore.slice() });
});

const createSpace = asyncHandler(async (req, res) => {
  const body = createSpaceBodySchema.parse(req.body);
  const now = new Date().toISOString();
  const row = {
    id: `sp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: body.title,
    subject: body.subject,
    accent_style: body.accentStyle || "earth",
    owner_id: req.user?.id || null,
    file_count: body.pastedText ? 1 : 0,
    progress_percent: 0,
    last_accessed: now,
    active_members: req.user?.id
      ? [{ id: req.user.id, name: req.user.email || "You", role: "owner" }]
      : [],
    created_at: now,
    updated_at: now,
  };
  stubStore.unshift(row);
  res.status(201).json({ data: row });
});

const getSpace = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const row = stubStore.find((s) => s.id === id);
  if (!row) {
    const { AppError } = require("../lib/errors");
    const { HTTP_STATUS, ERROR_CODES } = require("../config/constants");
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: `Space ${id} not found`,
      status: HTTP_STATUS.NOT_FOUND,
    });
  }
  res.json({
    data: {
      ...row,
      role: req.user && row.owner_id === req.user.id ? "owner" : "collaborator",
    },
  });
});

module.exports = {
  listSpaces,
  createSpace,
  getSpace,
  createSpaceBodySchema,
};
