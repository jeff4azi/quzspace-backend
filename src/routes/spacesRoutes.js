const express = require("express");
const {
  listSpaces,
  createSpace,
  createSpaceBodySchema,
  getSpace,
} = require("../controllers/spacesController");
const { validateBody, validateParams } = require("../lib/validate");
const { z } = require("zod");

const router = express.Router();

router.get("/", listSpaces);

router.post("/", validateBody(createSpaceBodySchema), createSpace);

router.get(
  "/:id",
  validateParams(z.object({ id: z.string().min(1) })),
  getSpace,
);

module.exports = router;
