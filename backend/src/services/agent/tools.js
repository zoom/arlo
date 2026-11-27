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
 * `connector`: it acts outside the meeting through a connector
 * (services/connectors/), as one person who connected their own account:
 * the owner who typed the request, or the owner who pressed the approval.
 * `changesOutside`: it writes something there (a new GitHub issue). Such a
 * tool always needs the approval sheet.
 *
 * An argument is text within a length, or (`enum`) one of a fixed list of
 * names, which is how a reaction is given: a model never writes the emoji.
 *
 * An issue's number (`number` of open_issue) is rebuilt by lib/github.js: a
 * whole number from 1 to 9999999, or the same as plain digits, or the call is
 * refused. `share` is a boolean and nothing else. No tool takes a URL or a
 * repository: the one URL there is, is built by the server from the
 * deployment's GitHub repository and that number. Without a repository
 * (GITHUB_DEFAULT_REPO) the tool is not in the table.
 *
 * A timer's length (`minutes` of set_timer) is a whole number from 1 to 120:
 * a JSON integer, or the same written as plain digits ("5"), rebuilt as the
 * number. "5.5", "five" and anything else is refused.
 *
 * The three GitHub tools (github_list_issues, github_get_issue,
 * github_create_issue) are in the table only when "Connect GitHub" is
 * available on the deployment (the GitHub App's settings and the repository);
 * the table is the meeting's, not one person's, so whether someone is
 * connected is asked when a tool runs. Their arguments are checked by the
 * connector's own reader (readArgs, services/connectors/github.js): optional
 * ones may be left out, text is cleaned to plain text and refused when too
 * long, and a new issue's title and description must fit the approval sheet
 * together, which shows all of what is sent.
 *
 * This file has no code that runs a tool.
 */
const { showableName } = require('../../lib/displayName');
const { readGithubRepo, normalizeIssueNumber, MAX_ISSUE_NUMBER } = require('../../lib/github');
const { readArgs: readGithubArgs } = require('../connectors/github');
const {
  NOT_IN_TEXT, chatText, MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_ANSWER_CHARS, REACTION_NAMES, TIMER_MIN_MINUTES, TIMER_MAX_MINUTES, issueSheetBody,
} = require('./texts');

const text = (description, maxLength) => ({ type: 'string', description, maxLength });
// One of a fixed list of names: the model is told the list, and the server checks it again
const oneOf = (description, names) => ({ type: 'string', description, enum: [...names] });
// Yes or no: true or false and nothing else, never a word for one
const yesNo = (description) => ({ type: 'boolean', description });
// A whole number within limits, and nothing else
const whole = (description, minimum, maximum) => ({
  type: 'integer', description, minimum, maximum,
});
// `optional`: the names of the properties that may be left out
const parameters = (properties = {}, optional = []) => ({
  type: 'object', properties, required: Object.keys(properties).filter((key) => !optional.includes(key)), additionalProperties: false,
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
    description: 'Share Arlo\'s notes of this meeting with everyone in the meeting: they become visible in Arlo for people who have it open. Use when asked to share, send or show the notes. Not for opening the notes on everyone\'s screen.',
    parameters: parameters(),
    runs: 'server',
    changesMeeting: true,
  },
  {
    name: 'invite_everyone',
    // Two things in this order: the server shares the notes (as share_notes
    // does), then an owner's panel sends Zoom's invitation to open the app
    description: 'Share Arlo\'s notes with everyone and send everyone in the meeting an invitation to open Arlo. Use only when asked to invite people to Arlo or to the notes. Not for only sharing the notes, not for opening the notes for everyone, not for inviting someone to the meeting, and not for inviting one person.',
    parameters: parameters(),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'open_notes_for_everyone',
    // Two things in this order, like invite_everyone: the server shares the
    // notes, then the panel of the owner who agreed starts Zoom's Collaborate
    // mode, which opens Arlo for everyone in the meeting (and shows that
    // owner's Arlo view as a screen share to people without the app)
    description: 'Open Arlo\'s notes for everyone in the meeting as a shared document that everyone looks at together. Use when asked to open, put up, bring up or show the notes for everyone, for the whole meeting, or to look at the notes together. Not for only making the notes visible in Arlo (that is sharing the notes), and not for sending an invitation to open Arlo.',
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
    name: 'set_timer',
    // The panel of the owner who typed or approved it starts a countdown in
    // Zoom's Dynamic Indicator, which everyone in the meeting sees
    description: 'Start a countdown timer that everyone in the meeting sees. Use only when asked to set or start a timer, or to put an amount of time on the clock, and the asker says how long. Not when time is only talked about, and not for a reminder or an alarm at a time of day.',
    parameters: parameters({ minutes: whole('How long, in whole minutes, from 1 to 120, as the asker said it.', TIMER_MIN_MINUTES, TIMER_MAX_MINUTES) }),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'stop_timer',
    description: 'End the countdown timer that everyone in the meeting sees. Use only when asked to stop, cancel or end the timer.',
    parameters: parameters(),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'open_issue',
    // The panel of the owner who typed or approved it opens the issue in the
    // system browser and, when asked, Zoom's share dialog, where that owner
    // picks the window. Only with GITHUB_DEFAULT_REPO (listTools below)
    description: 'Open one issue that exists in the team\'s GitHub repository in the browser, by its number, and bring up screen sharing when that is asked too. Use only when asked to open, pull up or show an issue and the asker gives its number, like open issue 42, or pull up issue 42 and share it. Not when no number is given (to open an issue about something is creating a new issue), not for what an issue says, not for a link, a web page or another repository, and not when an issue is only talked about.',
    parameters: parameters({
      number: whole('The issue number as digits, from 1 to 9999999. A number that was spoken as words ("forty two") is given as digits (42). Never a link.', 1, MAX_ISSUE_NUMBER),
      share: yesNo('true only when the asker also asked to share it or to share the screen. Otherwise false.'),
    }),
    runs: 'panel',
    changesMeeting: true,
  },
  {
    name: 'github_list_issues',
    // The server asks GitHub, as the owner who typed it or agreed to it. What
    // comes back goes to that owner's panel and nowhere else
    description: 'List the open issues of the team\'s GitHub repository. Use when asked to show, list or look up the open issues, the bugs, or the issues about something or with a label. Not for opening one issue in the browser, not for what one numbered issue says, and not for creating an issue.',
    parameters: parameters({
      query: text('Words to look for in the issue titles, only when the asker gave some. Otherwise leave it out.', 100),
      label: text('One label name, only when the asker named a label. Otherwise leave it out.', 50),
    }, ['query', 'label']),
    runs: 'server',
    changesMeeting: false,
    connector: 'github',
  },
  {
    name: 'github_get_issue',
    description: 'Look up what one issue of the team\'s GitHub repository says, by its number. Use when asked what an issue is about, what it says, or for its status, like what is issue 42 about. Not for opening the issue in the browser or sharing it on screen (that is opening an issue).',
    parameters: parameters({
      number: whole('The issue number as digits, from 1 to 9999999. A number that was spoken as words ("forty two") is given as digits (42). Never a link.', 1, MAX_ISSUE_NUMBER),
    }),
    runs: 'server',
    changesMeeting: false,
    connector: 'github',
  },
  {
    name: 'github_create_issue',
    // Always after the approval sheet, which shows the title and the
    // description in full; created as the owner who agrees
    description: 'Create a new issue in the team\'s GitHub repository. Use when asked to create, file, log or open a new issue or a bug and the asker says what it is about, like open an issue: checkout fails on Safari, or file a bug for the login timeout. Not when the asker gives the number of an issue that exists (that is opening or looking up an issue), and not when a problem is only talked about.',
    parameters: parameters({
      title: text('A short title for the new issue, in the asker\'s own words. 3 to 200 characters.', 200),
      body: text('A description, only when the asker gave more than fits a title. At most 300 characters. Otherwise leave it out.', 300),
    }, ['body']),
    runs: 'server',
    changesMeeting: false,
    changesOutside: true,
    connector: 'github',
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
 * The deployment's GitHub repository (GITHUB_DEFAULT_REPO as config accepted
 * it, "owner/name"), or null. Read when asked, like web search.
 * `{ githubRepo }` overrides the setting (tests, the evaluation script): a
 * repository as config accepts one, anything else is none.
 */
function githubRepo(options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'githubRepo')) {
    const given = options.githubRepo;
    return typeof given === 'string' && readGithubRepo(given).repo === given ? given : null;
  }
  // eslint-disable-next-line global-require
  const configured = require('../../config').githubRepo;
  return typeof configured === 'string' && readGithubRepo(configured).repo === configured ? configured : null;
}

/**
 * Whether people can connect their own GitHub account on this deployment (the
 * GitHub App's settings and a repository, config.githubConnectAvailable). Read
 * when asked. `{ githubConnect }` overrides the setting (tests, the
 * evaluation script); without a repository there is none whatever it says.
 */
function githubConnectOn(options) {
  if (githubRepo(options) === null) return false;
  if (options && typeof options.githubConnect === 'boolean') return options.githubConnect;
  // An override of the repository alone (tests) says nothing about the app
  if (options && Object.prototype.hasOwnProperty.call(options, 'githubRepo')) return false;
  // eslint-disable-next-line global-require
  return require('../../config').githubConnectAvailable === true;
}

/**
 * The tools of this deployment, in the table's order. Frozen.
 * `{ webSearch, githubRepo, githubConnect }` override the settings (tests).
 */
function listTools(options) {
  const search = webSearchOn(options);
  const issues = githubRepo(options) !== null;
  const connect = githubConnectOn(options);
  return TABLE.filter((tool) => (tool.name !== 'web_search' || search) && (tool.name !== 'open_issue' || issues)
    && (tool.connector !== 'github' || connect));
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
  // An issue number is rebuilt, or it is not one (lib/github.js)
  if (key === 'number') return normalizeIssueNumber(value);
  if (property.type === 'integer') {
    // A whole number, or the same as plain digits; never rounded or read out of a word
    const number = typeof value === 'string' && /^[1-9][0-9]{0,2}$/.test(value) ? Number(value) : value;
    return Number.isInteger(number) && number >= property.minimum && number <= property.maximum ? number : null;
  }
  if (typeof value !== 'string') return null;
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
  if (tool.connector === 'github') {
    // The connector's own reader: the same check its call() makes again
    const read = readGithubArgs(tool.name, args);
    if (read === null) return { ok: false };
    // A new issue: the sheet shows the title and the description in full, or there is no call
    if (tool.name === 'github_create_issue' && issueSheetBody(read).length > MAX_CHAT_ANSWER_CHARS) return { ok: false };
    return { ok: true, args: read };
  }
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
  listTools, toolNames, getTool, validateToolCall, githubRepo, ALL_TOOL_NAMES, NO_TOOL_NAME, PANEL_TOOL_NAMES, HOST_TOOL_NAMES,
};
