// controllers/filesController.js

const asyncHandler = require('../lib/asyncHandler');
const multer = require('multer');
const { z } = require('zod');
const { validateParams } = require('../lib/validate');
const filesService = require('../services/filesService');
const { FILES } = require('../config/constants');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILES.MAX_SIZE_BYTES },
});

const idSchema = z.object({ id: z.string().min(1) });

// GET /spaces/:id/files
const listFiles = asyncHandler(async (req, res) => {
  const files = await filesService.listFiles({ spaceId: req.params.id });
  res.json({ data: files });
});

// POST /spaces/:id/files  — multipart/form-data
const uploadFile = [
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No file provided' } });
    }
    const file = await filesService.uploadFile({
      spaceId: req.params.id,
      userId: req.user.id,
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
    res.status(202).json({ data: file });
  }),
];

// POST /spaces/:id/text-upload  — raw pasted text
const textUpload = asyncHandler(async (req, res) => {
  const { text, displayName } = req.body || {};
  const file = await filesService.createTextFile({
    spaceId: req.params.id,
    userId: req.user.id,
    text,
    displayName,
  });
  res.status(201).json({ data: file });
});

// DELETE /spaces/:id/files/:fileId
const deleteFile = asyncHandler(async (req, res) => {
  await filesService.deleteFile({
    spaceId: req.params.id,
    fileId: req.params.fileId,
    userId: req.user.id,
  });
  res.status(204).end();
});

module.exports = { listFiles, uploadFile, textUpload, deleteFile };
