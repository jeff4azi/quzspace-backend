const express = require('express');
const {
  listSpaces,
  createSpace,
  createSpaceBodySchema,
  getSpace,
  patchSpace,
  deleteSpace,
  patchSpaceBodySchema,
} = require('../controllers/spacesController');
const { validateBody, validateParams } = require('../lib/validate');
const { z } = require('zod');

const router = express.Router();

const idSchema = z.object({ id: z.string().min(1) });

router.get('/', listSpaces);

router.post('/', validateBody(createSpaceBodySchema), createSpace);

router.get(
  '/:id',
  validateParams(idSchema),
  getSpace,
);

router.patch(
  '/:id',
  validateParams(idSchema),
  validateBody(patchSpaceBodySchema),
  patchSpace,
);

router.delete(
  '/:id',
  validateParams(idSchema),
  deleteSpace,
);

module.exports = router;
