/**
 * Search Routes - Demo Mode
 *
 * SECURITY: Search is not available in demo mode because
 * meeting data is never stored.
 */
const express = require('express');
const { requireAuth, devAuthBypass } = require('../middleware/auth');

const router = express.Router();

router.use(devAuthBypass);
router.use(requireAuth);

/**
 * GET /api/search
 * Search - Not available in demo mode
 */
router.get('/', async (req, res) => {
  const { q } = req.query;

  return res.json({
    query: q || '',
    titleResults: [],
    summaryResults: [],
    transcriptResults: [],
    results: [],
    total: 0,
    demoMode: true,
    message: 'Search is not available in demo mode. In the full version, you can search across all your meeting transcripts, titles, and AI summaries.',
  });
});

module.exports = router;
