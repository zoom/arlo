/**
 * Logger utility with log levels and debug mode support
 *
 * Log Levels (in order of verbosity):
 *   - error: Always shown, critical errors
 *   - warn:  Warnings and potential issues
 *   - info:  General operational info (default)
 *   - debug: Verbose debugging, including request bodies
 *
 * Usage:
 *   const logger = require('./lib/logger');
 *   logger.info('Server started');
 *   logger.debug('Request body:', body);
 *   logger.logRequest(req);  // Logs full request details in debug mode
 */

const config = require('../config');

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel = LOG_LEVELS[config.logLevel] ?? LOG_LEVELS.info;

/**
 * Format a log message with timestamp and level
 */
function formatMessage(level, args) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  return [prefix, ...args];
}

/**
 * Sanitize sensitive fields from objects before logging
 */
function sanitize(obj, sensitiveFields = ['password', 'token', 'secret', 'authorization', 'cookie', 'access_token', 'refresh_token']) {
  if (!obj || typeof obj !== 'object') return obj;

  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };

  for (const key of Object.keys(sanitized)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveFields.some(field => lowerKey.includes(field))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitize(sanitized[key], sensitiveFields);
    }
  }

  return sanitized;
}

const logger = {
  /**
   * Get current log level name
   */
  get level() {
    return config.logLevel;
  },

  /**
   * Check if debug mode is enabled
   */
  get isDebug() {
    return currentLevel >= LOG_LEVELS.debug;
  },

  /**
   * Error level - always shown
   */
  error(...args) {
    console.error(...formatMessage('error', args));
  },

  /**
   * Warning level
   */
  warn(...args) {
    if (currentLevel >= LOG_LEVELS.warn) {
      console.warn(...formatMessage('warn', args));
    }
  },

  /**
   * Info level (default)
   */
  info(...args) {
    if (currentLevel >= LOG_LEVELS.info) {
      console.log(...formatMessage('info', args));
    }
  },

  /**
   * Debug level - verbose logging
   */
  debug(...args) {
    if (currentLevel >= LOG_LEVELS.debug) {
      console.log(...formatMessage('debug', args));
    }
  },

  /**
   * Log an HTTP request with full details (debug mode only)
   * Sanitizes sensitive headers and body fields
   */
  logRequest(req, { includeBody = true, includeHeaders = true } = {}) {
    if (currentLevel < LOG_LEVELS.debug) return;

    const info = {
      method: req.method,
      path: req.path,
      url: req.originalUrl,
      query: Object.keys(req.query).length > 0 ? req.query : undefined,
    };

    if (includeHeaders) {
      info.headers = sanitize(req.headers);
    }

    if (includeBody && req.body && Object.keys(req.body).length > 0) {
      info.body = sanitize(req.body);
    }

    console.log(...formatMessage('debug', ['📥 Request:', JSON.stringify(info, null, 2)]));
  },

  /**
   * Log an HTTP response (debug mode only)
   */
  logResponse(req, res, body) {
    if (currentLevel < LOG_LEVELS.debug) return;

    const info = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      body: body ? sanitize(body) : undefined,
    };

    console.log(...formatMessage('debug', ['📤 Response:', JSON.stringify(info, null, 2)]));
  },

  /**
   * Log POST/PUT/PATCH body specifically
   */
  logBody(label, body) {
    if (currentLevel < LOG_LEVELS.debug) return;
    console.log(...formatMessage('debug', [`📦 ${label}:`, JSON.stringify(sanitize(body), null, 2)]));
  },

  /**
   * Create a child logger with a prefix (for module-specific logging)
   */
  child(prefix) {
    const childLogger = {};
    for (const method of ['error', 'warn', 'info', 'debug']) {
      childLogger[method] = (...args) => {
        logger[method](`[${prefix}]`, ...args);
      };
    }
    childLogger.logRequest = logger.logRequest.bind(logger);
    childLogger.logResponse = logger.logResponse.bind(logger);
    childLogger.logBody = (label, body) => logger.logBody(`${prefix} ${label}`, body);
    childLogger.isDebug = logger.isDebug;
    childLogger.level = logger.level;
    return childLogger;
  },
};

module.exports = logger;
