/**
 * Stored transcript segments as lines of model input: "<speaker>: <text>", one
 * line per segment, oldest first.
 *
 * What was said and who said it are untrusted text. Line breaks inside either
 * are folded into spaces, so one segment is always exactly one line and
 * cannot pass itself off as several. When the lines are longer than
 * `maxChars` together (line breaks counted), the newest are kept; a single
 * line over the limit is cut, not skipped.
 */
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function newestLines(segments, maxChars) {
  const lines = [];
  let used = 0;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const room = maxChars - used - (lines.length > 0 ? 1 : 0); // 1 = the line break
    let line = `${oneLine(segments[i].speakerLabel)}: ${oneLine(segments[i].text)}`;
    if (line.length > room) {
      if (lines.length > 0) break;
      line = line.slice(0, Math.max(room, 0));
    }
    used += line.length + (lines.length > 0 ? 1 : 0);
    lines.unshift(line);
  }
  return { lines };
}

module.exports = { newestLines };
