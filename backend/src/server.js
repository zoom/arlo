require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { initWebSocketServer } = require('./services/websocket');
const config = require('./config');
const prisma = require('./lib/prisma');
const logger = require('./lib/logger');
const { version } = require('../package.json');
const rateLimit = require('express-rate-limit');

// Check if we have a production build
const publicDir = path.join(__dirname, '..', 'public');
const hasProductionBuild = fs.existsSync(path.join(publicDir, 'index.html'));

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Trust proxy headers (required when behind ngrok, nginx, etc.)
// This fixes express-rate-limit X-Forwarded-For warnings
app.set('trust proxy', 1);

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Security headers (required by Zoom Apps)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Scheme-required URLs: bare hostnames are rejected by strict CSP parsers.
      scriptSrc: ["'self'", "https://appssdk.zoom.us", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "https:"],
      frameSrc: ["'self'", "https://appssdk.zoom.us"],
      // Zoom desktop client embeds the app surface.
      frameAncestors: ["'self'", "https://zoom.us", "https://*.zoom.us", "https://*.zoom.com"],
    },
  },
  // Allow Zoom client embedding: frame-ancestors CSP above is authoritative.
  frameguard: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
}));

// CORS configuration
const corsOptions = {
  origin: config.corsOrigins,
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// Cookie parsing (required for session management)
app.use(cookieParser());

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Debug mode: Log all POST/PUT/PATCH request bodies
if (logger.isDebug) {
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      logger.logRequest(req);
    }
    next();
  });
}

// HTTP request logging (morgan)
if (config.nodeEnv !== 'test') {
  // Use 'dev' format in debug mode for more readable output, 'combined' otherwise
  app.use(morgan(logger.isDebug ? 'dev' : 'combined'));
}

// =============================================================================
// RATE LIMITING
// =============================================================================

// Global rate limit
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', globalLimiter);

// Stricter rate limit for auth endpoints (poll-code has its own limiter below).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120, // Raised from 30: OAuth + meeting bootstrap can burst during app open.
  skip: (req) => req.path === '/poll-code', // poll-code uses authPollLimiter instead.
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts' },
});
app.use('/api/auth/', authLimiter);

// Poll-code endpoint needs a higher ceiling for temporary OAuth polling bursts.
const authPollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication status checks' },
});
app.use('/api/auth/poll-code', authPollLimiter);

// Stricter rate limit for AI endpoints
const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please try again later' },
});
app.use('/api/ai/', aiLimiter);

// =============================================================================
// ROUTES
// =============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    version,
  });
});

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/meetings', require('./routes/meetings'));
app.use('/api/search', require('./routes/search'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/rtms', require('./routes/rtms'));
app.use('/api/highlights', require('./routes/highlights'));
app.use('/api/home', require('./routes/home'));
app.use('/api/preferences', require('./routes/preferences'));
app.use('/api/zoom-meetings', require('./routes/zoom-meetings'));

// =============================================================================
// FRONTEND PROXY (with friendly startup page)
// =============================================================================

const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');

// Resolve frontend target from config/env (supports host:port or full URL)
const frontendTarget = /^https?:\/\//i.test(config.frontendUrl)
  ? config.frontendUrl
  : `http://${config.frontendUrl}`;

// Track frontend readiness
let frontendReady = false;

// Check frontend health
async function checkFrontendHealth() {
  try {
    await axios.get(frontendTarget, { timeout: 2000 });
    if (!frontendReady) {
      console.log(`Frontend is now ready at ${frontendTarget}`);
    }
    frontendReady = true;
    return true;
  } catch {
    frontendReady = false;
    return false;
  }
}

// Start checking immediately, then periodically until ready
checkFrontendHealth().then(ready => {
  if (!ready) {
    console.log('⏳ Waiting for frontend to be ready...');
    const healthCheckInterval = setInterval(async () => {
      if (await checkFrontendHealth()) {
        clearInterval(healthCheckInterval);
      }
    }, 2000);
  }
});

// HTML page shown while frontend is starting up
const getStartupPage = () => `
<!DOCTYPE html>
<html>
<head>
  <title>Arlo Meeting Assistant - Starting Up</title>
  <meta http-equiv="refresh" content="3">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .spinner {
      width: 50px;
      height: 50px;
      border: 4px solid rgba(255,255,255,0.1);
      border-left-color: #4f46e5;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: rgba(255,255,255,0.7); font-size: 0.9rem; }
    .subtext { margin-top: 1rem; font-size: 0.8rem; color: rgba(255,255,255,0.5); }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>Arlo Meeting Assistant</h1>
    <p>Starting up... please wait</p>
    <p class="subtext">This page will refresh automatically</p>
  </div>
</body>
</html>
`;

// Lightweight 503 page while the frontend process is still starting.
function sendFrontendStartupPage(res) {
  res.writeHead(503, {
    'Content-Type': 'text/html',
    'Retry-After': '3',
  });
  res.end(getStartupPage());
}

// Fail fast when the frontend is slow or still starting; avoids hung page loads.
const proxyTimeoutMs = 5000;

// Proxy middleware - DO NOT use ws:true as it intercepts ALL WebSocket upgrades
// Our WebSocket server (initialized separately) handles /ws connections
const frontendProxy = createProxyMiddleware({
  target: frontendTarget,
  changeOrigin: true,
  ws: false, // IMPORTANT: Don't proxy WebSockets - our WebSocket.Server handles /ws
  proxyTimeout: proxyTimeoutMs,
  timeout: proxyTimeoutMs,
  logLevel: 'warn',
  onError: (err, req, res) => {
    console.error('Proxy error:', err.message, 'for path:', req.path);
    // Mark frontend as unavailable so requests temporarily return startup page.
    frontendReady = false;

    // Only show startup page for frontend requests, not API requests.
    if (!req.path.startsWith('/api/')) {
      sendFrontendStartupPage(res);
    } else {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway - Frontend temporarily unavailable');
    }
  },
});

// Serve frontend - either from production build or proxy to dev server
if (hasProductionBuild) {
  console.log('📦 Serving production build from', publicDir);

  // Serve static files
  app.use(express.static(publicDir));

  // SPA fallback - serve index.html for all non-API routes
  app.use((req, res, next) => {
    // Skip API routes, health check, and WebSocket path
    if (req.path.startsWith('/api/') || req.path === '/health' || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });
} else {
  console.log(`No production build found, proxying to frontend at ${frontendTarget}`);

  // Apply proxy for frontend routes only
  app.use((req, res, next) => {
    // Skip API routes, health check, and WebSocket path
    if (req.path.startsWith('/api/') || req.path === '/health' || req.path.startsWith('/ws')) {
      return next();
    }

    // Log Zoom Marketplace webhook validation attempts
    if (req.headers['user-agent']?.includes('Zoom Marketplace')) {
      console.log('⚠️ Zoom Marketplace POST to:', req.path);
      console.log('Body:', JSON.stringify(req.body, null, 2));
      console.log('💡 This should be going to /api/rtms/webhook instead');
    }

    // If frontend is still booting, return a fast startup page instead of hanging.
    if (!frontendReady) {
      checkFrontendHealth()
        .then(isReady => {
          if (!isReady) {
            sendFrontendStartupPage(res);
            return;
          }
          frontendProxy(req, res, next);
        })
        .catch(() => sendFrontendStartupPage(res));
      return;
    }

    frontendProxy(req, res, next);
  });
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Global error handler - logs full error server-side, returns sanitized response
app.use((err, req, res, next) => {
  // Always log the full error server-side for debugging
  console.error('Error:', err.stack || err);

  const statusCode = err.statusCode || err.status || 500;

  // In production, hide error details to prevent information leakage
  const isProduction = config.nodeEnv === 'production';
  const message = isProduction && statusCode >= 500
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error');

  res.status(statusCode).json({
    error: isProduction ? 'Error' : (err.name || 'Error'),
    message: message,
    // Only include stack trace in development
    ...(config.nodeEnv === 'development' && { stack: err.stack }),
  });
});

// =============================================================================
// WEBSOCKET SERVER
// =============================================================================

initWebSocketServer(server);

// =============================================================================
// START SERVER
// =============================================================================

const PORT = config.port;

// Bind all interfaces so reverse proxies and sibling services can reach the API.
server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log(`🚀 Arlo Meeting Assistant Backend Server`);
  console.log('='.repeat(60));
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Port: ${PORT}`);
  console.log(`Public URL: ${config.publicUrl}`);
  console.log(`Database: ${config.databaseUrl ? 'Connected' : 'Not configured'}`);
  console.log(`AI Enabled: ${config.aiEnabled}`);
  console.log(`Default Model: ${config.defaultModel}`);
  console.log(`Log Level: ${logger.level}${logger.isDebug ? ' (request bodies will be logged)' : ''}`);
  console.log('='.repeat(60));
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing server gracefully...');
  server.close(() => {
    prisma.$disconnect().then(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Closing server gracefully...');
  server.close(() => {
    prisma.$disconnect().then(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = { app, server };
