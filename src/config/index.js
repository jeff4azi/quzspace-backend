if (process.env.SKIP_DOTENV !== "1") {
  require("dotenv").config();
}
const { z } = require("zod");
const { AI } = require("./constants");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  API_PREFIX: z.string().default("/api/v1"),

  SUPABASE_URL: z.string().url().min(1, "SUPABASE_URL is required"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SUPABASE_JWT_SECRET: z.string().optional(),

  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://localhost:3000")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),

  AI_PROVIDER: z
    .enum([AI.PROVIDERS.STUB, AI.PROVIDERS.OPENAI, AI.PROVIDERS.ANTHROPIC, AI.PROVIDERS.GEMINI])
    .default(AI.DEFAULT_PROVIDER),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),

  VITE_SUPABASE_ANON_KEY: z.string().optional(),
  VITE_SUPABASE_URL: z.string().url().optional(),

  BODY_JSON_LIMIT_MB: z.coerce.number().positive().default(2),
});

let validated = null;

function loadConfig() {
  if (validated) return validated;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    const msg =
      "Server failed to start: invalid or missing environment variables.\n" +
      issues.join("\n") +
      "\n\nCopy .env.example to .env and populate the required fields.";
    throw new Error(msg);
  }
  validated = result.data;
  return validated;
}

try {
  validated = loadConfig();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("\n" + "=".repeat(72));
  // eslint-disable-next-line no-console
  console.error(err.message);
  // eslint-disable-next-line no-console
  console.error("=".repeat(72) + "\n");
  process.exit(1);
}

module.exports = validated;
module.exports.loadConfig = loadConfig;
