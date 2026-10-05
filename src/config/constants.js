exports.HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_EARLY: 425,
  TOO_MANY_REQUESTS: 429,
  INTERNAL: 500,
};

exports.ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  TOO_EARLY: "TOO_EARLY",
  RATE_LIMITED: "RATE_LIMITED",
  IDEMPOTENT_HIT: "IDEMPOTENT_HIT",
  UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
  INTERNAL: "INTERNAL",
};

exports.AI = {
  MAX_CONTEXT_CHARS: 60000,
  MAX_FILE_CONTEXT_CHARS: 10000,
  MAX_SUMMARY_INPUT_TOKENS: 12000,
  MAX_CHAT_HISTORY_TURNS: 20,
  CHUNK_SIZE_CHARS: 800,
  CHUNK_OVERLAP_CHARS: 150,
  MAX_CHUNKS_PER_SPACE: 4000,
  PROVIDERS: {
    STUB: "stub",
    OPENAI: "openai",
    ANTHROPIC: "anthropic",
    GEMINI: "gemini",
  },
  DEFAULT_PROVIDER: "stub",
};

exports.FILES = {
  MAX_SIZE_BYTES: 50 * 1024 * 1024,
  MAX_EXTRACTED_TEXT_CHARS: 2_000_000,
  SUPPORTED_MIME_TYPES: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "image/png",
    "image/jpeg",
  ],
  SUPPORTED_EXTENSIONS: [
    ".pdf",
    ".docx",
    ".pptx",
    ".txt",
    ".png",
    ".jpg",
    ".jpeg",
  ],
  STORAGE_BUCKET: "study-materials",
  STATUS: {
    UPLOADING: "uploading",
    EXTRACTING: "extracting",
    PROCESSED: "processed",
    FAILED: "failed",
  },
};

exports.RATE_LIMIT = {
  DEFAULT_WINDOW_MS: 60 * 60 * 1000,
  DEFAULT_MAX_REQUESTS: 60,
  AI_WINDOW_MS: 60 * 60 * 1000,
  AI_MAX_REQUESTS: 20,
  REGENERATE_WINDOW_MS: 60 * 60 * 1000,
  REGENERATE_MAX_REQUESTS: 5,
};

exports.IDEMPOTENCY = {
  TTL_MS: 10 * 60 * 1000,
  HEADER: "idempotency-key",
};

exports.PAGINATION = {
  DEFAULT_LIMIT: 50,
  MAX_LIMIT: 100,
};

exports.SPACES = {
  DEFAULT_QUIZ_COUNT: 10,
  MIN_QUIZ_COUNT: 1,
  MAX_QUIZ_COUNT: 50,
  DIFFICULTIES: ["Easy", "Medium", "Hard", "Mixed"],
  ACCENT_STYLES: ["earth", "ocean", "sunset", "forest", "lavender"],
};

exports.PROGRESS = {
  WEAK_AREA_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
  MIN_ANSWERS_PER_TOPIC_FOR_WEAK_AREA: 5,
  MASTERY_WEIGHTS: {
    QUIZ_SCORE: 0.4,
    FLASHCARD_RATIO: 0.4,
    SUMMARY_PRESENCE: 0.2,
  },
};

exports.AUTH = {
  SKIP_PATHS: [
    { method: "GET", path: "/health" },
    { methodPrefix: "GET", pathPrefix: "/api/s/" },
  ],
};
