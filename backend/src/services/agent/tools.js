/**
 * The only tools Arlo has: what a model may pick from when someone asks Arlo
 * for something, and the check every pick goes through.
 *
 * A model never decides what is allowed. It names one tool from this table and
 * gives arguments; validateToolCall() accepts the call only when the tool is
 * in the table and the arguments are exactly the ones listed, inside their
 * limits. A call that fails is refused, not repaired. Who may ask for a tool,
 * and whether an owner must approve it, is decided elsewhere from `runs` and
 * `changesMeeting`, never from anything the model says.
 *
 * `runs`: 'server' (the server does it from what it stored) or 'panel' (it
 * needs the Zoom Apps SDK, so an owner's open panel does it).
 * `changesMeeting`: whether people in the meeting see an effect.
 *
 * This file has no code that runs a tool.
 */
const { showableName } = require('../../lib/displayName');

const text = (description, maxLength) => ({ type: 'string', description, maxLength });
const parameters = (properties = {}) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const TABLE = deepFreeze([
  {
    name: 'answer_from_meeting',
    description: 'Answer a question about what was said or decided in this meeting, from its transcript. Use for a specific question about the meeting.',
    parameters: parameters({ question: text('The question, in the asker\'s own words.', 500) }),
    runs: 'server',
    changesMeeting: false,
  },
  {
    name: 'summarize_so_far',
    description: 'Summarize the meeting so far. Use when asked for a summary, a recap, or what someone missed.',
    parameters: parameters(),
    runs: 'server',
    changesMeeting: false,
  },
  {
    name: 'post_to_chat',
    description: 'Post a short message, given by the asker, to the meeting chat. Use only when asked to post, write, send or tell something in the chat. Not for sharing the notes.',
    parameters: parameters({ message: text('The message to post, as the asker gave it.', 1000) }),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'admit_from_waiting_room',
    description: 'Let one named person in from the waiting room. Use only when the asker names the person.',
    parameters: parameters({ name: text('The name of the person to admit, exactly as the asker said it.', 100) }),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'share_notes',
    description: 'Post Arlo\'s notes of this meeting to the meeting chat. Use when asked to share, send or post the notes.',
    parameters: parameters(),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'web_search',
    description: 'Look something up on the web. Use only for a question about the world outside this meeting.',
    parameters: parameters({ query: text('What to search for.', 200) }),
    runs: 'server',
    changesMeeting: false,
  },
]);

/** Every tool name there is, also the ones a deployment has turned off. */
const ALL_TOOL_NAMES = Object.freeze(TABLE.map((tool) => tool.name));

/** Whether this deployment has web search on (WEB_SEARCH_ENABLED=true). Read when asked: config needs the environment. */
function webSearchOn(options) {
  if (options && typeof options.webSearch === 'boolean') return options.webSearch;
  // eslint-disable-next-line global-require
  return require('../../config').webSearchEnabled === true;
}

/** The tools of this deployment, in the table's order. Frozen. `{ webSearch }` overrides the setting (tests). */
function listTools(options) {
  const search = webSearchOn(options);
  return TABLE.filter((tool) => tool.name !== 'web_search' || search);
}

const toolNames = (options) => listTools(options).map((tool) => tool.name);

/** One tool by name, or null: also for a name that is not a string or is turned off. */
function getTool(name, options) {
  if (typeof name !== 'string') return null;
  return listTools(options).find((tool) => tool.name === name) || null;
}

// Never part of an argument: control characters, invisible format characters
// (a direction override turns the text around it), private-use and unassigned
// characters, lone surrogates, line and paragraph separators. The joiners that
// names and emoji sequences need are allowed, as in lib/displayName.js.
const NOT_IN_TEXT = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;
// A chat message may have line breaks
const NOT_IN_A_MESSAGE = /(?![\u200C\u200D\n])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;

/** One argument, trimmed, or null when it is not allowed. */
function readArgument(key, value, maxLength) {
  if (typeof value !== 'string') return null;
  // A name is held to the rule for names shown to a meeting: a letter or digit in it
  const cleaned = key === 'name' ? showableName(value) : value.normalize('NFC').trim();
  if (cleaned.length === 0 || cleaned.length > maxLength) return null;
  if ((key === 'message' ? NOT_IN_A_MESSAGE : NOT_IN_TEXT).test(cleaned)) return null;
  return cleaned;
}

/**
 * Check a tool call a model (or anything else untrusted) made.
 * -> { ok: true, args } with the arguments rebuilt from the table, or { ok: false }.
 */
function validateToolCall(name, args, options) {
  const tool = getTool(name, options);
  if (!tool || args === null || typeof args !== 'object' || Array.isArray(args)) return { ok: false };
  const known = Object.keys(tool.parameters.properties);
  const given = Object.keys(args);
  if (given.length !== known.length || !given.every((key) => known.includes(key))) return { ok: false };
  const clean = {};
  for (const key of known) {
    const value = readArgument(key, args[key], tool.parameters.properties[key].maxLength);
    if (value === null) return { ok: false };
    clean[key] = value;
  }
  return { ok: true, args: clean };
}

module.exports = {
  listTools, toolNames, getTool, validateToolCall, ALL_TOOL_NAMES,
};
