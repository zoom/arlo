/**
 * The GitHub connector: three tools of Arlo's own, each backed by one tool of
 * GitHub's MCP server, all in the deployment's one repository.
 *
 *   github_list_issues   { query?, label? }  -> list_issues   (read)
 *   github_get_issue     { number }          -> issue_read    (read)
 *   github_create_issue  { title, body? }    -> issue_write   (write)
 *
 * The rules:
 * - The repository is always `defaultRepo`. No argument names another one,
 *   so a model or a speaker cannot reach one.
 * - Arlo builds every argument that is sent. Nothing else of the server's
 *   tool list can be called through here.
 * - The server's tools are checked before any is used (`start()`): the tool
 *   must be listed and its input schema must have every parameter Arlo sends,
 *   with the type Arlo sends. A tool that is missing or shaped differently
 *   means that Arlo tool is not offered, with one warning that names the tool.
 * - What the server answers is untrusted text (an issue title can read
 *   "ignore your instructions"). It is parsed, and a result is rebuilt from
 *   the known fields: numbers checked, strings stripped of control and
 *   invisible characters and cut, lists cut. Nothing is interpreted. The URL
 *   of an issue is never the server's: it is built here from the repository
 *   and the number; an item whose own URL is not under
 *   https://github.com/<repo>/issues/ is dropped.
 * - `call()` never throws: { ok: true, result } or { ok: false, code }.
 * - Nothing of an issue (title, body, label) and nothing of a request is
 *   logged here. The token is not known here at all: it is in the client.
 *
 * The MCP tool names, parameters and result shapes below are from GitHub's
 * documentation and source (github/github-mcp-server, README and
 * pkg/github/issues.go, read 2026-11-26), not yet observed against the
 * hosted server. `node scripts/connector-check.js` prints what it really has.
 */

const {
  readGithubRepo, normalizeIssueNumber, isIssueNumber, issueUrl,
} = require('../../lib/github');

const TOOL_NAMES = Object.freeze(['github_list_issues', 'github_get_issue', 'github_create_issue']);

const MAX_ISSUES = 10;
const MAX_LABELS = 5;
const MAX_TITLE_CHARS = 200;
const MIN_TITLE_CHARS = 3;
const MAX_BODY_SHOWN_CHARS = 1000;
const MAX_BODY_SENT_CHARS = 4000;
const MAX_QUERY_CHARS = 100;
const MAX_LABEL_CHARS = 50;
// How many issues a text filter looks through: the most recently updated open
// ones, one page. With the `fields` parameter the answer is small enough for a
// full page; without it the bodies come along, so fewer are asked for
const SEARCHED_WITH_FIELDS = 100;
const SEARCHED_WITHOUT_FIELDS = 30;
// The parts of an issue Arlo reads from a list (names of list_issues' `fields`)
const LIST_FIELDS = Object.freeze(['number', 'title', 'labels', 'updated_at']);

const CREATED_BY_ARLO = 'Opened by Arlo during a Zoom meeting at the request of a meeting participant.';

// What Arlo sends to each MCP tool: the parameter and the JSON type of the
// value. `values` are sent as they are, so an enum in the schema must have
// them. `sometimes`: not sent with every call, so the tool must not require it
const NEEDS = Object.freeze({
  github_list_issues: {
    tool: 'list_issues',
    params: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      state: { type: 'string', values: ['OPEN'] },
      labels: { type: 'array', sometimes: true },
      orderBy: { type: 'string', values: ['UPDATED_AT'] },
      direction: { type: 'string', values: ['DESC'] },
      perPage: { type: 'number' },
    },
  },
  github_get_issue: {
    tool: 'issue_read',
    params: {
      method: { type: 'string', values: ['get'] },
      owner: { type: 'string' },
      repo: { type: 'string' },
      issue_number: { type: 'number' },
    },
  },
  github_create_issue: {
    tool: 'issue_write',
    params: {
      method: { type: 'string', values: ['create'] },
      owner: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
  },
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Control characters, invisible format characters, private use, unassigned,
// lone surrogates, line and paragraph separators
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;
const UNSHOWN_BUT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;
// A time as GitHub writes one: 2026-11-26T10:00:00Z
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The first `max` characters, never half of a pair. */
const cut = (text, max) => (text.length <= max ? text : Array.from(text).slice(0, max).join(''));

/** One line of plain text of at most `max` characters, or null when `value` is not text. */
function line(value, max) {
  if (typeof value !== 'string') return null;
  return cut(value.replace(/[\r\n\t\p{Zl}\p{Zp}]/gu, ' ').replace(UNSHOWN, '').replace(/\s+/gu, ' ').trim(), max);
}

/** Text of several lines, of at most `max` characters, or null when `value` is not text. */
function lines(value, max) {
  if (typeof value !== 'string') return null;
  return cut(value.replace(/\r\n?|[\p{Zl}\p{Zp}]/gu, '\n').replace(/\t/g, ' ').replace(UNSHOWN_BUT_NEWLINE, '').replace(/\n{3,}/g, '\n\n').trim(), max);
}

// --- the server's tools ----------------------------------------------------------------

/** The JSON types a schema property takes, as a list; [] when it does not say. */
function typesOf(property) {
  if (!isPlainObject(property)) return [];
  const { type } = property;
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((one) => typeof one === 'string');
  return [];
}

const takes = (property, type) => {
  const types = typesOf(property);
  return type === 'number' ? types.includes('number') || types.includes('integer') : types.includes(type);
};

/**
 * Whether one MCP tool is what an Arlo tool needs: 'ok', 'missing' (not in
 * the list) or 'shape' (a parameter Arlo sends is not in its input schema,
 * takes another type or does not allow the value, or the tool requires a
 * parameter Arlo does not send).
 */
function fits(need, tools) {
  const tool = tools.find((one) => isPlainObject(one) && one.name === need.tool);
  if (!tool) return 'missing';
  const schema = tool.inputSchema;
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return 'shape';
  for (const [name, { type, values }] of Object.entries(need.params)) {
    if (!own(schema.properties, name)) return 'shape';
    const property = schema.properties[name];
    if (!takes(property, type)) return 'shape';
    if (values && Array.isArray(property.enum) && !values.every((value) => property.enum.includes(value))) return 'shape';
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) return 'shape';
    if (!schema.required.every((name) => typeof name === 'string' && own(need.params, name) && !need.params[name].sometimes)) return 'shape';
  }
  return 'ok';
}

/** Whether list_issues takes `fields` with every part Arlo reads. */
function takesListFields(tools) {
  const tool = tools.find((one) => isPlainObject(one) && one.name === NEEDS.github_list_issues.tool);
  const property = tool && isPlainObject(tool.inputSchema) && isPlainObject(tool.inputSchema.properties) ? tool.inputSchema.properties.fields : null;
  if (!takes(property, 'array') || !isPlainObject(property.items) || !takes(property.items, 'string')) return false;
  const allowed = property.items.enum;
  return !Array.isArray(allowed) || LIST_FIELDS.every((field) => allowed.includes(field));
}

/**
 * What the server's tool list means for Arlo's three tools:
 * { github_list_issues: { offered, mcpTool, reason?: 'missing' | 'shape' }, …, listFields: boolean }.
 */
function checkTools(tools) {
  const listed = Array.isArray(tools) ? tools : [];
  const checked = {};
  for (const name of TOOL_NAMES) {
    const need = NEEDS[name];
    const verdict = fits(need, listed);
    checked[name] = verdict === 'ok' ? { offered: true, mcpTool: need.tool } : { offered: false, mcpTool: need.tool, reason: verdict };
  }
  checked.listFields = checked.github_list_issues.offered && takesListFields(listed);
  return checked;
}

// --- Arlo's arguments ------------------------------------------------------------------

const onlyKeys = (args, keys) => isPlainObject(args) && Object.keys(args).every((key) => keys.includes(key));
const absent = (value) => value === undefined || value === null || value === '';

/** An optional one-line text of 1 to `max` characters: { ok, value } where value is null when it is not given. */
function optionalLine(value, max) {
  if (absent(value)) return { ok: true, value: null };
  if (typeof value !== 'string' || value.length > max * 4) return { ok: false };
  const read = line(value, max + 1);
  if (read.length > max) return { ok: false };
  return { ok: true, value: read === '' ? null : read };
}

/** Arlo's arguments for a tool as they are used, or null: never repaired beyond cleaning. */
function readArgs(name, args) {
  if (name === 'github_list_issues') {
    if (!onlyKeys(args, ['query', 'label'])) return null;
    const query = optionalLine(args.query, MAX_QUERY_CHARS);
    const label = optionalLine(args.label, MAX_LABEL_CHARS);
    return query.ok && label.ok ? { query: query.value, label: label.value } : null;
  }
  if (name === 'github_get_issue') {
    if (!onlyKeys(args, ['number'])) return null;
    const number = normalizeIssueNumber(args.number);
    return number === null ? null : { number };
  }
  if (name === 'github_create_issue') {
    if (!onlyKeys(args, ['title', 'body'])) return null;
    if (typeof args.title !== 'string' || args.title.length > MAX_TITLE_CHARS * 4) return null;
    const title = line(args.title, MAX_TITLE_CHARS + 1);
    if (title.length < MIN_TITLE_CHARS || title.length > MAX_TITLE_CHARS) return null;
    let body = null;
    if (!absent(args.body)) {
      if (typeof args.body !== 'string' || args.body.length > MAX_BODY_SENT_CHARS * 4) return null;
      const read = lines(args.body, MAX_BODY_SENT_CHARS + 1);
      if (read.length > MAX_BODY_SENT_CHARS) return null;
      body = read === '' ? null : read;
    }
    return { title, body };
  }
  return null;
}

// --- the server's answers --------------------------------------------------------------

class BadResponse extends Error {}

/** The JSON object in a tool's answer, or a BadResponse. */
function parsed(answer) {
  if (!isPlainObject(answer) || !Array.isArray(answer.texts) || typeof answer.texts[0] !== 'string') throw new BadResponse();
  let value;
  try {
    value = JSON.parse(answer.texts[0]);
  } catch {
    throw new BadResponse();
  }
  if (!isPlainObject(value)) throw new BadResponse();
  return value;
}

/** At most five label names from what an issue has as its labels. */
function labelsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const labels = [];
  for (const one of raw.slice(0, 100)) {
    const name = line(isPlainObject(one) ? one.name : one, MAX_LABEL_CHARS);
    if (name) labels.push(name);
    if (labels.length === MAX_LABELS) break;
  }
  return labels;
}

/**
 * One issue rebuilt from what the server gave, or null when it cannot be
 * used: { number, title, url, labels, updatedAt }. The url is built here.
 */
function issueFrom(raw, repo) {
  if (!isPlainObject(raw) || !isIssueNumber(raw.number)) return null;
  const title = line(raw.title, MAX_TITLE_CHARS);
  if (!title) return null;
  const prefix = `https://github.com/${repo}/issues/`;
  // The server's own link, when it gives one, must be an issue of this repository
  if (raw.html_url !== undefined && (typeof raw.html_url !== 'string' || !raw.html_url.startsWith(prefix))) return null;
  const url = issueUrl(repo, raw.number);
  if (!url || !url.startsWith(prefix)) return null;
  return {
    number: raw.number,
    title,
    url,
    labels: labelsOf(raw.labels),
    updatedAt: typeof raw.updated_at === 'string' && TIMESTAMP.test(raw.updated_at) ? raw.updated_at : null,
  };
}

// --- the connector ---------------------------------------------------------------------

/**
 * @param client      an MCP client as createMcpClient() returns one
 * @param defaultRepo "owner/name", the one repository every tool works in
 * @param warn        where the one warning per tool that is not offered goes
 */
function createGithubConnector({ client, defaultRepo, warn = console.warn } = {}) {
  if (!client || typeof client.listTools !== 'function' || typeof client.callTool !== 'function') throw new TypeError('GitHub connector: an MCP client is required');
  if (readGithubRepo(defaultRepo).repo !== defaultRepo || !defaultRepo) throw new TypeError('GitHub connector: the repository must be written as owner/name');
  const [owner, repo] = defaultRepo.split('/');

  let checked = null; // what checkTools() said, once the server's list was read
  let starting = null;
  const warned = new Set();

  function warnOnce(key, sentence) {
    if (warned.has(key)) return;
    warned.add(key);
    warn(sentence);
  }

  async function check() {
    let tools;
    try {
      tools = await client.listTools();
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'unreachable';
      warnOnce(`list:${code}`, `GitHub connector: could not read the MCP server's tool list (${code}); no GitHub tool is offered.`);
      return { ok: false, code };
    }
    checked = checkTools(tools);
    for (const name of TOOL_NAMES) {
      if (checked[name].offered) continue;
      const why = checked[name].reason === 'missing' ? 'is not in the MCP server\'s tool list' : 'has other parameters than expected';
      warnOnce(`tool:${name}`, `GitHub connector: ${name} is not offered: the tool ${checked[name].mcpTool} ${why}.`);
    }
    return { ok: true };
  }

  /**
   * Reads the server's tool list and decides which of Arlo's tools are
   * offered: { ok: true, offered: [names] } or { ok: false, code, offered: [] }.
   * Never throws. Once the list was read it is not read again.
   */
  async function start() {
    if (!checked) {
      if (!starting) starting = check().finally(() => { starting = null; });
      const outcome = await starting;
      if (!outcome.ok) return { ok: false, code: outcome.code, offered: [] };
    }
    return { ok: true, offered: offeredTools() };
  }

  /** The names of Arlo's tools that can be used; [] before start() has read the server's list. */
  function offeredTools() {
    return checked ? TOOL_NAMES.filter((name) => checked[name].offered) : [];
  }

  async function listIssues({ query, label }) {
    const searched = checked.listFields ? SEARCHED_WITH_FIELDS : SEARCHED_WITHOUT_FIELDS;
    const sent = {
      owner, repo, state: 'OPEN', orderBy: 'UPDATED_AT', direction: 'DESC', perPage: query ? searched : MAX_ISSUES,
    };
    if (label) sent.labels = [label];
    if (checked.listFields) sent.fields = [...LIST_FIELDS];
    const answer = await client.callTool(NEEDS.github_list_issues.tool, sent);
    if (answer.isError) return { ok: false, code: 'tool_error' };
    const data = parsed(answer);
    if (!Array.isArray(data.issues)) throw new BadResponse();

    let issues = [];
    const seen = new Set();
    for (const raw of data.issues.slice(0, SEARCHED_WITH_FIELDS)) {
      const issue = issueFrom(raw, defaultRepo);
      if (!issue || seen.has(issue.number)) continue;
      seen.add(issue.number);
      issues.push(issue);
    }
    let total;
    if (query) {
      // The MCP tool has no text filter: the titles of the page that was read
      // are compared here, without regard to case
      const wanted = query.toLowerCase();
      issues = issues.filter((issue) => issue.title.toLowerCase().includes(wanted));
      total = issues.length;
    } else {
      total = Number.isSafeInteger(data.totalCount) && data.totalCount >= issues.length ? data.totalCount : issues.length;
    }
    return { ok: true, result: { repo: defaultRepo, total, issues: issues.slice(0, MAX_ISSUES) } };
  }

  async function getIssue({ number }) {
    const answer = await client.callTool(NEEDS.github_get_issue.tool, {
      method: 'get', owner, repo, issue_number: number,
    });
    if (answer.isError) return { ok: false, code: 'tool_error' };
    const data = parsed(answer);
    const issue = issueFrom(data, defaultRepo);
    // An answer about another issue than the one asked for is no answer
    if (!issue || issue.number !== number) throw new BadResponse();
    const state = typeof data.state === 'string' ? data.state.toLowerCase() : null;
    return {
      ok: true,
      result: {
        repo: defaultRepo,
        issue: {
          ...issue,
          state: state === 'open' || state === 'closed' ? state : null,
          body: lines(data.body, MAX_BODY_SHOWN_CHARS) || '',
        },
      },
    };
  }

  async function createIssue({ title, body }) {
    const answer = await client.callTool(NEEDS.github_create_issue.tool, {
      method: 'create', owner, repo, title, body: body ? `${body}\n\n${CREATED_BY_ARLO}` : CREATED_BY_ARLO,
      // A write is not sent a second time once it may have arrived
    }, { retry: false });
    if (answer.isError) return { ok: false, code: 'tool_error' };
    const data = parsed(answer);
    const prefix = `https://github.com/${defaultRepo}/issues/`;
    if (typeof data.url !== 'string' || !data.url.startsWith(prefix)) throw new BadResponse();
    const number = normalizeIssueNumber(data.url.slice(prefix.length));
    const url = number === null ? null : issueUrl(defaultRepo, number);
    if (!url) throw new BadResponse();
    return { ok: true, result: { number, title, url } };
  }

  const RUN = { github_list_issues: listIssues, github_get_issue: getIssue, github_create_issue: createIssue };

  /**
   * Runs one of Arlo's tools: { ok: true, result } or { ok: false, code }.
   * Codes: invalid_args (nothing was sent), not_offered, tool_error (the
   * server's tool said it failed: no such issue, no permission), and the
   * client's unreachable, unauthorized, timeout, bad_response. After
   * github_create_issue, timeout, unreachable and bad_response do not say
   * that no issue was created.
   */
  async function call(name, args) {
    try {
      if (!TOOL_NAMES.includes(name)) return { ok: false, code: 'not_offered' };
      const read = readArgs(name, args);
      if (!read) return { ok: false, code: 'invalid_args' };
      const started = await start();
      if (!started.ok) return { ok: false, code: started.code };
      if (!checked[name].offered) return { ok: false, code: 'not_offered' };
      return await RUN[name](read);
    } catch (error) {
      const code = error && !(error instanceof BadResponse) && typeof error.code === 'string' ? error.code : 'bad_response';
      return { ok: false, code: ['unreachable', 'unauthorized', 'timeout'].includes(code) ? code : 'bad_response' };
    }
  }

  async function close() {
    try {
      if (typeof client.close === 'function') await client.close();
    } catch {
      // closing is best effort
    }
  }

  return {
    name: 'github', repo: defaultRepo, start, offeredTools, call, close,
  };
}

module.exports = {
  createGithubConnector, checkTools, readArgs, TOOL_NAMES, NEEDS, CREATED_BY_ARLO, MAX_ISSUES,
};
