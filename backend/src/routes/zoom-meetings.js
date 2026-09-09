/**
 * Zoom Meetings Routes - Demo Mode
 *
 * SECURITY: Upcoming meetings and auto-open features are not
 * available in demo mode because they require persistent storage.
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/zoom-meetings
 * List upcoming meetings - Not available in demo mode
 */
router.get('/', requireAuth, async (req, res) => {
  return res.json({
    meetings: [],
    demoMode: true,
    message: 'Upcoming meetings list is not available in demo mode. In the full version, you can see your Zoom calendar and enable auto-open for specific meetings.',
  });
});

/**
 * POST /api/zoom-meetings/:meetingId/auto-open
 * Register auto-open - Not available in demo mode
 */
router.post('/:meetingId/auto-open', requireAuth, async (req, res) => {
  return res.json({
    success: false,
    demoMode: true,
    message: 'Auto-open registration is not available in demo mode.',
  });
});

/**
 * DELETE /api/zoom-meetings/:meetingId/auto-open
 * Remove auto-open - Not available in demo mode
 */
router.delete('/:meetingId/auto-open', requireAuth, async (req, res) => {
  return res.json({
    success: false,
    demoMode: true,
    message: 'Auto-open settings are not available in demo mode.',
  });
});

module.exports = router;
