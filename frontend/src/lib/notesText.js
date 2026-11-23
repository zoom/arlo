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

/** The sections that have entries, in order: [{ heading, lines }]. */
function noteSections(clean) {
  const sections = [];
  if (isText(clean.summary)) sections.push({ heading: 'Summary', lines: clean.summary.trim().split('\n') });
  if (clean.decisions.length > 0) {
    sections.push({ heading: 'Decisions', lines: clean.decisions.map((decision) => `- ${decision}`) });
  }
  if (clean.actionItems.length > 0) {
    sections.push({ heading: 'Action items', lines: clean.actionItems.map((item) => `- ${actionItemText(item)}`) });
  }
  return sections;
}

/**
 * The notes as plain text, for copying: the title, then Summary, Decisions
 * and Action items. Sections with no entries are left out.
 */
export function notesToText(notes, { title } = {}) {
  const clean = cleanNotes(notes);
  if (!clean) return '';
  const blocks = noteSections(clean).map(({ heading, lines }) => [heading, ...lines].join('\n'));
  if (isText(title)) blocks.unshift(title.trim());
  return blocks.join('\n\n');
}

/** The longest message posted to the Zoom meeting chat, in characters. */
export const CHAT_MESSAGE_MAX_CHARS = 4000;
const CHAT_TITLE = 'Notes from Arlo';
const SHORTENED = '… (shortened)';

/** `text` cut to `room` characters: at a word when there is one, never inside a character pair. */
function cutLine(text, room) {
  if (room <= 0) return '';
  let cut = text.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0 && text[room] !== ' ') cut = cut.slice(0, lastSpace);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/**
 * The notes as one message for the meeting chat: "Notes from Arlo", then the
 * sections as notesToText writes them. '' when there is nothing to post.
 *
 * Never longer than CHAT_MESSAGE_MAX_CHARS. A longer text is cut after the
 * last whole line of notes that fits and ends with "… (shortened)". Only when
 * not even the first line of the notes fits is that line itself cut.
 */
export function notesToChatMessage(notes) {
  const clean = cleanNotes(notes);
  const sections = clean ? noteSections(clean) : [];
  if (sections.length === 0) return '';

  // `content`: a line of the notes, not the title, a heading or the gap before one
  const entries = [{ text: CHAT_TITLE, content: false }];
  sections.forEach(({ heading, lines }) => {
    entries.push({ text: '', content: false }, { text: heading, content: false });
    lines.forEach((text) => entries.push({ text, content: text.trim().length > 0 }));
  });
  const full = entries.map((entry) => entry.text).join('\n');
  if (full.length <= CHAT_MESSAGE_MAX_CHARS) return full;

  // Room for the lines, with the closing line and its line break taken off
  const budget = CHAT_MESSAGE_MAX_CHARS - SHORTENED.length - 1;
  const kept = [];
  let length = 0;
  for (const entry of entries) {
    const added = entry.text.length + (kept.length > 0 ? 1 : 0);
    if (length + added > budget) break;
    kept.push(entry);
    length += added;
  }
  // Not a gap or a heading with nothing under it at the end
  while (kept.length > 0 && !kept[kept.length - 1].content) kept.pop();

  let lines = kept.map((entry) => entry.text);
  if (lines.length === 0) {
    // Title, gap, the first heading, and as much of its first line as fits
    const head = entries.slice(0, 3).map((entry) => entry.text);
    const first = cutLine(entries[3].text, budget - head.join('\n').length - 1);
    lines = first ? [...head, first] : [CHAT_TITLE];
  }
  return [...lines, SHORTENED].join('\n');
}
