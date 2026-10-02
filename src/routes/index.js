// routes/index.js
// Central route registry. Import feature routers here so server.js only
// needs to register this one file per API prefix.

const express = require("express");
const spaceRoutes = require("./spaceRoutes");

const router = express.Router();

// Space-scoped endpoints: /api/v1/spaces/:id/...
router.use("/spaces/:id", spaceRoutes);

module.exports = router;
