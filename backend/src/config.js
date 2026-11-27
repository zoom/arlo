// Tests supply their own throwaway configuration and must never read the
// developer's real .env (its secrets, or settings that would change results).
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: '../.env' });
}

/**
 * Configuration validation and exports
 * Validates all required environment variables on startup
 */

// =============================================================================
// REQUIRED VARIABLES
// =============================================================================

const requiredEnvVars = [
  'ZOOM_CLIENT_ID',
  'ZOOM_CLIENT_SECRET',
  'ZOOM_WEBHOOK_TOKEN',
  // PUBLIC_URL is resolved separately (explicit value or injected external URL).
  'SESSION_SECRET',
];

// OAuth callbacks and webhook URLs need a stable public HTTPS base.
// Prefer explicit PUBLIC_URL; otherwise accept any injected *_EXTERNAL_URL env var.
function resolvePublicUrl() {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL;
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.startsWith('https://') && key.endsWith('_EXTERNAL_URL')) {
      return value;
    }
  }

  return null;
}

const resolvedPublicUrl = resolvePublicUrl();
if (!resolvedPublicUrl) {
  console.error('Missing public URL: set PUBLIC_URL');
  process.exit(1);
}

// RTMS runs as a separate process; wire host/port into the URL the backend forwards webhooks to.
if (!process.env.RTMS_SERVICE_URL && process.env.RTMS_HOST && process.env.RTMS_PORT) {
  process.env.RTMS_SERVICE_URL = `http://${process.env.RTMS_HOST}:${process.env.RTMS_PORT}`;
}

// The token encryption key must be 32 bytes (AES-256). Accepted forms: 64 hex
// characters, or base64 of 32 bytes (some hosts generate secrets that way).
// Returns the key as 64 hex characters, or null when it is neither.
function resolveEncryptionKey(raw) {
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return raw.toLowerCase();
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) {
      return decoded.toString('hex');
    }
  }
  return null;
}

// Validate required variables
const missing = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missing.length > 0) {
  console.error('❌ Missing required environment variables:');
  missing.forEach((varName) => console.error(`   - ${varName}`));
  console.error('\nPlease copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// Detect placeholder values from .env.example that weren't replaced
const placeholderPatterns = [
  /^your_.*_here$/i,
  /^your-.*-here$/i,
  /^your_\d+_character.*$/i,
  /^https:\/\/your-ngrok/i,
  /^https:\/\/.*\.ngrok-free\.app$/i, // Generic ngrok placeholder
];

const placeholderVars = requiredEnvVars.filter((varName) => {
  const value = process.env[varName];
  if (!value) return false;
  return placeholderPatterns.some(pattern => pattern.test(value));
});

if (placeholderVars.length > 0) {
  console.error('❌ Environment variables contain placeholder values:');
  placeholderVars.forEach((varName) => {
    console.error(`   - ${varName}="${process.env[varName]}"`);
  });
  console.error('\nReplace these with real values in your .env file.');
  process.exit(1);
}

if (process.env.PUBLIC_URL && placeholderPatterns.some((pattern) => pattern.test(process.env.PUBLIC_URL))) {
  // Catch leftover .env.example values before OAuth/webhook URLs are registered with Zoom.
  console.error('PUBLIC_URL contains a placeholder value');
  console.error(`   PUBLIC_URL="${process.env.PUBLIC_URL}"`);
  console.error('\nReplace this with your actual public HTTPS URL.');
  process.exit(1);
}

// Validate SESSION_SECRET is not a placeholder
const sessionSecret = process.env.SESSION_SECRET;
if (sessionSecret && /^your_.*_here$/i.test(sessionSecret)) {
  console.error('❌ SESSION_SECRET contains a placeholder value');
  console.error('   Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const KEY_HELP = '   Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';
const encryptionKeyRaw = process.env.TOKEN_ENCRYPTION_KEY;
if (!encryptionKeyRaw) {
  console.error('❌ Missing TOKEN_ENCRYPTION_KEY');
  if (process.env.REDIS_ENCRYPTION_KEY) {
    console.error('   REDIS_ENCRYPTION_KEY is set, but that older 16-byte key is no longer used.');
    console.error('   Set TOKEN_ENCRYPTION_KEY to a new 32-byte key instead.');
  }
  console.error(KEY_HELP);
  process.exit(1);
}

const encryptionKey = resolveEncryptionKey(encryptionKeyRaw);

// Free model IDs are retired often. These four were checked against
// https://openrouter.ai/api/v1/models on 2026-11-22; the first answered a live
// probe, the Gemma models were rate limited by their provider at the time.
// Order = fallback order.
const defaultOpenRouterModels = Object.freeze([
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
]);

function parseCsv(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const configuredOpenRouterModels = parseCsv(process.env.OPENROUTER_MODELS);
const allowedOpenRouterModels = Object.freeze(
  [...new Set(configuredOpenRouterModels.length > 0
    ? configuredOpenRouterModels
    : defaultOpenRouterModels)]
    .filter((model) => model.endsWith(':free'))
);

if (allowedOpenRouterModels.length === 0) {
  console.error('OPENROUTER_MODELS must contain at least one :free model');
  process.exit(1);
}

function allowedModelOrDefault(model, defaultModel) {
  if (!model) return defaultModel;
  if (allowedOpenRouterModels.includes(model)) return model;
  console.warn(`Ignoring unsupported OpenRouter model "${model}"`);
  return defaultModel;
}

const defaultOpenRouterModel = allowedModelOrDefault(
  process.env.DEFAULT_MODEL,
  allowedOpenRouterModels[0]
);
const fallbackOpenRouterModel = allowedModelOrDefault(
  process.env.FALLBACK_MODEL,
  allowedOpenRouterModels[1] || allowedOpenRouterModels[0]
);

// Validate placeholder against the raw env value, not the decoded/normalized key.
if (/^your_.*_here$/i.test(encryptionKeyRaw)) {
  console.error('❌ TOKEN_ENCRYPTION_KEY contains a placeholder value');
  console.error('   Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// AES-256-GCM needs a 32-byte key. The 16-byte keys that older versions
// accepted (AES-128) are refused: generate a new key. Nothing needs migrating,
// because tokens only live in memory and in 24-hour session cookies; users
// simply sign in again. The key itself is never printed.
if (!encryptionKey) {
  console.error('❌ TOKEN_ENCRYPTION_KEY must be a 32-byte key: 64 hex characters (or base64 of 32 bytes).');
  console.error(`   The current value is ${encryptionKeyRaw.length} characters and is not a valid key.`);
  console.error(KEY_HELP);
  process.exit(1);
}

// =============================================================================
// CONFIGURATION EXPORT
// =============================================================================

module.exports = {
  // Zoom App
  zoomClientId: process.env.ZOOM_CLIENT_ID,
  zoomClientSecret: process.env.ZOOM_CLIENT_SECRET,
  zoomWebhookToken: process.env.ZOOM_WEBHOOK_TOKEN,
  zoomAppId: process.env.ZOOM_APP_ID || null,
  publicUrl: resolvedPublicUrl,
  // Secure cookies whenever the app is served over HTTPS (ngrok, Render, etc.),
  // not only when NODE_ENV=production.
  secureCookies: String(resolvedPublicUrl || '').startsWith('https://'),
  redirectUri: process.env.ZOOM_APP_REDIRECT_URI || `${resolvedPublicUrl}/api/auth/callback`,

  // Zoom for Government support
  // Set ZOOM_HOST=zoomgov.com for ZfG deployments
  zoomHost: process.env.ZOOM_HOST || 'zoom.us',
  zoomOAuthUrl: `https://${process.env.ZOOM_HOST || 'zoom.us'}/oauth`,
  zoomApiUrl: `https://api.${process.env.ZOOM_HOST || 'zoom.us'}/v2`,

  // Demo Mode - no database, no persistent storage
  demoMode: process.env.DEMO_MODE === 'true',
  // How long a meeting's in-memory data is kept after its stream has stopped
  // and the last Arlo panel has disconnected (milliseconds). Default 2 minutes.
  // Whole milliseconds only, 100 to 3600000. Anything else ("2m", "120s", "0")
  // is refused with a warning and the default is used: a mistyped value must
  // not shrink the grace period to almost nothing.
  meetingFlushGraceMs: (() => {
    const DEFAULT_MS = 2 * 60 * 1000;
    const raw = process.env.MEETING_FLUSH_GRACE_MS;
    if (raw === undefined || raw === '') return DEFAULT_MS;
    const value = /^\d{1,7}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(value) && value >= 100 && value <= 60 * 60 * 1000) return value;
    console.warn('MEETING_FLUSH_GRACE_MS must be whole milliseconds between 100 and 3600000; using the default of 120000.');
    return DEFAULT_MS;
  })(),

  // How long a request to a meeting's owners (services/approvals.js: "share
  // the notes?") waits for an answer before it runs out (milliseconds).
  // Default 1 minute. Whole milliseconds only, 100 to 600000; anything else
  // is refused with a warning and the default is used.
  approvalExpiryMs: (() => {
    const DEFAULT_MS = 60 * 1000;
    const raw = process.env.APPROVAL_EXPIRY_MS;
    if (raw === undefined || raw === '') return DEFAULT_MS;
    const value = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(value) && value >= 100 && value <= 10 * 60 * 1000) return value;
    console.warn('APPROVAL_EXPIRY_MS must be whole milliseconds between 100 and 600000; using the default of 60000.');
    return DEFAULT_MS;
  })(),

  // How often the live notes are written again while new lines arrive
  // (milliseconds). Whole milliseconds only, 15000 to 600000; anything else
  // ("45s", "5") is refused with a warning and the default is used. Each run
  // is a model call, so a mistyped value must not turn into one call per line.
  notesIntervalMs: (() => {
    const DEFAULT_MS = 45000;
    const raw = process.env.NOTES_INTERVAL_MS;
    if (raw === undefined || raw === '') return DEFAULT_MS;
    const value = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(value) && value >= 15000 && value <= 600000) return value;
    console.warn('NOTES_INTERVAL_MS must be whole milliseconds between 15000 and 600000; using the default of 45000.');
    return DEFAULT_MS;
  })(),

  // Ask Zoom to start transcription as soon as someone opens Arlo in a meeting.
  // Off by default: nothing is requested from the host until a person clicks.
  autoStartRtms: process.env.AUTO_START_RTMS === 'true',

  // Offer "Use Arlo yourself" to a person in a meeting where someone else
  // already runs Arlo (a second RTMS stream in the same meeting). Offered by
  // default; ALLOW_OWN_ARLO_STREAM=false hides the button (only that exact
  // value does). Known gap: in the two-user test of 2026-11-23 Zoom sent no
  // second meeting.rtms_started webhook for the second person's start, so the
  // server never learned of it. Until that changes, the second person's start
  // can end on "Try again" instead of the notes. The server side (several
  // streams, one transcript) is built and does not depend on this setting.
  ownStream: process.env.ALLOW_OWN_ARLO_STREAM !== 'false',

  // Security
  sessionSecret: process.env.SESSION_SECRET,
  encryptionKey: encryptionKey,

  // Redis
  redisUrl: process.env.REDIS_URL || null,

  // AI Configuration
  aiEnabled: process.env.AI_ENABLED === 'true',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || null,
  defaultModel: defaultOpenRouterModel,
  fallbackModel: fallbackOpenRouterModel,
  fallbackModels: allowedOpenRouterModels.filter((model) => model !== defaultOpenRouterModel),
  allowedOpenRouterModels,
  // The model that writes the live notes: one of the allowed models, else the default
  notesModel: allowedModelOrDefault(process.env.NOTES_MODEL, defaultOpenRouterModel),
  // The model that picks a tool when someone asks Arlo for something: one of
  // the allowed models, else the default. Chosen with scripts/agent-eval.js
  agentModel: allowedModelOrDefault(process.env.AGENT_MODEL, defaultOpenRouterModel),
  // How a spoken "Arlo, …" is taken to come from an owner, so it runs without
  // the owners' approval (services/agent/speakerMatch.js):
  //   none              (default) never: every spoken request is someone else's
  //   participant_id    the line's speaker id equals the participantId an owner's panel reported
  //   participant_uuid  the line's speaker id equals a reported participantUUID
  // Set it only after GET …/arlo/identity-check showed which one matches in
  // real meetings. A name is never used. Anything else is 'none', with a warning.
  agentSpeakerMatch: (() => {
    // eslint-disable-next-line global-require
    const { mode, known } = require('./services/agent/speakerMatch').readSpeakerMatchMode(process.env.AGENT_SPEAKER_MATCH);
    if (!known) console.warn('AGENT_SPEAKER_MATCH must be none, participant_id or participant_uuid; using none.');
    return mode;
  })(),
  // Whether Arlo's tool table has web search (services/agent/tools.js). Off
  // unless WEB_SEARCH_ENABLED is exactly "true": it needs a paid model plugin
  webSearchEnabled: process.env.WEB_SEARCH_ENABLED === 'true',

  // Where "Arlo, open issue 42" opens an issue: the deployment's GitHub
  // repository as "owner/name" (lib/github.js). Opening an issue calls
  // nothing. Not set: Arlo has no such tool. A value that is not accepted is
  // ignored with one warning, which does not print it.
  githubRepo: (() => {
    // eslint-disable-next-line global-require
    const { repo, known } = require('./lib/github').readGithubRepo(process.env.GITHUB_DEFAULT_REPO);
    if (!known) console.warn('GITHUB_DEFAULT_REPO must be a GitHub repository written as owner/name; ignoring it.');
    return repo;
  })(),
  // "Connect GitHub" (routes/connectors.js): the GitHub App a signed-in user
  // connects their own GitHub account through. With it Arlo lists, reads and
  // creates issues in githubRepo as that person (services/connectors/): there
  // is no token of the deployment's. The client secret is a secret:
  // never logged, never sent to a browser, never put in a URL. Either one that
  // is set and not accepted is ignored with one warning that prints no value.
  githubAppClientId: (() => {
    // eslint-disable-next-line global-require
    const { clientId, known } = require('./services/connectors/githubConfig').readGithubAppClientId(process.env.GITHUB_APP_CLIENT_ID);
    if (!known) console.warn('GITHUB_APP_CLIENT_ID does not look like a GitHub App client ID; ignoring it.');
    return clientId;
  })(),
  githubAppClientSecret: (() => {
    // eslint-disable-next-line global-require
    const { clientSecret, known } = require('./services/connectors/githubConfig').readGithubAppClientSecret(process.env.GITHUB_APP_CLIENT_SECRET);
    if (!known) console.warn('GITHUB_APP_CLIENT_SECRET does not look like a GitHub App client secret; ignoring it.');
    return clientSecret;
  })(),
  // Connecting GitHub is available when the app's client ID and secret are
  // both set and the deployment has a repository
  get githubConnectAvailable() {
    return Boolean(this.githubAppClientId && this.githubAppClientSecret && this.githubRepo);
  },

  // Feature Flags
  extractionEnabled: process.env.EXTRACTION_ENABLED === 'true',
  publicLinksEnabled: process.env.PUBLIC_LINKS_ENABLED === 'true',
  disableMeetingPersistence: process.env.DISABLE_MEETING_PERSISTENCE === 'true',

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Default matches docker-compose service name; override with FRONTEND_URL when split across hosts.
  frontendUrl: process.env.FRONTEND_URL || 'http://frontend:3000',

  // RTMS
  rtmsPort: parseInt(process.env.RTMS_PORT || '3002', 10),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // CORS
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Rate Limiting
  rateLimitFree: parseInt(process.env.RATE_LIMIT_FREE || '10', 10),
  rateLimitPremium: parseInt(process.env.RATE_LIMIT_PREMIUM || '100', 10),

  // File Storage
  vttStoragePath: process.env.VTT_STORAGE_PATH || './storage/vtt',
  s3Bucket: process.env.S3_BUCKET || null,
  s3Region: process.env.S3_REGION || null,
  s3AccessKey: process.env.S3_ACCESS_KEY || null,
  s3SecretKey: process.env.S3_SECRET_KEY || null,
};
