require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Routes (to be added)
// app.use('/api/...', require('./src/routes/...'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
