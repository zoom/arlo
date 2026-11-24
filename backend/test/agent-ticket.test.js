// "Arlo, open PROJ-123 and share it": the deployment's Jira base URL, the
// ticket key a model gives, the one URL that is built from the two, the tool
// in the table, the policy, the sentences, and what the settings say.
// Nothing here touches the network.
const h = require('./helpers');

const BASE = 'https://jira.example.test';
h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', JIRA_BASE_URL: `${BASE}/` });
delete process.env.WEB_SEARCH_ENABLED;

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  readJiraBaseUrl, normalizeTicketKey, isTicketKey, ticketKeysIn, ticketUrl,
} = require('../src/lib/jira');
const {
  listTools, toolNames, getTool, validateToolCall, jiraBaseUrl, ALL_TOOL_NAMES, PANEL_TOOL_NAMES, HOST_TOOL_NAMES,
} = require('../src/services/agent/tools');
const { decide, typedRequestCovers } = require('../src/services/agent/policy');
const {
  TOOL_TEXTS, toolStep, noHands, failedReply, ticketShareFailed, TICKET_SHARE_FAILED_LABEL,
} = require('../src/services/agent/texts');
const { RESULT_CODES } = require('../src/services/agent/hands');

const ON = { jiraBaseUrl: BASE };
const OFF = { jiraBaseUrl: null };

// --- JIRA_BASE_URL -------------------------------------------------------------------

test('the base URL: https, a host, an optional context path, and nothing else', () => {
  const accepted = [
    ['https://jira.example.test', 'https://jira.example.test'],
    ['https://jira.example.test/', 'https://jira.example.test'],
    ['https://jira.example.test///', 'https://jira.example.test'],
    ['https://example.atlassian.net', 'https://example.atlassian.net'],
    // a context path is kept, without its trailing slash
    ['https://tools.example.test/jira', 'https://tools.example.test/jira'],
    ['https://tools.example.test/jira/', 'https://tools.example.test/jira'],
    ['https://tools.example.test:8443/jira', 'https://tools.example.test:8443/jira'],
    ['HTTPS://JIRA.Example.Test', 'https://jira.example.test'],
  ];
  for (const [raw, url] of accepted) assert.deepEqual(readJiraBaseUrl(raw), { url, known: true }, raw);

  const refused = [
    'http://jira.example.test', // not https
    'ftp://jira.example.test',
    'javascript:alert(1)',
    'https://user:secret@jira.example.test', // credentials
    'https://user@jira.example.test',
    'https://jira.example.test?x=1', // a query
    'https://jira.example.test/?',
    'https://jira.example.test/#top', // a fragment
    'https://jira.example.test#',
    'jira.example.test', // garbage
    'not a url',
    'https://',
    'https:///browse',
    'https:jira.example.test',
    'https:\\\\jira.example.test',
    'https://jira.example.test/a b',
    ' https://jira.example.test',
    'https://jira.example.test\n',
    'https://jira.ex\u0430mple.test', // a Cyrillic letter in the host
    `https://jira.example.test/${'a'.repeat(200)}`, // longer than 200
    5, {}, ['https://jira.example.test'],
  ];
  for (const raw of refused) assert.deepEqual(readJiraBaseUrl(raw), { url: null, known: false }, String(raw));

  // not set is not a mistake
  for (const raw of [undefined, null, '']) assert.deepEqual(readJiraBaseUrl(raw), { url: null, known: true });
  assert.equal(readJiraBaseUrl(`https://j.example.test/${'a'.repeat(200 - 'https://j.example.test/'.length)}`).url.length, 200);
});

/** `config.jiraBaseUrl` and what was printed, in a fresh process with JIRA_BASE_URL set to `value`. */
function configFor(value) {
  const script = `
    require(${JSON.stringify(path.join(__dirname, 'helpers.js'))}).setTestEnv(${value === undefined ? '' : `{ JIRA_BASE_URL: ${JSON.stringify(value)} }`});
    const printed = [];
    for (const level of ['log', 'info', 'warn', 'error']) console[level] = (...args) => printed.push(args.map(String).join(' '));
    const config = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});
    const { toolNames } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'agent', 'tools.js'))});
    process.stdout.write(JSON.stringify({ url: config.jiraBaseUrl, printed, names: toolNames() }));
  `;
  const env = { ...process.env };
  delete env.JIRA_BASE_URL;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
}

test('JIRA_BASE_URL: a valid value is the setting; an invalid one is ignored with one warning that does not print it', () => {
  const unset = configFor(undefined);
  assert.deepEqual([unset.url, unset.printed, unset.names.includes('open_ticket')], [null, [], false]);

  const set = configFor('https://tools.example.test/jira/');
  assert.deepEqual([set.url, set.printed, set.names.includes('open_ticket')], ['https://tools.example.test/jira', [], true]);

  for (const bad of ['http://jira.example.test', 'https://user:hunter2@jira.example.test', 'https://jira.example.test?token=abc', 'nonsense']) {
    const got = configFor(bad);
    assert.equal(got.url, null, bad);
    assert.equal(got.names.includes('open_ticket'), false, bad);
    assert.equal(got.printed.length, 1, bad);
    assert.match(got.printed[0], /JIRA_BASE_URL/);
    assert.equal(/hunter2|token=abc|nonsense|example/.test(got.printed.join('\n')), false, bad);
  }
});

// --- the key -------------------------------------------------------------------------

test('a ticket key is rebuilt: letters, one dash, a number, or it is not a key', () => {
  const keys = [
    ['PROJ-123', 'PROJ-123'],
    ['proj-123', 'PROJ-123'],
    ['  Proj-123  ', 'PROJ-123'],
    ['proj 123', 'PROJ-123'],
    ['PROJ   123', 'PROJ-123'],
    ['PROJ_123', 'PROJ-123'],
    ['PROJ _ 123', 'PROJ-123'],
    ['PROJ dash 123', 'PROJ-123'],
    ['proj Dash 123', 'PROJ-123'],
    ['ABC hyphen 42', 'ABC-42'],
    ['PROJ - 123', 'PROJ-123'],
    ['AB-1', 'AB-1'],
    ['A1B2-7', 'A1B2-7'],
    ['ABCDEFGHIJ-1234567', 'ABCDEFGHIJ-1234567'],
  ];
  for (const [given, key] of keys) assert.equal(normalizeTicketKey(given), key, given);

  const refused = [
    '', '   ', 'PROJ', '123', 'PROJ-', '-123', 'P-1', // a project is two characters or more
    'ABCDEFGHIJK-1', // a project of eleven
    'PROJ-12345678', // a number of eight digits
    `${'A'.repeat(30)}-${'1'.repeat(30)}`, // too long to be looked at
    '123-PROJ', '1AB-2', // digits first
    'PROJ-123-4', 'PROJ--123', 'PROJ-12a', 'PROJ.123', 'PROJ/123', 'PROJ#123',
    'PROJdash123', 'PROJ dash123', 'PROJ dash dash 123', 'PROJ minus 123',
    'PROJ-123 and PROJ-124', 'open PROJ-123',
    // never a URL or a path
    'https://evil.example/browse/PROJ-123', 'evil.example/PROJ-123', '//evil.example', 'PROJ-123/../x', 'PROJ-123/../../admin',
    '../PROJ-123', 'PROJ-123?x=1', 'PROJ-123#x', 'PROJ-123%2F..', 'PROJ-123@evil.example', 'javascript:PROJ-123',
    // letters that only look like A to Z
    '\u0420ROJ-123', // a Cyrillic letter that looks like P
    'PR\u041eJ-123', // a Cyrillic letter that looks like O
    '\uff30\uff32\uff2f\uff2a-123', // full-width letters
    'PROJ-\uff11\uff12\uff13', // full-width digits
    'PROJ\u2010123', 'PROJ\u2013123', 'PROJ\u2212123', // other dashes
    'p\u0131j-123', // a dotless i, which upper-casing would turn into I
    '\u017ft-123', // a long s, which upper-casing would turn into S
    'PROJ\u00a0123', // a no-break space
    // control and invisible characters
    'PROJ-123\n', '\tPROJ-123', 'PROJ\n123', 'PROJ-\u0000123', 'PROJ-123\u200b', 'PR\u202eOJ-123', 'PROJ\u007f-123',
    5, null, undefined, {}, ['PROJ-123'], true,
  ];
  for (const given of refused) assert.equal(normalizeTicketKey(given), null, JSON.stringify(given));

  assert.equal(isTicketKey('PROJ-123'), true);
  for (const not of ['proj-123', 'PROJ 123', ' PROJ-123', 'PROJ-123\n', 5, null]) assert.equal(isTicketKey(not), false, String(not));
});

test('the keys in what someone typed are read the same way as a key a model gave', () => {
  assert.deepEqual(ticketKeysIn('open PROJ-123'), ['PROJ-123']);
  assert.deepEqual(ticketKeysIn('open PROJ 123 and share it'), ['PROJ-123']);
  assert.deepEqual(ticketKeysIn('open proj-123, Proj - 124, proj hyphen 125 and AB1 7'), ['PROJ-123', 'PROJ-124', 'PROJ-125', 'AB1-7']);
  // with only a space between them, words and a number are not a key
  for (const typed of ['open proj 123 and share it', 'open ticket 42', 'open PROJ-12 in 5 minutes', 'version 2', 'Proj 123', 'at 10 or by 11']) {
    assert.deepEqual(ticketKeysIn(typed).filter((key) => key !== 'PROJ-12'), [], typed);
  }
  // a key a model gave is read as before
  assert.equal(normalizeTicketKey('proj 123'), 'PROJ-123');
  assert.deepEqual(ticketKeysIn('pull up ticket ABC dash 42, please'), ['ABC-42']);
  assert.deepEqual(ticketKeysIn('Open  proj_123\nnow'), ['PROJ-123']);
  assert.deepEqual(ticketKeysIn('compare PROJ-1 with ops-22.'), ['PROJ-1', 'OPS-22']);
  assert.equal(ticketKeysIn('open the ticket').length, 0);
  // not part of a longer word or number
  assert.equal(ticketKeysIn('xPROJ-12345678').includes('PROJ-1234567'), false);
  assert.equal(ticketKeysIn('open \u0420ROJ-123').includes('PROJ-123'), false);
  for (const not of [5, null, undefined, {}, 'x'.repeat(2001)]) assert.deepEqual(ticketKeysIn(not), []);
});

test('the URL is only ever the base, "/browse/", and a key', () => {
  assert.equal(ticketUrl(BASE, 'PROJ-123'), 'https://jira.example.test/browse/PROJ-123');
  assert.equal(ticketUrl('https://tools.example.test/jira', 'AB-1'), 'https://tools.example.test/jira/browse/AB-1');
  // a key that is not one in its final form, or a base that is not the setting's form: no URL
  for (const key of ['proj-123', 'PROJ 123', 'PROJ-123/../x', 'https://evil.example', '', null, undefined, 5]) {
    assert.equal(ticketUrl(BASE, key), null, String(key));
  }
  for (const base of [null, undefined, '', `${BASE}/`, 'http://jira.example.test', 'https://jira.example.test?x=1', 5]) {
    assert.equal(ticketUrl(base, 'PROJ-123'), null, String(base));
  }
  // whatever key is accepted, the URL is the base and that key and nothing else
  for (const given of ['proj 123', 'PROJ dash 123', 'ab_9', 'Zed-0000001']) {
    const key = normalizeTicketKey(given);
    const url = new URL(ticketUrl(BASE, key));
    assert.deepEqual([url.origin, url.pathname, url.search, url.hash, url.username], [BASE, `/browse/${key}`, '', '', '']);
  }
});

// --- the tool table ------------------------------------------------------------------

test('open_ticket is in the table only when the deployment has a Jira base URL', () => {
  // this file's environment has one
  assert.equal(jiraBaseUrl(), BASE);
  assert.equal(toolNames().includes('open_ticket'), true);
  assert.equal(jiraBaseUrl(ON), BASE);
  assert.equal(jiraBaseUrl(OFF), null);
  // an override that is not a base URL in its final form is none
  for (const bad of ['http://jira.example.test', `${BASE}/`, 'nonsense', '']) assert.equal(jiraBaseUrl({ jiraBaseUrl: bad }), null, bad);

  assert.equal(toolNames(OFF).includes('open_ticket'), false);
  assert.equal(getTool('open_ticket', OFF), null);
  assert.deepEqual(validateToolCall('open_ticket', { key: 'PROJ-123', share: false }, OFF), { ok: false });
  assert.deepEqual(listTools(OFF).map((tool) => tool.name), listTools({ ...ON }).map((tool) => tool.name).filter((name) => name !== 'open_ticket'));

  const tool = getTool('open_ticket', ON);
  assert.deepEqual([tool.runs, tool.changesMeeting, tool.needsHost], ['panel', true, undefined]);
  assert.deepEqual(tool.parameters.required, ['key', 'share']);
  assert.deepEqual([tool.parameters.properties.key.type, tool.parameters.properties.key.maxLength], ['string', 40]);
  assert.equal(tool.parameters.properties.share.type, 'boolean');
  assert.equal(tool.parameters.additionalProperties, false);
  // the base URL is not in anything a model is given
  assert.equal(JSON.stringify(tool).includes('jira.example.test'), false);
  assert.match(tool.description, /key/i);
  assert.match(tool.description, /not /i);
  // every name there is, whatever the deployment has on: the record and the panels know it
  assert.equal(ALL_TOOL_NAMES.includes('open_ticket'), true);
  assert.equal(PANEL_TOOL_NAMES.includes('open_ticket'), true);
  assert.equal(HOST_TOOL_NAMES.includes('open_ticket'), false);
  assert.equal(RESULT_CODES.includes('share_failed'), true);
});

test('a call of open_ticket: the key is rebuilt, share is a boolean, and nothing else is taken', () => {
  const call = (args) => validateToolCall('open_ticket', args, ON);
  assert.deepEqual(call({ key: 'PROJ-123', share: true }), { ok: true, args: { key: 'PROJ-123', share: true } });
  assert.deepEqual(call({ key: ' proj 123 ', share: false }), { ok: true, args: { key: 'PROJ-123', share: false } });
  assert.deepEqual(call({ key: 'ABC dash 42', share: false }), { ok: true, args: { key: 'ABC-42', share: false } });
  const bad = [
    {}, { key: 'PROJ-123' }, { share: true }, { key: 'PROJ-123', share: 'true' }, { key: 'PROJ-123', share: 1 },
    { key: 'PROJ-123', share: null }, { key: 'PROJ-123', share: 'yes' }, { key: 5, share: true }, { key: '', share: true },
    { key: 'PROJ-123', share: true, url: 'https://evil.example' }, { url: 'https://evil.example/browse/PROJ-123', share: true },
    { key: 'https://evil.example/browse/PROJ-123', share: false }, { key: 'PROJ-123/../x', share: false },
    { key: '\u0420ROJ-123', share: false }, { key: 'PROJ-123\n', share: false }, { key: `${'A'.repeat(41)}`, share: false },
    { key: ['PROJ-123'], share: false }, { key: { toString: () => 'PROJ-123' }, share: false },
  ];
  for (const args of bad) assert.deepEqual(call(args), { ok: false }, JSON.stringify(args));
});

// --- the policy ----------------------------------------------------------------------

test('opening a ticket changes the meeting: a sheet for speech, and for a typed request only a covered one runs', () => {
  const tool = getTool('open_ticket', ON);
  const toolKind = tool.changesMeeting ? 'change' : 'read';
  for (const asker of ['owner', 'other']) {
    for (const whoCanAsk of ['owner', 'anyone']) {
      assert.equal(decide({ channel: 'voice', asker, whoCanAsk, toolKind, ownerPanelOpen: true }), 'sheet');
      assert.equal(decide({ channel: 'voice', asker, whoCanAsk, toolKind, ownerPanelOpen: false }), 'silent');
    }
  }
  assert.equal(decide({ channel: 'panel', asker: 'owner', whoCanAsk: 'owner', toolKind }), 'run');
  assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'anyone', toolKind }), 'sheet');
  assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'owner', toolKind }), 'refuse');

  const covers = (typed, args) => typedRequestCovers(typed, 'open_ticket', args);
  const plain = { key: 'PROJ-123', share: false };
  const shared = { key: 'PROJ-123', share: true };
  // the key is in what was typed, however it was written
  for (const typed of ['open PROJ-123', 'open PROJ 123', 'Open Proj-123 please', 'pull up PROJ dash 123', 'show me proj_123']) {
    assert.equal(covers(typed, plain), true, typed);
  }
  // no key, or another one
  for (const typed of ['open the ticket', 'open the ticket we talked about', 'open PROJ-124', 'open PROJ-1234', 'open XPROJ-123', 'open PROJ', 'open 123', 'what did we decide?', 'open proj 123']) {
    assert.equal(covers(typed, plain), false, typed);
  }
  // sharing was asked for only when "share" was typed
  for (const typed of ['open PROJ-123 and share it', 'Open and share proj-123', 'open PROJ-123 and SHARE my screen', 'open PROJ-123 and start sharing']) {
    assert.equal(covers(typed, shared), true, typed);
  }
  for (const typed of ['open PROJ-123', 'open PROJ 123 for me', 'Share proj-123', 'open PROJ-123, the shareholders one', 'open PROJ-123 unshared']) {
    assert.equal(covers(typed, shared), false, typed);
  }
  // "share" typed and not asked of the tool: covered, less is done than was typed
  assert.equal(covers('open PROJ-123 and share it', plain), true);
  // arguments that are not the table's: not covered
  for (const args of [
    {}, null, { key: 'PROJ-123' }, { key: 'PROJ-123', share: 'false' }, { key: 'proj-123', share: false }, { key: 'proj 123', share: false },
    { key: 5, share: false }, { key: '', share: false }, { share: false },
  ]) {
    assert.equal(covers('open PROJ-123 and share it', args), false, JSON.stringify(args));
  }
  for (const typed of [5, null, undefined]) assert.equal(covers(typed, plain), false);
});

// --- the sentences -------------------------------------------------------------------

test('what the record, the sheet and the asker\'s panel say about a ticket', () => {
  const texts = TOOL_TEXTS.open_ticket;
  const plain = { key: 'PROJ-123', share: false };
  const shared = { key: 'PROJ-123', share: true };
  // the record is read by everyone in the meeting: no key in it
  assert.equal(texts.asked(plain), 'Asked to open a ticket');
  assert.equal(texts.asked(shared), 'Asked to open a ticket');
  assert.equal(texts.done(plain), 'Opened a ticket');
  assert.equal(texts.done(shared), 'Opened a ticket and opened the share dialog');
  assert.equal(TICKET_SHARE_FAILED_LABEL, 'Opened a ticket. Couldn\'t open the share dialog.');
  assert.equal(texts.question(plain), 'Open PROJ-123 in your browser?');
  assert.equal(texts.question(shared), 'Open PROJ-123 in your browser and share your screen?');
  assert.equal(texts.primary(plain), 'Open');
  assert.equal(texts.primary(shared), 'Open and share');
  assert.equal(texts.reply(plain), 'Done: opened PROJ-123.');
  assert.equal(texts.reply(shared), 'Done: opened PROJ-123 and opened the share dialog.');
  assert.equal(toolStep('open_ticket', plain), 'Opening PROJ-123');
  assert.equal(toolStep('open_ticket', shared), 'Opening PROJ-123');
  // a key that is not one is never shown
  for (const args of [null, undefined, {}, { key: 'https://evil.example' }, { key: 'x'.repeat(500) }, { key: 5 }, 'PROJ-123']) {
    assert.equal(toolStep('open_ticket', args), 'Opening a ticket');
  }
  assert.equal(noHands('open_ticket'), 'Open Arlo to let it do that.');
  assert.equal(ticketShareFailed(shared), 'Opened PROJ-123. Couldn\'t open the share dialog.');
  assert.equal(failedReply('open_ticket', 'share_failed', shared), 'Opened PROJ-123. Couldn\'t open the share dialog.');
  // only for a ticket that was to be shared
  assert.equal(failedReply('open_ticket', 'share_failed', plain), null);
  assert.equal(failedReply('open_ticket', 'sdk_error', shared), null);
  assert.equal(failedReply('send_reaction', 'share_failed', { reaction: 'clap' }), null);
});

// --- the settings --------------------------------------------------------------------

test('the settings say which Jira the deployment has to someone who is signed in, and to nobody else', async () => {
  const srv = await h.startServer();
  try {
    const { generateToken } = require('../src/services/auth');
    const { userStore } = require('../src/lib/memoryStore');
    const user = userStore.upsert('zoom-settings-ana', { email: 'ana@example.test', displayName: 'Ana Ruiz', avatarUrl: null });
    const cookie = `sessionToken=${generateToken({ userId: user.id, zoomUserId: 'zoom-settings-ana' })}`;
    const res = await fetch(`${srv.base}/api/auth/settings`, { headers: { cookie } });
    const body = await res.json();
    assert.equal(res.status, 200);
    // as the server uses it: no trailing slash
    assert.deepEqual(body.features.jira, { baseUrl: BASE });
    // no session, or one that is not valid: the other settings, and no Jira host
    for (const headers of [{}, { cookie: 'sessionToken=forged.token.value' }, { cookie: 'meetingAccess=anything' }]) {
      const open = await fetch(`${srv.base}/api/auth/settings`, { headers });
      const text = await open.text();
      assert.equal(open.status, 200);
      assert.deepEqual(JSON.parse(text).features.jira, { baseUrl: null });
      assert.equal(typeof JSON.parse(text).demoMode, 'boolean');
      assert.equal(text.includes('jira.example.test'), false);
    }
  } finally {
    srv.server.closeAllConnections?.();
    srv.server.close();
  }
});
