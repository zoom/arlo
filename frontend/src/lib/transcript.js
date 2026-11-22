/**
 * Transcript segment helpers.
 *
 * A segment from the server: { seqNo, text, speakerId, speakerLabel, tStartMs, tEndMs }.
 * `seqNo` restarts at 1 for every RTMS stream (after Stop → Start, or a server
 * restart), so it does not identify a segment on its own.
 */

/** Identity of a segment within one meeting. */
export function segmentKey(segment) {
  return `${segment.seqNo}|${segment.tStartMs}|${segment.speakerId ?? segment.speakerLabel ?? ''}`;
}

const isSegment = (segment) => (
  segment !== null && typeof segment === 'object' && segment.seqNo !== undefined && typeof segment.text === 'string'
);

/** Append a live segment unless the same one is already in the list. */
export function addSegment(segments, segment) {
  if (!isSegment(segment)) return segments;
  const key = segmentKey(segment);
  return segments.some((existing) => segmentKey(existing) === key) ? segments : [...segments, segment];
}

/** Stored segments first, then live segments that are not among them. */
export function mergeHistory(stored, live) {
  const storedKeys = new Set(stored.map(segmentKey));
  return [...stored, ...live.filter((segment) => !storedKeys.has(segmentKey(segment)))];
}

/** "Speaker: text" lines, the form the AI endpoints expect. */
export function transcriptToText(segments) {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((segment) => `${segment.speakerLabel || segment.speakerName || 'Unknown'}: ${segment.text}`)
    .join('\n');
}
