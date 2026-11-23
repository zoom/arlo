/**
 * API tokens: create, list, revoke. Browser session only: a token cannot be
 * used to mint, list or revoke tokens. See lib/apiTokens.js.
 */
const express = require('express');
const apiTokens = require('../lib/apiTokens');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// These routes never accept a bearer credential
router.use((req, res, next) => {
  if (req.headers.authorization) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Managing API tokens requires a signed-in browser session' });
  }
  return requireAuth(req, res, next);
});

/** POST /api/tokens  { name?, scopes: [...], ttlMinutes? }  → the token, once */
router.post('/', (req, res) => {
  const { name, scopes, ttlMinutes } = req.body || {};
  const problem = apiTokens.validate({ name, scopes, ttlMinutes });
  if (problem) {
    return res.status(400).json({ error: 'Invalid request', message: problem, availableScopes: apiTokens.SCOPES });
  }
  const created = apiTokens.create({
    userId: req.user.id, zoomUserId: req.user.zoomUserId, name, scopes, ttlMinutes,
  });
  if (created.error === 'limit') {
    return res.status(429).json({
      error: 'Too many tokens',
      message: `You already have ${apiTokens.MAX_PER_USER} API tokens. Revoke one first.`,
    });
  }
  console.log('API token created');
  res.set('Cache-Control', 'no-store');
  return res.status(201).json({ ...created, note: 'Store this token now. It cannot be shown again.' });
});

/** GET /api/tokens → the caller's live tokens, without the secrets */
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ tokens: apiTokens.list(req.user.id), availableScopes: apiTokens.SCOPES });
});

/** DELETE /api/tokens/:id → revoke */
router.delete('/:id', (req, res) => {
  if (!apiTokens.revoke(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  console.log('API token revoked');
  return res.json({ revoked: true });
});

module.exports = router;
