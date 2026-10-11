// controllers/chatController.js

const asyncHandler = require('../lib/asyncHandler');
const chatService = require('../services/chatService');

const getMessages = asyncHandler(async (req, res) => {
  const messages = await chatService.getMessages(req.params.id, req.user.id);
  res.json({ data: messages });
});

const sendMessage = asyncHandler(async (req, res) => {
  const { content } = req.body || {};
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'content is required' } });
  }
  const result = await chatService.sendMessage(req.params.id, req.user.id, content.trim());
  res.status(201).json({ data: result });
});

const clearMessages = asyncHandler(async (req, res) => {
  await chatService.clearHistory(req.params.id, req.user.id);
  res.status(204).end();
});

const getSuggestedPrompts = asyncHandler(async (req, res) => {
  const prompts = await chatService.getSuggestedPrompts(req.params.id);
  res.json({ data: prompts });
});

module.exports = { getMessages, sendMessage, clearMessages, getSuggestedPrompts };
