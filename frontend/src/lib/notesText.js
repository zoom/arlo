/**
 * The notes as data and as plain text.
 *
 * Notes shape (from the server):
 *   { summary, decisions: string[], actionItems: [{ text, owner | null }], updatedAt, throughSeqNo }
 */

const isText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Notes from the server, rebuilt from the known fields. Anything else is
 * dropped. null when the value is not notes at all.
 */
export function cleanNotes(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.summary !== 'string') return null;
  const decisions = Array.isArray(value.decisions) ? value.decisions.filter(isText) : [];
  const actionItems = (Array.isArray(value.actionItems) ? value.actionItems : [])
    .filter((item) => item !== null && typeof item === 'object' && isText(item.text))
    .map((item) => ({ text: item.text, owner: isText(item.owner) ? item.owner : null }));
  return {
    summary: value.summary,
    decisions,
    actionItems,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    throughSeqNo: Number.isFinite(value.throughSeqNo) ? value.throughSeqNo : null,
  };
}

/** One action item as a line: "text · owner", or the text alone. */
export const actionItemText = (item) => (item.owner ? `${item.text} · ${item.owner}` : item.text);

/**
 * The notes as plain text, for copying: the title, then Summary, Decisions
 * and Action items. Sections with no entries are left out.
 */
export function notesToText(notes, { title } = {}) {
  const clean = cleanNotes(notes);
  if (!clean) return '';
  const blocks = [];
  if (isText(title)) blocks.push(title.trim());
  if (isText(clean.summary)) blocks.push(`Summary\n${clean.summary.trim()}`);
  if (clean.decisions.length > 0) {
    blocks.push(['Decisions', ...clean.decisions.map((decision) => `- ${decision}`)].join('\n'));
  }
  if (clean.actionItems.length > 0) {
    blocks.push(['Action items', ...clean.actionItems.map((item) => `- ${actionItemText(item)}`)].join('\n'));
  }
  return blocks.join('\n\n');
}
