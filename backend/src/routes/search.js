const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { requireAuth, devAuthBypass } = require('../middleware/auth');

const router = express.Router();

/**
 * Sanitize search query for use with MySQL full-text search.
 * Removes special characters that could cause issues.
 */
function sanitizeSearchQuery(query) {
  if (!query) return '';
  // Remove MySQL full-text special characters: + - > < ( ) ~ * " @
  // Replace with spaces to preserve word boundaries
  return query.replace(/[+\-><()~*"@]/g, ' ').trim();
}

// Apply auth middleware to all routes
// IMPORTANT: devAuthBypass must run BEFORE requireAuth so it can set req.user in dev mode
router.use(devAuthBypass); // Allow dev mode query param bypass
router.use(requireAuth);

/**
 * Extract a snippet from a summary field that matches the query.
 * Returns { text, field } or null if no match found.
 */
function getSummarySnippet(summary, query) {
  if (!summary || !query) return null;
  const q = query.toLowerCase();

  const fields = [
    { key: 'overview', label: 'Overview', value: summary.overview },
    { key: 'keyPoints', label: 'Key Points', values: summary.keyPoints },
    { key: 'decisions', label: 'Decisions', values: summary.decisions },
    { key: 'nextSteps', label: 'Next Steps', values: summary.nextSteps },
  ];

  for (const field of fields) {
    if (field.value) {
      const idx = field.value.toLowerCase().indexOf(q);
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(field.value.length, idx + query.length + 30);
        const text = (start > 0 ? '...' : '') + field.value.substring(start, end) + (end < field.value.length ? '...' : '');
        return { text, field: field.label };
      }
    }
    if (field.values && Array.isArray(field.values)) {
      for (const item of field.values) {
        const idx = item.toLowerCase().indexOf(q);
        if (idx !== -1) {
          const start = Math.max(0, idx - 30);
          const end = Math.min(item.length, idx + query.length + 30);
          const text = (start > 0 ? '...' : '') + item.substring(start, end) + (end < item.length ? '...' : '');
          return { text, field: field.label };
        }
      }
    }
  }

  return null;
}

/**
 * GET /api/search
 * Multi-source search: titles -> summaries -> transcripts
 */
router.get('/', async (req, res) => {
  try {
    const { q: rawQuery, meeting_id, from, to, limit = 20 } = req.query;

    if (!rawQuery) {
      return res.status(400).json({ error: 'Missing search query (q parameter)' });
    }

    // Sanitize query to prevent tsquery operator injection
    const q = sanitizeSearchQuery(rawQuery);

    if (!q) {
      return res.status(400).json({ error: 'Invalid search query' });
    }

    console.log(`🔍 Searching for: "${q}"`);

    // Build meeting filter — only search the authenticated user's meetings
    const ownerIds = [req.user.id];

    const meetingWhere = {
      ownerId: req.user.id,
      ...(meeting_id && { id: meeting_id }),
      ...(from && { startTime: { gte: new Date(from) } }),
      ...(to && { startTime: { lte: new Date(to) } }),
    };

    // Run all three searches in parallel
    const [titleMatches, summaryMeetings, transcriptSegments] = await Promise.all([
      // 1. Title search
      prisma.meeting.findMany({
        where: {
          ...meetingWhere,
          title: { contains: q, mode: 'insensitive' },
        },
        select: {
          id: true,
          title: true,
          startTime: true,
          status: true,
          _count: { select: { segments: true } },
        },
        orderBy: { startTime: 'desc' },
        take: parseInt(limit),
      }),

      // 2. Summary search (JSON fields - MySQL)
      prisma.$queryRaw`
        SELECT m.id, m.title, m.start_time as startTime, m.summary
        FROM meetings m
        WHERE m.owner_id IN (${Prisma.join(ownerIds)})
          AND m.summary IS NOT NULL
          ${meeting_id ? Prisma.sql`AND m.id = ${meeting_id}` : Prisma.empty}
          ${from ? Prisma.sql`AND m.start_time >= ${new Date(from)}` : Prisma.empty}
          ${to ? Prisma.sql`AND m.start_time <= ${new Date(to)}` : Prisma.empty}
          AND (
            JSON_UNQUOTE(JSON_EXTRACT(m.summary, '$.overview')) LIKE ${'%' + q + '%'}
            OR CAST(m.summary->'$.keyPoints' AS CHAR) LIKE ${'%' + q + '%'}
            OR CAST(m.summary->'$.decisions' AS CHAR) LIKE ${'%' + q + '%'}
            OR CAST(m.summary->'$.nextSteps' AS CHAR) LIKE ${'%' + q + '%'}
          )
        ORDER BY m.start_time DESC
        LIMIT ${parseInt(limit)}
      `,

      // 3. Transcript full-text search (MySQL FULLTEXT)
      // Note: Requires FULLTEXT index on transcript_segments.text column
      // Falls back to LIKE search if FULLTEXT is not available
      prisma.$queryRaw`
        SELECT
          ts.id,
          ts.meeting_id as meetingId,
          ts.speaker_id as speakerId,
          ts.t_start_ms as tStartMs,
          ts.t_end_ms as tEndMs,
          ts.text,
          ts.confidence,
          m.id as \`meeting.id\`,
          m.title as \`meeting.title\`,
          m.start_time as \`meeting.startTime\`,
          s.label as \`speaker.label\`,
          s.display_name as \`speaker.displayName\`,
          MATCH(ts.text) AGAINST(${q} IN NATURAL LANGUAGE MODE) as \`rank\`
        FROM transcript_segments ts
        INNER JOIN meetings m ON ts.meeting_id = m.id
        LEFT JOIN speakers s ON ts.speaker_id = s.id
        WHERE
          MATCH(ts.text) AGAINST(${q} IN NATURAL LANGUAGE MODE)
          AND m.owner_id IN (${Prisma.join(ownerIds)})
          ${meeting_id ? Prisma.sql`AND m.id = ${meeting_id}` : Prisma.empty}
          ${from ? Prisma.sql`AND m.start_time >= ${new Date(from)}` : Prisma.empty}
          ${to ? Prisma.sql`AND m.start_time <= ${new Date(to)}` : Prisma.empty}
        ORDER BY \`rank\` DESC, m.start_time DESC, ts.t_start_ms ASC
        LIMIT ${parseInt(limit)}
      `,
    ]);

    // Format title results
    const titleResults = titleMatches.map(m => ({
      type: 'title',
      meetingId: m.id,
      meetingTitle: m.title,
      meetingDate: m.startTime,
      segmentCount: m._count.segments,
    }));

    // Format summary results (deduplicate against title matches)
    const titleMatchIds = new Set(titleMatches.map(m => m.id));
    const summaryResults = summaryMeetings
      .filter(m => !titleMatchIds.has(m.id))
      .map(m => {
        const snippet = getSummarySnippet(m.summary, q);
        return {
          type: 'summary',
          meetingId: m.id,
          meetingTitle: m.title,
          meetingDate: m.startTime,
          snippet: snippet?.text || '',
          matchField: snippet?.field || '',
        };
      });

    // Format transcript results
    const formattedSegments = transcriptSegments.map(seg => ({
      id: seg.id,
      meetingId: seg.meetingId || seg['meeting.id'],
      speakerId: seg.speakerId,
      tStartMs: seg.tStartMs,
      tEndMs: seg.tEndMs,
      text: seg.text,
      confidence: seg.confidence,
      meeting: {
        id: seg['meeting.id'],
        title: seg['meeting.title'],
        startTime: seg['meeting.startTime'],
      },
      speaker: seg['speaker.label'] ? {
        label: seg['speaker.label'],
        displayName: seg['speaker.displayName'],
      } : null,
    }));

    // Fallback to basic search if full-text search returns nothing
    const finalSegments = transcriptSegments.length > 0 ? formattedSegments : await prisma.transcriptSegment.findMany({
      where: {
        text: { contains: q, mode: 'insensitive' },
        meeting: meetingWhere,
      },
      include: {
        meeting: { select: { id: true, title: true, startTime: true } },
        speaker: { select: { label: true, displayName: true } },
      },
      orderBy: [
        { meeting: { startTime: 'desc' } },
        { tStartMs: 'asc' },
      ],
      take: parseInt(limit),
    });

    const transcriptResults = finalSegments.map(segment => {
      const matchIndex = segment.text.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, matchIndex - 50);
      const end = Math.min(segment.text.length, matchIndex + q.length + 50);
      const snippet = (start > 0 ? '...' : '') + segment.text.substring(start, end) + (end < segment.text.length ? '...' : '');

      return {
        type: 'transcript',
        meetingId: segment.meeting?.id || segment.meetingId,
        meetingTitle: segment.meeting?.title || '',
        meetingDate: segment.meeting?.startTime || '',
        segmentId: segment.id,
        speaker: segment.speaker?.displayName || segment.speaker?.label,
        tStartMs: (segment.tStartMs || '').toString(),
        tEndMs: (segment.tEndMs || '').toString(),
        text: segment.text,
        snippet,
      };
    });

    // Flattened results array (priority-ordered) for backward compat + AppShell dropdown
    const results = [...titleResults, ...summaryResults, ...transcriptResults];

    res.json({
      query: q,
      titleResults,
      summaryResults,
      transcriptResults,
      results,
      total: results.length,
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
