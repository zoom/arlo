/**
 * Logger utility with log levels and debug mode support
 *
 * Log Levels (in order of verbosity):
 *   - error: Always shown, critical errors
 *   - warn:  Warnings and potential issues
 *   - info:  General operational info (default)
 *   - debug: Verbose debugging: request and response shapes (field names and
 *            types), never their content
 *
 * Usage:
 *   const logger = require('./lib/logger');
 *   logger.info('Server started');
 *   logger.debug('Request body:', body);
 *   logger.logRequest(req);  // Logs the request's shape in debug mode
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
 * Describe a value without revealing it: field names and types, never content.
 * Request bodies carry transcripts, names, ids and tokens, and no log level may
 * record those. `{ meetingId: 'string(18)', segment: { text: 'string(41)' } }`
 * is enough to debug a wrong payload shape.
 */
function describeShape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length === 0 ? 'array(0)' : `array(${value.length}) of ${JSON.stringify(describeShape(value[0], depth + 1))}`;
  }
  if (typeof value === 'object') {
    if (depth >= 3) return 'object';
    const shape = {};
    for (const key of Object.keys(value).slice(0, 30)) {
      shape[key] = describeShape(value[key], depth + 1);
    }
    return shape;
  }
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
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

    // Shape only. Never values: no query string (OAuth codes travel there), no
    // header values (cookies, keys, signatures), no body content (transcripts).
    const info = {
      method: req.method,
      path: req.path || String(req.originalUrl || '').split('?')[0],
      queryFields: req.query && Object.keys(req.query).length > 0 ? Object.keys(req.query) : undefined,
    };

    if (includeHeaders && req.headers) {
      info.headerNames = Object.keys(req.headers);
    }

    if (includeBody && req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      info.body = describeShape(req.body);
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
      body: body ? describeShape(body) : undefined,
    };

    console.log(...formatMessage('debug', ['📤 Response:', JSON.stringify(info, null, 2)]));
  },

  /**
   * Log POST/PUT/PATCH body specifically
   */
  logBody(label, body) {
    if (currentLevel < LOG_LEVELS.debug) return;
    console.log(...formatMessage('debug', [`📦 ${label}:`, JSON.stringify(describeShape(body), null, 2)]));
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
