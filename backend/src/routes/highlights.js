/**
 * Highlights Routes - Demo Mode
 *
 * SECURITY: Highlights are not stored in demo mode.
 */
const express = require('express');
const { requireAuth, optionalAuth, devAuthBypass } = require('../middleware/auth');

const router = express.Router();

router.use(devAuthBypass);

/**
 * GET /api/highlights
 * Get highlights - Returns empty in demo mode
 */
router.get('/', optionalAuth, async (req, res) => {
  return res.json({
    highlights: [],
    demoMode: true,
    message: 'Highlights are not stored in demo mode.',
  });
});

/**
 * POST /api/highlights
 * Create highlight - Not available in demo mode
 */
router.post('/', requireAuth, async (req, res) => {
  return res.json({
    highlight: null,
    demoMode: true,
    message: 'Highlights cannot be saved in demo mode. In the full version, you can bookmark and annotate important moments in your meetings.',
  });
});

/**
 * PATCH /api/highlights/:id
 * Update highlight - Not available in demo mode
 */
router.patch('/:id', requireAuth, async (req, res) => {
  return res.json({
    highlight: null,
    demoMode: true,
    message: 'Highlights cannot be updated in demo mode.',
  });
});

/**
 * DELETE /api/highlights/:id
 * Delete highlight - Not available in demo mode
 */
router.delete('/:id', requireAuth, async (req, res) => {
  return res.json({
    demoMode: true,
    message: 'Nothing to delete - highlights are not stored in demo mode.',
  });
});

module.exports = router;
