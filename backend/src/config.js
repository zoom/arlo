require('dotenv').config({ path: '../.env' });

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
  'PUBLIC_URL',
  'DATABASE_URL',
  'SESSION_SECRET',
  'REDIS_ENCRYPTION_KEY',
];

// Validate required variables
const missing = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missing.length > 0) {
  console.error('❌ Missing required environment variables:');
  missing.forEach((varName) => console.error(`   - ${varName}`));
  console.error('\nPlease copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// Validate encryption key length (must be 32 characters for AES-256)
if (process.env.REDIS_ENCRYPTION_KEY.length !== 32) {
  console.error('❌ REDIS_ENCRYPTION_KEY must be exactly 32 characters');
  console.error(`   Current length: ${process.env.REDIS_ENCRYPTION_KEY.length}`);
  console.error('   Generate with: node -e "console.log(require(\'crypto\').randomBytes(16).toString(\'hex\'))"');
  process.exit(1);
}

const freeOpenRouterModels = Object.freeze([
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
]);

function parseCsv(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function freeModelOrDefault(model, defaultModel) {
  if (!model) return defaultModel;
  if (freeOpenRouterModels.includes(model)) return model;
  console.warn(`Ignoring non-free OpenRouter model "${model}". Allowed models: ${freeOpenRouterModels.join(', ')}`);
  return defaultModel;
}

const defaultOpenRouterModel = freeModelOrDefault(process.env.DEFAULT_MODEL, freeOpenRouterModels[0]);
const fallbackOpenRouterModel = freeModelOrDefault(process.env.FALLBACK_MODEL, freeOpenRouterModels[1]);
const fallbackOpenRouterModels = [...new Set([
  ...parseCsv(process.env.FALLBACK_MODELS).map((model) => freeModelOrDefault(model, null)).filter(Boolean),
  fallbackOpenRouterModel,
  freeOpenRouterModels[2],
])];

// =============================================================================
// CONFIGURATION EXPORT
// =============================================================================

module.exports = {
  // Zoom App
  zoomClientId: process.env.ZOOM_CLIENT_ID,
  zoomClientSecret: process.env.ZOOM_CLIENT_SECRET,
  zoomAppId: process.env.ZOOM_APP_ID || null,
  publicUrl: process.env.PUBLIC_URL,
  redirectUri: process.env.ZOOM_APP_REDIRECT_URI || `${process.env.PUBLIC_URL}/api/auth/callback`,

  // Zoom for Government support
  // Set ZOOM_HOST=zoomgov.com for ZfG deployments
  zoomHost: process.env.ZOOM_HOST || 'zoom.us',
  zoomOAuthUrl: `https://${process.env.ZOOM_HOST || 'zoom.us'}/oauth`,
  zoomApiUrl: `https://api.${process.env.ZOOM_HOST || 'zoom.us'}/v2`,

  // Database
  databaseUrl: process.env.DATABASE_URL,

  // Security
  sessionSecret: process.env.SESSION_SECRET,
  encryptionKey: process.env.REDIS_ENCRYPTION_KEY,

  // Redis
  redisUrl: process.env.REDIS_URL || null,
  realtimeKeyPrefix: process.env.REALTIME_KEY_PREFIX || 'arlo:realtime',
  realtimeChannelPrefix: process.env.REALTIME_CHANNEL_PREFIX || 'arlo:realtime',
  realtimeChannelPatterns: parseCsv(process.env.REALTIME_CHANNEL_PATTERNS),
  realtimeActiveTtlSeconds: parseInt(process.env.REALTIME_ACTIVE_TTL_SECONDS || '86400', 10),
  realtimeCompletedTtlSeconds: parseInt(process.env.REALTIME_COMPLETED_TTL_SECONDS || '3600', 10),
  realtimeReplayLimit: parseInt(process.env.REALTIME_REPLAY_LIMIT || '250', 10),

  // AI Configuration
  aiEnabled: process.env.AI_ENABLED === 'true',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || null,
  defaultModel: defaultOpenRouterModel,
  fallbackModel: fallbackOpenRouterModel,
  fallbackModels: fallbackOpenRouterModels,
  allowedOpenRouterModels: freeOpenRouterModels,

  // Feature Flags
  extractionEnabled: process.env.EXTRACTION_ENABLED === 'true',
  publicLinksEnabled: process.env.PUBLIC_LINKS_ENABLED === 'true',
  disableMeetingPersistence: process.env.DISABLE_MEETING_PERSISTENCE === 'true',

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',
  frontendUpstreamUrl: process.env.FRONTEND_UPSTREAM_URL || 'http://frontend:3000',
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '0', 10),

  // RTMS
  rtmsWebhookSecret: process.env.ZOOM_WEBHOOK_SECRET_TOKEN || process.env.RTMS_WEBHOOK_SECRET || null,
  internalWebhookSecret: process.env.INTERNAL_WEBHOOK_SECRET || null,
  rtmsPort: parseInt(process.env.RTMS_PORT || '3002', 10),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // CORS
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // File Storage
  vttStoragePath: process.env.VTT_STORAGE_PATH || './storage/vtt',
  s3Bucket: process.env.S3_BUCKET || null,
  s3Region: process.env.S3_REGION || null,
  s3AccessKey: process.env.S3_ACCESS_KEY || null,
  s3SecretKey: process.env.S3_SECRET_KEY || null,
};
