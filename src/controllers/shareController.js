// controllers/shareController.js

const asyncHandler = require('../lib/asyncHandler');
const { z } = require('zod');
const shareService = require('../services/shareService');

const roleBodySchema = z
  .object({ role: z.enum(['viewer', 'collaborator']) })
  .strict();

const createShare = asyncHandler(async (req, res) => {
  const { filesVisible = true } = req.body || {};
  const result = await shareService.createShareLink({
    spaceId: req.params.id,
    userId: req.user.id,
    filesVisible: Boolean(filesVisible),
  });
  res.status(201).json({ data: result });
});

const revokeShare = asyncHandler(async (req, res) => {
  await shareService.deleteShareLink({
    spaceId: req.params.id,
    userId: req.user.id,
  });
  res.status(204).end();
});

const resolveShare = asyncHandler(async (req, res) => {
  const result = await shareService.resolveCode(req.params.code);
  res.json({ data: result });
});

// POST /spaces/:id/membership — "Save to my dashboard" (self-join as viewer).
const joinMembership = asyncHandler(async (req, res) => {
  const result = await shareService.joinSpace({
    spaceId: req.params.id,
    userId: req.user.id,
  });
  res.status(201).json({ data: result });
});

// DELETE /spaces/:id/membership/me — "Remove from dashboard" (self-leave).
const leaveMembership = asyncHandler(async (req, res) => {
  await shareService.leaveSpace({
    spaceId: req.params.id,
    userId: req.user.id,
  });
  res.status(204).end();
});

// PATCH /spaces/:id/collaborators/:userId — promote/demote a member (owner-only).
const updateCollaborator = asyncHandler(async (req, res) => {
  const result = await shareService.updateCollaboratorRole({
    spaceId: req.params.id,
    userId: req.user.id,
    targetUserId: req.params.userId,
    role: req.body.role,
  });
  res.json({ data: result });
});

const removeCollaborator = asyncHandler(async (req, res) => {
  await shareService.removeCollaborator({
    spaceId: req.params.id,
    userId: req.user.id,
    targetUserId: req.params.userId,
  });
  res.status(204).end();
});

const getCommunity = asyncHandler(async (req, res) => {
  const data = await shareService.getCommunity(req.params.id, req.user?.id, req.headers.origin);
  res.json({ data });
});

module.exports = {
  createShare,
  revokeShare,
  resolveShare,
  joinMembership,
  leaveMembership,
  updateCollaborator,
  removeCollaborator,
  getCommunity,
  roleBodySchema,
};
