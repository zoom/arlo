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
];

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

// Validate SESSION_SECRET is not a placeholder
const sessionSecret = process.env.SESSION_SECRET;
if (sessionSecret && /^your_.*_here$/i.test(sessionSecret)) {
  console.error('❌ SESSION_SECRET contains a placeholder value');
  console.error('   Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// Support new TOKEN_ENCRYPTION_KEY with REDIS_ENCRYPTION_KEY as fallback
const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY || process.env.REDIS_ENCRYPTION_KEY;
if (!encryptionKey) {
  console.error('❌ Missing TOKEN_ENCRYPTION_KEY (or legacy REDIS_ENCRYPTION_KEY)');
  console.error('   Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// Check for placeholder encryption key
if (/^your_.*_here$/i.test(encryptionKey)) {
  console.error('❌ TOKEN_ENCRYPTION_KEY contains a placeholder value');
  console.error('   Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// Validate encryption key length
// AES-256-GCM requires 32 bytes = 64 hex characters
// Legacy AES-128-CBC used 16 bytes = 32 hex characters (still supported for migration)
if (encryptionKey.length === 32) {
  console.warn('⚠️ Using legacy 32-char encryption key (AES-128). Upgrade to 64-char key for AES-256-GCM:');
  console.warn('   Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
} else if (encryptionKey.length !== 64) {
  console.error('❌ TOKEN_ENCRYPTION_KEY must be exactly 64 characters (32 bytes hex-encoded for AES-256)');
  console.error(`   Current length: ${encryptionKey.length}`);
  console.error('   Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

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
  encryptionKey: encryptionKey,

  // Redis
  redisUrl: process.env.REDIS_URL || null,

  // AI Configuration
  aiEnabled: process.env.AI_ENABLED === 'true',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || null,
  defaultModel: process.env.DEFAULT_MODEL || 'google/gemini-2.0-flash-thinking-exp:free',
  fallbackModel: process.env.FALLBACK_MODEL || 'meta-llama/llama-3.2-3b-instruct:free',

  // Feature Flags
  extractionEnabled: process.env.EXTRACTION_ENABLED === 'true',
  publicLinksEnabled: process.env.PUBLIC_LINKS_ENABLED === 'true',
  disableMeetingPersistence: process.env.DISABLE_MEETING_PERSISTENCE === 'true',

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',

  // RTMS
  rtmsWebhookSecret: process.env.RTMS_WEBHOOK_SECRET || null,
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
