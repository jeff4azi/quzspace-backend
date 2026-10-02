require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const routes = require("./src/routes");

const app = express();
const PORT = process.env.PORT || 5000;
const API_PREFIX = "/api/v1";

// ---------- Middleware ------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// ---------- Routes ----------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use(API_PREFIX, routes);

// ---------- 404 fallback ----------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.originalUrl} does not exist.`,
    },
  });
});

// ---------- Error handler ---------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error("Server error:", err?.stack || err?.message || err);
  res.status(500).json({
    error: {
      code: err?.code || "INTERNAL",
      message: err?.message || "Internal server error",
    },
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${PORT} · ${API_PREFIX}`);
});
