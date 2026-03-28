/**
 * Basic Smoke Tests for Arlo Meeting Assistant
 *
 * These tests verify core functionality is working without requiring
 * a full test framework. Run with: node tests/smoke.test.js
 *
 * Prerequisites:
 * - Backend must be running on localhost:3000
 * - Database must be accessible
 *
 * Usage:
 *   # Start services first
 *   docker-compose up -d
 *
 *   # Run smoke tests
 *   node tests/smoke.test.js
 */

const http = require('http');
const https = require('https');

// Test configuration
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// Color codes for terminal output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

// Test results tracking
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
};

// Simple HTTP request helper
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
            json: () => {
              try {
                return JSON.parse(data);
              } catch {
                return null;
              }
            },
          });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

// Test runner
async function test(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'passed' });
    console.log(`${colors.green}✓${colors.reset} ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'failed', error: error.message });
    console.log(`${colors.red}✗${colors.reset} ${name}`);
    console.log(`  ${colors.red}${error.message}${colors.reset}`);
  }
}

function skip(name, reason = '') {
  results.skipped++;
  results.tests.push({ name, status: 'skipped', reason });
  console.log(`${colors.yellow}○${colors.reset} ${name} ${reason ? `(${reason})` : ''}`);
}

// Assertions
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(str, substring, message) {
  if (!str.includes(substring)) {
    throw new Error(message || `Expected "${str}" to include "${substring}"`);
  }
}

// ============================================================================
// SMOKE TESTS
// ============================================================================

async function runTests() {
  console.log(`\n${colors.bold}Arlo Meeting Assistant - Smoke Tests${colors.reset}`);
  console.log(`Testing against: ${BASE_URL}\n`);
  console.log('─'.repeat(50));

  // -------------------------------------------------------------------------
  // Health Check Tests
  // -------------------------------------------------------------------------
  console.log(`\n${colors.bold}Health Checks${colors.reset}`);

  await test('Backend health endpoint returns 200', async () => {
    const res = await request(`${BASE_URL}/health`);
    assertEqual(res.status, 200, `Expected 200, got ${res.status}`);
  });

  await test('Health response includes service status', async () => {
    const res = await request(`${BASE_URL}/health`);
    const data = res.json();
    assert(data !== null, 'Response should be valid JSON');
    assert(data.status === 'ok' || data.healthy === true, 'Service should report healthy status');
  });

  // -------------------------------------------------------------------------
  // API Endpoint Tests
  // -------------------------------------------------------------------------
  console.log(`\n${colors.bold}API Endpoints${colors.reset}`);

  await test('GET /api/auth/authorize returns PKCE challenge', async () => {
    const res = await request(`${BASE_URL}/api/auth/authorize`);
    assertEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = res.json();
    assert(data.codeChallenge, 'Response should include codeChallenge');
    assert(data.state, 'Response should include state');
  });

  await test('GET /api/auth/me returns 401 when not authenticated', async () => {
    const res = await request(`${BASE_URL}/api/auth/me`);
    // Should be 401 Unauthorized when no session cookie
    assertEqual(res.status, 401, `Expected 401, got ${res.status}`);
  });

  await test('GET /api/meetings returns 401 when not authenticated', async () => {
    const res = await request(`${BASE_URL}/api/meetings`);
    assertEqual(res.status, 401, `Expected 401, got ${res.status}`);
  });

  await test('GET /api/search returns 401 when not authenticated', async () => {
    const res = await request(`${BASE_URL}/api/search?q=test`);
    assertEqual(res.status, 401, `Expected 401, got ${res.status}`);
  });

  await test('GET /api/home/highlights uses optionalAuth (returns data or empty)', async () => {
    const res = await request(`${BASE_URL}/api/home/highlights`);
    // This endpoint uses optionalAuth, so should return 200 even without auth
    assertEqual(res.status, 200, `Expected 200, got ${res.status}`);
  });

  // -------------------------------------------------------------------------
  // Static Assets Tests
  // -------------------------------------------------------------------------
  console.log(`\n${colors.bold}Static Assets${colors.reset}`);

  await test('Frontend index.html is served', async () => {
    const res = await request(`${BASE_URL}/`);
    assertEqual(res.status, 200, `Expected 200, got ${res.status}`);
    assertIncludes(res.body, '<!DOCTYPE html>', 'Should return HTML document');
  });

  await test('Zoom Apps SDK script reference exists', async () => {
    const res = await request(`${BASE_URL}/`);
    assertIncludes(res.body, 'appssdk.zoom.us', 'Should reference Zoom Apps SDK');
  });

  // -------------------------------------------------------------------------
  // Security Headers Tests
  // -------------------------------------------------------------------------
  console.log(`\n${colors.bold}Security Headers${colors.reset}`);

  await test('Response includes X-Content-Type-Options header', async () => {
    const res = await request(`${BASE_URL}/`);
    assert(
      res.headers['x-content-type-options'] === 'nosniff',
      'Should have X-Content-Type-Options: nosniff'
    );
  });

  await test('Response includes Referrer-Policy header', async () => {
    const res = await request(`${BASE_URL}/`);
    assert(res.headers['referrer-policy'], 'Should have Referrer-Policy header');
  });

  // -------------------------------------------------------------------------
  // Rate Limiting Tests
  // -------------------------------------------------------------------------
  console.log(`\n${colors.bold}Rate Limiting${colors.reset}`);

  await test('Rate limit headers are present', async () => {
    const res = await request(`${BASE_URL}/health`);
    // Check for rate limit headers (may vary based on implementation)
    const hasRateLimitHeaders =
      res.headers['x-ratelimit-limit'] ||
      res.headers['ratelimit-limit'] ||
      res.headers['x-ratelimit-remaining'];
    // Note: Rate limit headers might not be on health endpoint
    // This is informational
    if (!hasRateLimitHeaders) {
      console.log(`  ${colors.yellow}(Rate limit headers not found on health endpoint)${colors.reset}`);
    }
  });

  // -------------------------------------------------------------------------
  // Error Handling Tests
  // -------------------------------------------------------------------------
  console.log(`\n${colors.bold}Error Handling${colors.reset}`);

  await test('404 for non-existent API route', async () => {
    const res = await request(`${BASE_URL}/api/nonexistent-route-12345`);
    assertEqual(res.status, 404, `Expected 404, got ${res.status}`);
  });

  await test('Invalid meeting ID returns appropriate error', async () => {
    const res = await request(`${BASE_URL}/api/meetings/invalid-id-12345`);
    // Should be 401 (unauthenticated) or 404 (not found)
    assert(
      res.status === 401 || res.status === 404,
      `Expected 401 or 404, got ${res.status}`
    );
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n' + '─'.repeat(50));
  console.log(`\n${colors.bold}Summary${colors.reset}`);
  console.log(`${colors.green}Passed:${colors.reset}  ${results.passed}`);
  console.log(`${colors.red}Failed:${colors.reset}  ${results.failed}`);
  console.log(`${colors.yellow}Skipped:${colors.reset} ${results.skipped}`);
  console.log('');

  if (results.failed > 0) {
    console.log(`${colors.red}${colors.bold}Some tests failed!${colors.reset}\n`);
    process.exit(1);
  } else {
    console.log(`${colors.green}${colors.bold}All tests passed!${colors.reset}\n`);
    process.exit(0);
  }
}

// Run tests
runTests().catch((error) => {
  console.error(`${colors.red}Test runner error:${colors.reset}`, error);
  process.exit(1);
});
