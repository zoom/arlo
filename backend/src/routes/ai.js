/**
 * AI Routes - Demo Mode
 *
 * SECURITY: AI features that work with real-time data are available.
 * Features requiring stored meeting data are not available.
 *
 * Available in demo mode:
 * - /suggest - Real-time AI suggestions
 * - /summary-live - Generate summary from provided transcript
 * - /extract-soap - Extract SOAP notes from provided transcript
 * - /sentiment - Analyze sentiment from provided text
 * - /key-moment - Detect key moments from provided text
 * - /status - Check AI service status
 *
 * Not available in demo mode:
 * - /summary - Requires stored meeting
 * - /action-items - Requires stored meeting
 * - /chat - Requires stored meetings
 * - /generate-title - Requires stored meeting
 */
const express = require('express');
const router = express.Router();
const config = require('../config');
const { requireAuth, optionalAuth, devAuthBypass } = require('../middleware/auth');
const {
  generateSummary,
  extractActionItems,
  extractSOAPNotes,
  analyzeSentiment,
  extractKeyMoment,
  generateSuggestions,
} = require('../services/openrouter');

router.use(devAuthBypass);

/**
 * POST /api/ai/summary
 * Generate meeting summary - Not available in demo mode
 */
router.post('/summary', requireAuth, async (req, res) => {
  return res.json({
    demoMode: true,
    message: 'Meeting summaries from stored transcripts are not available in demo mode. Use /api/ai/summary-live with real-time transcript data instead.',
    available: false,
  });
});

/**
 * POST /api/ai/action-items
 * Extract action items - Not available in demo mode
 */
router.post('/action-items', requireAuth, async (req, res) => {
  return res.json({
    demoMode: true,
    message: 'Action item extraction from stored meetings is not available in demo mode.',
    available: false,
  });
});

/**
 * POST /api/ai/extract-soap
 * Extract SOAP notes from healthcare transcript - AVAILABLE in demo mode
 */
router.post('/extract-soap', optionalAuth, async (req, res) => {
  const { transcript, currentSoap } = req.body;

  if (!config.aiEnabled) {
    return res.status(503).json({ error: 'AI features are disabled' });
  }

  if (!transcript) {
    return res.status(400).json({ error: 'transcript is required' });
  }

  try {
    console.log('SOAP extraction (demo mode - real-time)');
    const soapNotes = await extractSOAPNotes(transcript, currentSoap || {});
    res.json(soapNotes);
  } catch (error) {
    console.error('SOAP extraction error:', error.message);
    res.status(500).json({ error: 'Failed to extract SOAP notes' });
  }
});

/**
 * POST /api/ai/chat
 * Chat with transcripts - Not available in demo mode
 */
router.post('/chat', requireAuth, async (req, res) => {
  return res.json({
    demoMode: true,
    message: 'AI chat with stored transcripts is not available in demo mode. In the full version, you can ask questions about your past meetings.',
    available: false,
  });
});

/**
 * POST /api/ai/generate-title
 * Generate meeting title - Not available in demo mode
 */
router.post('/generate-title', requireAuth, async (req, res) => {
  return res.json({
    demoMode: true,
    message: 'Title generation from stored meetings is not available in demo mode.',
    available: false,
  });
});

// Rate limit: one suggest call per meeting per 5 minutes
const suggestRateLimit = new Map();

/**
 * POST /api/ai/suggest
 * Get real-time AI suggestions - AVAILABLE in demo mode
 */
router.post('/suggest', optionalAuth, async (req, res) => {
  const { meetingId, recentTranscript } = req.body;

  if (!config.aiEnabled) {
    return res.status(503).json({ error: 'AI features are disabled' });
  }

  if (!recentTranscript) {
    return res.status(400).json({ error: 'recentTranscript is required' });
  }

  // Rate limit per meeting
  if (meetingId) {
    const lastCall = suggestRateLimit.get(meetingId);
    if (lastCall && Date.now() - lastCall < 300000) {
      return res.status(429).json({ error: 'Too many requests. Wait 5 minutes.' });
    }
    suggestRateLimit.set(meetingId, Date.now());
  }

  try {
    const suggestions = await generateSuggestions(recentTranscript);
    res.json({ suggestions });
  } catch (error) {
    console.error('Suggest error:', error.message);
    res.json({ suggestions: [] });
  }
});

/**
 * GET /api/ai/status
 * Check AI service status - AVAILABLE in demo mode
 */
router.get('/status', (req, res) => {
  res.json({
    enabled: config.aiEnabled,
    hasApiKey: !!config.openrouterApiKey,
    defaultModel: config.defaultModel,
    fallbackModel: config.fallbackModel,
    demoMode: true,
    availableFeatures: ['suggest', 'summary-live', 'extract-soap', 'sentiment', 'key-moment'],
    unavailableFeatures: ['summary', 'action-items', 'chat', 'generate-title'],
  });
});

/**
 * POST /api/ai/sentiment
 * Analyze sentiment - AVAILABLE in demo mode
 */
router.post('/sentiment', optionalAuth, async (req, res) => {
  const { text } = req.body;

  if (!config.aiEnabled) {
    return res.status(503).json({ error: 'AI features are disabled' });
  }

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const result = await analyzeSentiment(text.trim());
    res.json(result);
  } catch (error) {
    console.error('Sentiment analysis error:', error.message);
    res.status(500).json({ error: 'Sentiment analysis failed' });
  }
});

/**
 * POST /api/ai/summary-live
 * Generate summary from provided transcript - AVAILABLE in demo mode
 */
router.post('/summary-live', optionalAuth, async (req, res) => {
  const { transcript, title } = req.body;

  if (!config.aiEnabled) {
    return res.status(503).json({ error: 'AI features are disabled' });
  }

  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 50) {
    return res.status(400).json({ error: 'transcript is required (min 50 chars)' });
  }

  try {
    console.log(`Generating live summary (${transcript.length} chars)`);
    const summary = await generateSummary(transcript.trim(), title || 'Live Meeting');

    res.json({
      summary,
      generatedAt: Date.now(),
    });
  } catch (error) {
    console.error('Live summary generation error:', error.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

/**
 * POST /api/ai/key-moment
 * Detect key moments - AVAILABLE in demo mode
 */
router.post('/key-moment', optionalAuth, async (req, res) => {
  const { text } = req.body;

  if (!config.aiEnabled) {
    return res.status(503).json({ error: 'AI features are disabled' });
  }

  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return res.status(400).json({ error: 'text is required (min 10 chars)' });
  }

  try {
    const result = await extractKeyMoment(text.trim());
    if (result) {
      res.json(result);
    } else {
      res.json({ skip: true });
    }
  } catch (error) {
    console.error('Key moment extraction error:', error.message);
    res.status(500).json({ error: 'Key moment extraction failed' });
  }
});

module.exports = router;
