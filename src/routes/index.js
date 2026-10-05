const express = require("express");
const authRoutes = require("./authRoutes");
const spacesRoutes = require("./spacesRoutes");
const spaceRoutes = require("./spaceRoutes");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/spaces", spacesRoutes);
router.use("/spaces/:id", spaceRoutes);

module.exports = router;
