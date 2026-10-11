// controllers/shareController.js

const asyncHandler = require('../lib/asyncHandler');
const shareService = require('../services/shareService');

const createShare = asyncHandler(async (req, res) => {
  const { filesVisible = true } = req.body || {};
  const result = await shareService.createShareLink({
    spaceId: req.params.id,
    userId: req.user.id,
    filesVisible: Boolean(filesVisible),
  });
  res.status(201).json({ data: result });
});

const resolveShare = asyncHandler(async (req, res) => {
  const result = await shareService.resolveCode(req.params.code);
  res.json({ data: result });
});

const addCollaborator = asyncHandler(async (req, res) => {
  const { email, role } = req.body || {};
  const result = await shareService.addCollaborator({
    spaceId: req.params.id,
    userId: req.user.id,
    email,
    role,
  });
  res.status(201).json({ data: result });
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
  const data = await shareService.getCommunity(req.params.id);
  res.json({ data });
});

module.exports = { createShare, resolveShare, addCollaborator, removeCollaborator, getCommunity };
