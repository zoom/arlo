// Who Zoom's Apps SDK says this user is in the meeting, as the owner's panel
// reports it to the server once per meeting. A measurement: the server counts
// how often a transcript line's speaker equals one of these, and keeps counts
// only (backend routes/arlo.js POST /identity).

const FIELDS = ['participantUUID', 'participantId', 'screenName'];
const MAX_CHARS = 200;
// C0 and C1 control characters and DEL
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The report for what `getUserContext()` answered: the known fields that are
 * usable (a string, or a number, of 1 to 200 characters without control
 * characters, trimmed), or null when none is. A field that is not usable is
 * left out, never cut: a cut id would be another id.
 */
export function identityReport(userContext) {
  if (userContext === null || typeof userContext !== 'object') return null;
  const report = {};
  for (const field of FIELDS) {
    const raw = userContext[field];
    const value = (typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw);
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_CHARS || CONTROL_CHARS.test(value)) continue;
    report[field] = trimmed;
  }
  return Object.keys(report).length > 0 ? report : null;
}
