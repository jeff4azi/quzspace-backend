process.env.SKIP_DOTENV = "1";

const app = require("../server");

module.exports = (req, res) => {
  if (!app || typeof app !== "function") {
    return res.status(500).json({
      error: {
        code: "INTERNAL",
        message: "Server handler failed to initialize — check env vars",
      },
    });
  }
  return app(req, res);
};
