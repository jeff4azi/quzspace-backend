const express = require("express");
const spacesRoutes = require("./spacesRoutes");
const spaceRoutes = require("./spaceRoutes");

const router = express.Router();

// Collection-level: /api/v1/spaces
router.use("/spaces", spacesRoutes);

// Space-scoped: /api/v1/spaces/:id/*
router.use("/spaces/:id", spaceRoutes);

module.exports = router;
