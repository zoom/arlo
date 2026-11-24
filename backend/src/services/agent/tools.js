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
 * `needsHost`: the panel that runs it must be a host's or co-host's.
 *
 * An argument is text within a length, or (`enum`) one of a fixed list of
 * names, which is how a reaction is given: a model never writes the emoji.
 *
 * A ticket's key (`key` of open_ticket) is rebuilt by lib/jira.js: letters, a
 * dash, a number, or the call is refused. `share` is a boolean and nothing
 * else. No tool takes a URL: the one URL there is, is built by the server from
 * the deployment's Jira base URL and that key. Without a base URL
 * (JIRA_BASE_URL) the tool is not in the table.
 *
 * This file has no code that runs a tool.
 */
const { showableName } = require('../../lib/displayName');
const { readJiraBaseUrl, normalizeTicketKey } = require('../../lib/jira');
const {
  NOT_IN_TEXT, chatText, MAX_CHAT_MESSAGE_CHARS, REACTION_NAMES,
} = require('./texts');

const text = (description, maxLength) => ({ type: 'string', description, maxLength });
// One of a fixed list of names: the model is told the list, and the server checks it again
const oneOf = (description, names) => ({ type: 'string', description, enum: [...names] });
// Yes or no: true or false and nothing else, never a word for one
const yesNo = (description) => ({ type: 'boolean', description });
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
    // 300: the approval sheet shows the whole message as its body, so what an
    // owner approves is what is posted
    parameters: parameters({ message: text('The message to post, as the asker gave it. At most 300 characters.', MAX_CHAT_MESSAGE_CHARS) }),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'admit_from_waiting_room',
    description: 'Let one named person in from the waiting room. Use only when the asker names the person.',
    parameters: parameters({ name: text('The name of the person to admit, exactly as the asker said it.', 100) }),
    runs: 'panel',
    changesMeeting: true,
    needsHost: true,
  },
  {
    name: 'share_notes',
    // Turns "notes shared with everyone" on (the same switch as the owner's
    // setting): the server does it, no panel is needed
    description: 'Share Arlo\'s notes of this meeting with everyone in the meeting. Use when asked to share, send or show the notes.',
    parameters: parameters(),
    runs: 'server',
    changesMeeting: true,
  },
  {
    name: 'invite_everyone',
    // Two things in this order: the server shares the notes (as share_notes
    // does), then an owner's panel sends Zoom's invitation to open the app
    description: 'Share Arlo\'s notes with everyone and send everyone in the meeting an invitation to open Arlo. Use only when asked to invite people to Arlo or to the notes. Not for only sharing the notes, not for inviting someone to the meeting, and not for inviting one person.',
    parameters: parameters(),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'send_reaction',
    description: 'Send one emoji reaction in the meeting. Use only when asked to react, or for a thumbs up, applause, a heart, a laugh, a celebration or a wow. Not for posting text in the chat, not for raising a hand, and not when someone only says they like something.',
    parameters: parameters({ reaction: oneOf('Which reaction: thumbs_up, clap (applause), heart (love), joy (laughing), tada (celebration), open_mouth (wow, surprise).', REACTION_NAMES) }),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'mute_participant',
    description: 'Mute one named person in the meeting. Use only when asked to mute and the asker names the person. It mutes only: it can never unmute anyone, so do not use it when asked to unmute. One person at a time: not for muting everyone.',
    parameters: parameters({ name: text('The name of the person to mute, exactly as the asker said it.', 100) }),
    runs: 'panel',
    changesMeeting: true,
    needsHost: true,
  },
  {
    name: 'open_ticket',
    // The panel of the owner who typed or approved it opens the ticket in the
    // system browser and, when asked, Zoom's share dialog, where that owner
    // picks the window. Only with JIRA_BASE_URL (listTools below)
    description: 'Open one ticket of the issue tracker in the browser, and bring up screen sharing when that is asked too. Use only when asked to open, pull up or show a ticket or issue and the asker gives its key, like PROJ-123. Not when no key is given, not for a link or a web page, and not when a ticket is only talked about.',
    parameters: parameters({
      key: text('The ticket key as the asker gave it: letters, a dash, a number, like PROJ-123. Never a link.', 40),
      share: yesNo('true only when the asker also asked to share it or to share the screen. Otherwise false.'),
    }),
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
/** What a request is recorded under when no tool was found for it. Never a tool. */
const NO_TOOL_NAME = 'none';
/** The tools an owner's open panel does with the Zoom Apps SDK. */
const PANEL_TOOL_NAMES = Object.freeze(TABLE.filter((tool) => tool.runs === 'panel').map((tool) => tool.name));

/** The panel tools only a host's or co-host's panel may run. */
const HOST_TOOL_NAMES = Object.freeze(TABLE.filter((tool) => tool.runs === 'panel' && tool.needsHost === true).map((tool) => tool.name));

/** Whether this deployment has web search on (WEB_SEARCH_ENABLED=true). Read when asked: config needs the environment. */
function webSearchOn(options) {
  if (options && typeof options.webSearch === 'boolean') return options.webSearch;
  // eslint-disable-next-line global-require
  return require('../../config').webSearchEnabled === true;
}

/**
 * The deployment's Jira base URL (JIRA_BASE_URL as config accepted it), or
 * null. Read when asked, like web search. `{ jiraBaseUrl }` overrides the
 * setting (tests, the evaluation script): a base URL in the form config keeps
 * it in, anything else is none.
 */
function jiraBaseUrl(options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'jiraBaseUrl')) {
    const given = options.jiraBaseUrl;
    return typeof given === 'string' && readJiraBaseUrl(given).url === given ? given : null;
  }
  // eslint-disable-next-line global-require
  const configured = require('../../config').jiraBaseUrl;
  return typeof configured === 'string' && configured.length > 0 ? configured : null;
}

/**
 * The tools of this deployment, in the table's order. Frozen.
 * `{ webSearch, jiraBaseUrl }` override the settings (tests).
 */
function listTools(options) {
  const search = webSearchOn(options);
  const tickets = jiraBaseUrl(options) !== null;
  return TABLE.filter((tool) => (tool.name !== 'web_search' || search) && (tool.name !== 'open_ticket' || tickets));
}

const toolNames = (options) => listTools(options).map((tool) => tool.name);

/** One tool by name, or null: also for a name that is not a string or is turned off. */
function getTool(name, options) {
  if (typeof name !== 'string') return null;
  return listTools(options).find((tool) => tool.name === name) || null;
}

// Never part of an argument: NOT_IN_TEXT (services/agent/texts.js). A chat
// message may be given with line breaks; they become spaces (chatText).
const NOT_IN_A_MESSAGE = new RegExp(NOT_IN_TEXT.source.replace('\\u200D', '\\u200D\\n\\r\\t'), 'u');

// No name of a list is longer; anything longer is not looked at
const MAX_ENUM_VALUE_CHARS = 40;

/** One argument, trimmed, or null when it is not allowed. `property`: its entry in the tool's parameters. */
function readArgument(key, value, property) {
  // true or false as such: "true", 1 or "yes" is refused, never read as one
  if (property.type === 'boolean') return typeof value === 'boolean' ? value : null;
  if (typeof value !== 'string') return null;
  // A ticket key is rebuilt, or it is not one (lib/jira.js)
  if (key === 'key') return value.length <= property.maxLength ? normalizeTicketKey(value) : null;
  if (Array.isArray(property.enum)) {
    // One of the listed names, as listed: anything else is refused, never mapped to one
    if (value.length > MAX_ENUM_VALUE_CHARS) return null;
    const name = value.trim();
    return property.enum.includes(name) ? name : null;
  }
  const { maxLength } = property;
  // A name is held to the rule for names shown to a meeting: a letter or digit in it
  const cleaned = key === 'name' ? showableName(value) : value.normalize('NFC').trim();
  if (cleaned.length === 0 || cleaned.length > maxLength) return null;
  if ((key === 'message' ? NOT_IN_A_MESSAGE : NOT_IN_TEXT).test(cleaned)) return null;
  // A chat message is what will be posted: one line, without an "Arlo:" of
  // its own, and refused when nothing is left of it
  return key === 'message' ? chatText(cleaned, maxLength) : cleaned;
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
    const value = readArgument(key, args[key], tool.parameters.properties[key]);
    if (value === null) return { ok: false };
    clean[key] = value;
  }
  return { ok: true, args: clean };
}

module.exports = {
  listTools, toolNames, getTool, validateToolCall, jiraBaseUrl, ALL_TOOL_NAMES, NO_TOOL_NAME, PANEL_TOOL_NAMES, HOST_TOOL_NAMES,
};
