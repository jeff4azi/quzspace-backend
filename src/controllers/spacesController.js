const asyncHandler = require('../lib/asyncHandler');
const { z } = require('zod');
const spacesService = require('../services/spacesService');

const createSpaceBodySchema = z
  .object({
    title: z.string().min(1, 'title is required').max(200),
    subject: z.string().max(100).optional().default('General'),
    pastedText: z.string().max(500000).optional(),
    accentStyle: z.enum(['earth', 'ocean', 'sunset', 'forest', 'lavender']).optional(),
  })
  .strict();

const patchSpaceBodySchema = z
  .object({
    title: z.string().max(200).optional(),
    subject: z.string().max(100).optional(),
    accent_style: z.enum(['earth', 'ocean', 'sunset', 'forest', 'lavender']).optional(),
    description: z.string().max(2000).optional(),
    files_visible: z.boolean().optional(),
  })
  .strict();

const listSpaces = asyncHandler(async (req, res) => {
  res.json({ data: await spacesService.listForUser(req.user.id) });
});

const createSpace = asyncHandler(async (req, res) => {
  const data = await spacesService.create({
    userId: req.user.id,
    title: req.body.title,
    subject: req.body.subject,
    accentStyle: req.body.accentStyle,
    pastedText: req.body.pastedText,
  });
  res.status(201).json({ data });
});

const getSpace = asyncHandler(async (req, res) => {
  const data = await spacesService.getById({
    spaceId: req.params.id,
    userId: req.user.id,
  });
  res.json({ data });
});

const patchSpace = asyncHandler(async (req, res) => {
  const data = await spacesService.update({
    spaceId: req.params.id,
    userId: req.user.id,
    patch: req.body,
  });
  res.json({ data });
});

const deleteSpace = asyncHandler(async (req, res) => {
  await spacesService.remove({
    spaceId: req.params.id,
    userId: req.user.id,
  });
  res.status(204).end();
});

const visitSpace = asyncHandler(async (req, res) => {
  const lastAccessed = await spacesService.recordVisit({
    spaceId: req.params.id,
    userId: req.user.id,
  });
  res.status(201).json({ data: { last_accessed: lastAccessed } });
});

module.exports = {
  listSpaces,
  createSpace,
  getSpace,
  patchSpace,
  deleteSpace,
  visitSpace,
  createSpaceBodySchema,
  patchSpaceBodySchema,
};
