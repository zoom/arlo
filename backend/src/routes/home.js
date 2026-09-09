/**
 * Home Routes - Demo Mode
 *
 * SECURITY: Home dashboard features that require stored data
 * are not available in demo mode.
 */
const express = require('express');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

router.use(optionalAuth);

/**
 * GET /api/home/highlights
 * Get this week's highlights - Returns empty in demo mode
 */
router.get('/highlights', async (req, res) => {
  return res.json({
    highlights: [],
    demoMode: true,
    message: 'Weekly highlights are not available in demo mode because meeting data is not stored.',
  });
});

/**
 * GET /api/home/reminders
 * Get reminders - Returns empty in demo mode
 */
router.get('/reminders', async (req, res) => {
  return res.json({
    reminders: [],
    demoMode: true,
    message: 'Reminders are not available in demo mode because meeting data is not stored.',
  });
});

module.exports = router;
