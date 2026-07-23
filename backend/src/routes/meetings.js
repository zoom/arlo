/**
 * Meetings Routes - Demo Mode
 *
 * SECURITY: In demo mode, meeting data is never persisted.
 * These routes return demo-mode responses indicating features
 * are available in the full version.
 */
const express = require('express');
const { requireAuth, optionalAuth, devAuthBypass } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

router.use(devAuthBypass);

// Demo mode response helper
function demoModeResponse(res, feature) {
  return res.json({
    demoMode: true,
    feature,
    message: `${feature} is not available in demo mode. In the full version, this feature allows you to access your meeting history and transcripts.`,
    available: false,
  });
}

/**
 * GET /api/meetings
 * List meetings - Returns empty in demo mode
 */
router.get('/', optionalAuth, async (req, res) => {
  // In demo mode, return empty list with explanation
  return res.json({
    meetings: [],
    total: 0,
    cursor: null,
    demoMode: true,
    message: 'Meeting history is not available in demo mode. Your meeting data is never stored - all transcription happens in real-time only.',
  });
});

/**
 * PATCH /api/meetings/by-zoom-id/:zoomMeetingId/topic
 * Update meeting title - Accepts but doesn't persist in demo mode
 */
router.patch('/by-zoom-id/:zoomMeetingId/topic', optionalAuth, async (req, res) => {
  // Accept the request but explain it won't be persisted
  return res.json({
    updated: false,
    demoMode: true,
    message: 'Meeting titles are not persisted in demo mode.',
  });
});

/**
 * GET /api/meetings/by-zoom-id/:zoomMeetingId
 * Get meeting details by Zoom ID - Demo mode response
 */
router.get('/by-zoom-id/:zoomMeetingId', optionalAuth, async (req, res) => {
  return res.json({
    meeting: null,
    demoMode: true,
    pending: false,
    message: 'Meeting details are not stored in demo mode. Live transcription works in real-time via WebSocket.',
  });
});

/**
 * GET /api/meetings/by-zoom-id/:zoomMeetingId/transcript
 * Get transcript by Zoom ID - Returns empty in demo mode
 * Note: Live transcripts come via WebSocket, not this endpoint
 */
router.get('/by-zoom-id/:zoomMeetingId/transcript', optionalAuth, async (req, res) => {
  return res.json({
    segments: [],
    meetingDbId: null,
    demoMode: true,
    message: 'Transcript history is not stored in demo mode. Live transcripts are streamed via WebSocket during the meeting.',
  });
});

/**
 * GET /api/meetings/by-zoom-id/:zoomMeetingId/participant-events
 * Get participant events - Returns empty in demo mode
 */
router.get('/by-zoom-id/:zoomMeetingId/participant-events', optionalAuth, async (req, res) => {
  return res.json({
    events: [],
    demoMode: true,
    message: 'Participant events are not stored in demo mode.',
  });
});

/**
 * GET /api/meetings/:id
 * Get meeting by ID - Not available in demo mode
 */
router.get('/:id', optionalAuth, async (req, res) => {
  return demoModeResponse(res, 'Meeting details');
});

/**
 * GET /api/meetings/:id/transcript
 * Get transcript - Not available in demo mode
 */
router.get('/:id/transcript', optionalAuth, async (req, res) => {
  return res.json({
    segments: [],
    cursor: null,
    demoMode: true,
    message: 'Transcript history is not available in demo mode.',
  });
});

/**
 * GET /api/meetings/:id/participant-events
 * Get participant events - Not available in demo mode
 */
router.get('/:id/participant-events', optionalAuth, async (req, res) => {
  return res.json({
    events: [],
    demoMode: true,
    message: 'Participant events are not available in demo mode.',
  });
});

/**
 * PATCH /api/meetings/:id
 * Update meeting - Not available in demo mode
 */
router.patch('/:id', requireAuth, async (req, res) => {
  return demoModeResponse(res, 'Meeting updates');
});

/**
 * GET /api/meetings/:id/vtt
 * Export VTT - Not available in demo mode
 */
router.get('/:id/vtt', requireAuth, async (req, res) => {
  return res.status(400).json({
    error: 'VTT export is not available in demo mode',
    demoMode: true,
    message: 'Transcript exports require meeting history, which is not stored in demo mode.',
  });
});

/**
 * GET /api/meetings/:id/export/markdown
 * Export Markdown - Not available in demo mode
 */
router.get('/:id/export/markdown', requireAuth, async (req, res) => {
  return res.status(400).json({
    error: 'Markdown export is not available in demo mode',
    demoMode: true,
    message: 'Transcript exports require meeting history, which is not stored in demo mode.',
  });
});

/**
 * DELETE /api/meetings/:id
 * Delete meeting - Not available in demo mode
 */
router.delete('/:id', requireAuth, async (req, res) => {
  return res.json({
    demoMode: true,
    message: 'Nothing to delete - meetings are not stored in demo mode.',
  });
});

module.exports = router;
