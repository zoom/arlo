/**
 * The name of the person who brought Arlo in, and the sentences that use it.
 *
 * The server can have no name for them (sign-in without the Zoom scope that
 * gives names). A missing or blank name is "no name" everywhere, decided here
 * once, so no sentence is ever shown with a gap where the name should be.
 */
const MAX_NAME_CHARS = 200;

/** The name trimmed and bounded, or null when there is none (not a string, or blank). */
export function usableName(value, max = MAX_NAME_CHARS) {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, max).trim();
  return name.length > 0 ? name : null;
}

/** What a participant reads about whose Arlo this is: { heading, body, askLine }. */
export function ownerWording(ownerName) {
  const name = usableName(ownerName);
  if (name === null) {
    return {
      heading: 'Arlo is in this meeting',
      body: 'Arlo reads Zoom\'s live transcript to take notes for the person who brought it in. Nothing is stored after the meeting ends.',
      askLine: 'Only the person who brought Arlo in can ask in this meeting.',
    };
  }
  return {
    heading: `${name} brought Arlo into this meeting`,
    body: `Arlo reads Zoom's live transcript to take notes for ${name}. Nothing is stored after the meeting ends.`,
    askLine: `Only ${name} can ask Arlo in this meeting.`,
  };
}
