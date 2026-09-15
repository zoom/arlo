/**
 * Preferences Routes - Demo Mode
 *
 * SECURITY: Preferences are stored in memory only.
 * They persist during the session but are cleared on server restart.
 */
const express = require('express');
const router = express.Router();
const { userStore } = require('../lib/memoryStore');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/preferences
 * Return user preferences from memory
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const preferences = userStore.getPreferences(req.user.id);
    res.json(preferences);
  } catch (error) {
    console.error('Error fetching preferences:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

/**
 * PUT /api/preferences
 * Update user preferences (stored in memory only)
 */
router.put('/', requireAuth, async (req, res) => {
  try {
    const existing = userStore.getPreferences(req.user.id);
    const merged = { ...existing, ...req.body };

    userStore.updatePreferences(req.user.id, merged);

    res.json(merged);
  } catch (error) {
    console.error('Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

module.exports = router;
