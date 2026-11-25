// "Arlo, open issue 42 and share it": the deployment's GitHub repository, the
// issue number a model gives, the one URL that is built from the two, the
// tool in the table, the policy, the sentences, and what the settings say.
// Nothing here touches the network.
const h = require('./helpers');

const REPO = 'example-org/arlo.test_repo';
h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', GITHUB_DEFAULT_REPO: REPO });
delete process.env.WEB_SEARCH_ENABLED;

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  readGithubRepo, normalizeIssueNumber, isIssueNumber, issueNumbersIn, onlyIssueIn, issueUrl,
} = require('../src/lib/github');
const {
  listTools, toolNames, getTool, validateToolCall, githubRepo, ALL_TOOL_NAMES, PANEL_TOOL_NAMES, HOST_TOOL_NAMES,
} = require('../src/services/agent/tools');
const { decide, typedRequestCovers } = require('../src/services/agent/policy');
const {
  TOOL_TEXTS, toolStep, noHands, failedReply, issueShareFailed, ISSUE_SHARE_FAILED_LABEL,
} = require('../src/services/agent/texts');
const { RESULT_CODES } = require('../src/services/agent/hands');

const ON = { githubRepo: REPO };
const OFF = { githubRepo: null };

// --- GITHUB_DEFAULT_REPO -------------------------------------------------------------

test('the repository: owner/name as GitHub writes one, and nothing else', () => {
  const accepted = [
    'example-org/arlo', 'a/b', 'A1/Repo.Name_2-x', 'octo-cat/.github', 'o/...', 'o/-', 'o/_',
    `${'a'.repeat(39)}/${'b'.repeat(100)}`, 'a--b/c',
  ];
  for (const raw of accepted) assert.deepEqual(readGithubRepo(raw), { repo: raw, known: true }, raw);

  const refused = [
    'example-org', 'example-org/', '/arlo', '/', 'example-org/arlo/issues', 'example-org//arlo',
    'example-org/.', 'example-org/..', // a path, not a name
    '-org/arlo', 'org-/arlo', '-/arlo', 'org_x/arlo', 'org.x/arlo', // an owner is letters, digits and inner dashes
    `${'a'.repeat(40)}/arlo`, `org/${'b'.repeat(101)}`,
    // never a URL, a path or anything a URL parser would read differently
    'https://github.com/example-org/arlo', 'github.com/example-org/arlo', 'example-org/arlo.git/../x', '../arlo', 'example-org/../../evil',
    'example-org/arlo?x=1', 'example-org/arlo#x', 'example-org/arlo%2F..', 'user@example-org/arlo', 'example-org\\arlo', 'example-org/ar lo',
    ' example-org/arlo', 'example-org/arlo ', 'example-org/arlo\n', '\texample-org/arlo', 'example-org/arlo\u0000', 'example-org/arlo​',
    // letters that only look like a to z
    'exаmple-org/arlo', 'example-org/аrlo', 'ｅxample/arlo',
    5, {}, ['example-org/arlo'], true,
  ];
  for (const raw of refused) assert.deepEqual(readGithubRepo(raw), { repo: null, known: false }, JSON.stringify(raw));

  // not set is not a mistake
  for (const raw of [undefined, null, '']) assert.deepEqual(readGithubRepo(raw), { repo: null, known: true });
});

/** `config.githubRepo` and what was printed, in a fresh process with GITHUB_DEFAULT_REPO set to `value`. */
function configFor(value) {
  const script = `
    require(${JSON.stringify(path.join(__dirname, 'helpers.js'))}).setTestEnv(${value === undefined ? '' : `{ GITHUB_DEFAULT_REPO: ${JSON.stringify(value)} }`});
    const printed = [];
    for (const level of ['log', 'info', 'warn', 'error']) console[level] = (...args) => printed.push(args.map(String).join(' '));
    const config = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});
    const { toolNames } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'agent', 'tools.js'))});
    process.stdout.write(JSON.stringify({ repo: config.githubRepo, printed, names: toolNames() }));
  `;
  const env = { ...process.env };
  delete env.GITHUB_DEFAULT_REPO;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
}

test('GITHUB_DEFAULT_REPO: a valid value is the setting; an invalid one is ignored with one warning that does not print it', () => {
  const unset = configFor(undefined);
  assert.deepEqual([unset.repo, unset.printed, unset.names.includes('open_issue')], [null, [], false]);

  const set = configFor('example-org/arlo');
  assert.deepEqual([set.repo, set.printed, set.names.includes('open_issue')], ['example-org/arlo', [], true]);

  for (const bad of ['https://github.com/example-org/arlo', 'example-org/..', 'hunter2:secret@example-org/arlo', 'example-org/arlo?token=abc', 'nonsense', 'example-org/arlo/']) {
    const got = configFor(bad);
    assert.equal(got.repo, null, bad);
    assert.equal(got.names.includes('open_issue'), false, bad);
    assert.equal(got.printed.length, 1, bad);
    assert.match(got.printed[0], /GITHUB_DEFAULT_REPO/);
    assert.equal(/hunter2|token=abc|nonsense|example|arlo/.test(got.printed.join('\n')), false, bad);
  }
});

// --- the number ----------------------------------------------------------------------

test('an issue number is rebuilt: a whole number from 1 to 9999999, or it is not a number', () => {
  const numbers = [
    [42, 42], [1, 1], [9999999, 9999999], ['42', 42], ['1', 1], ['9999999', 9999999], ['1000', 1000],
    // 1e3 in JSON is the number 1000
    [1e3, 1000],
  ];
  for (const [given, number] of numbers) assert.equal(normalizeIssueNumber(given), number, JSON.stringify(given));

  const refused = [
    0, -1, -42, 10000000, 2 ** 53, 1e21, 42.5, 0.1, NaN, Infinity, -Infinity, -0,
    '', ' ', '0', '00', '042', '-42', '+42', ' 42', '42 ', '4 2', '42\n', '\t42', '42.0', '42.5', '4,2', '1e3', '0x2a', '0b101', '42abc', 'abc42', '#42', 'forty two',
    '10000000', '12345678', '9'.repeat(40), '9'.repeat(5000),
    // digits of another script, and digits behind something invisible
    '٤٢', '４２', '१२', '4​2', '42​', '‮42', '42\u0000', '²',
    // never a URL, a path or a repository
    'https://evil.example/issues/42', 'evil-org/repo#42', 'evil-org/repo/issues/42', '42/../../pulls', '../42', '42?x=1', '42#x', '42%2F..', 'javascript:42',
    null, undefined, true, false, {}, [], [42], ['42'], { number: 42 }, { valueOf: () => 42 }, { toString: () => '42' }, 42n,
  ];
  for (const given of refused) assert.equal(normalizeIssueNumber(given), null, typeof given === 'bigint' ? 'bigint' : JSON.stringify(given));

  assert.equal(isIssueNumber(42), true);
  for (const not of ['42', 0, -1, 42.5, 10000000, NaN, null, undefined, [42]]) assert.equal(isIssueNumber(not), false, String(not));
});

test('the issues named in what someone typed', () => {
  for (const typed of ['open issue 42', 'open issue #42', 'Open Issue Number 42', 'open issue no. 42', 'open issue no.42', 'pull up #42', 'show me #42, please', 'open  ISSUE\n42 now', 'open issue 42.', '(#42)', 'open issue 42!']) {
    assert.deepEqual(issueNumbersIn(typed), [42], typed);
  }
  assert.deepEqual(issueNumbersIn('open issue 1 and issue 9999999'), [1, 9999999]);
  // every time one is named, in order
  assert.deepEqual(issueNumbersIn('compare #7 with issue 12 and #7'), [7, 12, 7]);
  // a number that is not said to be an issue, or is not one
  const none = [
    'open 42', 'open ticket 42', 'in 42 minutes', 'version 2', 'open the issue', 'open issue forty two', 'open issue',
    'open issues 42', 'open tissue 42', 'open sub-issue 42', 'open issue42', 'open issue#42', 'open issue # 42', 'open issue -42',
    'open issue 042', 'open issue 0', 'open #0', 'open #042', 'open issue 12345678', 'open #12345678',
    'open issue 42abc', 'open issue 42nd', 'open issue 42_1', 'open issue 42.5', 'open issue 42-43', 'open issue 42-',
    'open PR#42', 'open a#42', 'open 1#42', 'open issue ٤٢', 'open issue ４２', 'open #４２',
    'open i­ssue 42', 'open іssue 42', // a soft hyphen in the word, a Cyrillic letter that looks like i
    'open iſſue 42', // long s, which matching without case would read as s
  ];
  for (const typed of none) assert.deepEqual(issueNumbersIn(typed), [], typed);
  for (const not of [5, null, undefined, {}, ['issue 42'], `issue 42 ${'x'.repeat(2000)}`]) assert.deepEqual(issueNumbersIn(not), []);

  // the one issue of a text: exactly one named, and no other digit in it
  assert.deepEqual(onlyIssueIn('open issue 42 and share it'), { number: 42, before: 'open ', around: 'open   and share it' });
  assert.equal(onlyIssueIn('Open issue no. 42').number, 42);
  assert.equal(/no/.test(onlyIssueIn('Open issue no. 42').around), false);
  for (const typed of [
    'open issue 42 and 43', 'open issue 42 and issue 43', 'open issue 42 and #42', 'open issue 42 in 5 minutes', 'open 7 issue 42',
    'open issue 42 ٤', 'open issue 4​2', 'open issue 42​3', 'open issue 42 ²', 'open the issue', 'open 42', '', 5, null,
  ]) {
    assert.equal(onlyIssueIn(typed), null, JSON.stringify(typed));
  }
});

test('the URL is only ever GitHub, the repository, "/issues/", and a number', () => {
  assert.equal(issueUrl(REPO, 42), 'https://github.com/example-org/arlo.test_repo/issues/42');
  assert.equal(issueUrl('a/b', 9999999), 'https://github.com/a/b/issues/9999999');
  // a number that is not one in its final form, or a repository that is not the setting's form: no URL
  for (const number of ['42', 0, -1, 42.5, 10000000, NaN, '42/../x', 'https://evil.example', '', null, undefined, [42]]) {
    assert.equal(issueUrl(REPO, number), null, String(number));
  }
  for (const repo of [null, undefined, '', 'example-org', 'example-org/..', 'example-org/.', `https://github.com/${REPO}`, `${REPO}/`, 'evil.example/x/y', 'a/b?x=1', 'a/b#x', 5, ['a/b']]) {
    assert.equal(issueUrl(repo, 42), null, String(repo));
  }
  // whatever is accepted, the URL is GitHub, that repository and that number and nothing else
  for (const repo of [REPO, 'a/b', 'octo-cat/.github', 'o/...', `${'a'.repeat(39)}/${'b'.repeat(100)}`]) {
    for (const given of [1, '42', 9999999]) {
      const number = normalizeIssueNumber(given);
      const url = new URL(issueUrl(repo, number));
      assert.deepEqual(
        [url.protocol, url.host, url.pathname, url.search, url.hash, url.username, url.password],
        ['https:', 'github.com', `/${repo}/issues/${number}`, '', '', '', ''],
      );
    }
  }
});

// --- the tool table ------------------------------------------------------------------

test('open_issue is in the table only when the deployment has a GitHub repository', () => {
  // this file's environment has one
  assert.equal(githubRepo(), REPO);
  assert.equal(toolNames().includes('open_issue'), true);
  assert.equal(githubRepo(ON), REPO);
  assert.equal(githubRepo(OFF), null);
  // an override that is not a repository is none
  for (const bad of [`https://github.com/${REPO}`, `${REPO}/`, 'example-org/..', 'nonsense', '', 5, undefined]) assert.equal(githubRepo({ githubRepo: bad }), null, String(bad));

  assert.equal(toolNames(OFF).includes('open_issue'), false);
  assert.equal(getTool('open_issue', OFF), null);
  assert.deepEqual(validateToolCall('open_issue', { number: 42, share: false }, OFF), { ok: false });
  assert.deepEqual(listTools(OFF).map((tool) => tool.name), listTools({ ...ON }).map((tool) => tool.name).filter((name) => name !== 'open_issue'));

  const tool = getTool('open_issue', ON);
  assert.deepEqual([tool.runs, tool.changesMeeting, tool.needsHost], ['panel', true, undefined]);
  assert.deepEqual(tool.parameters.required, ['number', 'share']);
  assert.deepEqual(
    [tool.parameters.properties.number.type, tool.parameters.properties.number.minimum, tool.parameters.properties.number.maximum],
    ['integer', 1, 9999999],
  );
  assert.equal(tool.parameters.properties.share.type, 'boolean');
  assert.equal(tool.parameters.additionalProperties, false);
  // no argument for a URL or a repository
  assert.deepEqual(Object.keys(tool.parameters.properties), ['number', 'share']);
  // the repository is not in anything a model is given
  assert.equal(/example-org|arlo\.test_repo/.test(JSON.stringify(tool)), false);
  assert.match(tool.description, /GitHub repository/);
  assert.match(tool.description, /number/i);
  assert.match(tool.description, /not /i);
  // spoken numbers are given as digits
  assert.match(tool.parameters.properties.number.description, /digits/);
  assert.match(tool.parameters.properties.number.description, /forty two/);
  // every name there is, whatever the deployment has on: the record and the panels know it
  assert.equal(ALL_TOOL_NAMES.includes('open_issue'), true);
  assert.equal(PANEL_TOOL_NAMES.includes('open_issue'), true);
  assert.equal(HOST_TOOL_NAMES.includes('open_issue'), false);
  assert.equal(RESULT_CODES.includes('share_failed'), true);
});

test('a call of open_issue: the number is rebuilt, share is a boolean, and nothing else is taken', () => {
  const call = (args) => validateToolCall('open_issue', args, ON);
  assert.deepEqual(call({ number: 42, share: true }), { ok: true, args: { number: 42, share: true } });
  assert.deepEqual(call({ number: '42', share: false }), { ok: true, args: { number: 42, share: false } });
  assert.deepEqual(call({ number: 9999999, share: false }), { ok: true, args: { number: 9999999, share: false } });
  assert.deepEqual(call({ number: '1234567', share: false }), { ok: true, args: { number: 1234567, share: false } });
  const bad = [
    {}, { number: 42 }, { share: true }, { number: 42, share: 'true' }, { number: 42, share: 1 },
    { number: 42, share: null }, { number: 42, share: 'yes' },
    { number: 42, share: true, url: 'https://evil.example' }, { url: 'https://evil.example/issues/42', share: true },
    { number: 42, share: true, repo: 'evil-org/repo' }, { number: 42, share: true, repository: 'evil-org/repo' }, { repo: 'evil-org/repo', share: true },
    { key: 'PROJ-123', share: true },
  ];
  for (const args of bad) assert.deepEqual(call(args), { ok: false }, JSON.stringify(args));
  const hostile = [
    -42, -1, 0, 42.5, 1e21, 10000000, 2 ** 53, NaN, Infinity,
    '', '0', '042', '-42', '+42', ' 42', '42 ', '42\n', '42.5', '1e3', '42abc', '#42', 'forty two', '10000000', '9'.repeat(500),
    '٤٢', '４２', '4​2',
    'https://evil.example/issues/42', 'evil-org/repo#42', '42/../../pulls',
    null, true, {}, [42], ['42'], { toString: () => '42' }, { valueOf: () => 42 },
  ];
  for (const number of hostile) assert.deepEqual(call({ number, share: false }), { ok: false }, JSON.stringify(number));
});

// --- the policy ----------------------------------------------------------------------

test('opening an issue changes the meeting: a sheet for speech, and for a typed request only a covered one runs', () => {
  const tool = getTool('open_issue', ON);
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

  const covers = (typed, args) => typedRequestCovers(typed, 'open_issue', args);
  const plain = { number: 42, share: false };
  const shared = { number: 42, share: true };
  // the issue is named in what was typed, however it was written
  for (const typed of [
    'open issue 42', 'Open issue #42 please', 'open #42', 'pull up issue number 42', 'show me issue no. 42', 'bring up #42.',
    'Arlo, can you open issue 42?', 'open issue 42 in the browser',
  ]) {
    assert.equal(covers(typed, plain), true, typed);
  }
  // no issue named, another one, or more than one number
  for (const typed of [
    'open 42', 'open ticket 42', 'open the issue', 'open the issue we talked about', 'open issue forty two', 'in 42 minutes', 'open it in 42 minutes',
    'open issue 43', 'open issue 420', 'open issue 4', 'open issue 042', 'open issue 42.5', 'open issue 42-43',
    'open issue 42 and 43', 'open issue 42 and issue 43', 'open issue 42 and #42', 'open issue 42 in 5 minutes', 'open issue 4​2',
    'open issue ４２', 'open issue ٤٢', 'what did we decide?',
  ]) {
    assert.equal(covers(typed, plain), false, typed);
  }
  // no word that opens, or a word that turns it around
  for (const typed of [
    'close issue 42', 'what is issue 42 about', 'issue 42', 'reopen issue 42', 'is issue 42 open?', 'issue 42, open it', 'showing issue 42',
    'open issue 42, don\'t share', 'dont open issue 42', 'do not open issue 42', 'never open issue 42', 'open issue 42 unless it is closed',
    'open issue 42 instead', 'stop, open issue 42', 'open issue 42 without sharing', 'no, open issue 42', 'open no issue 42',
  ]) {
    assert.equal(covers(typed, plain), false, typed);
    assert.equal(covers(typed, shared), false, typed);
  }
  // sharing was asked for only when "share" was typed
  for (const typed of ['open issue 42 and share it', 'Open and share #42', 'open issue 42 and SHARE my screen', 'open issue 42 and start sharing', 'open issue no. 42 and screen-share it']) {
    assert.equal(covers(typed, shared), true, typed);
  }
  for (const typed of ['open issue 42', 'open #42 for me', 'Share issue 42', 'open issue 42, the shareholders one', 'open issue 42 unshared', 'open issue 42 on the shared drive', 'open issue 42 and un-share']) {
    assert.equal(covers(typed, shared), false, typed);
  }
  // "share" typed and not asked of the tool: covered, less is done than was typed
  assert.equal(covers('open issue 42 and share it', plain), true);
  // arguments that are not the table's: not covered
  for (const args of [
    {}, null, { number: 42 }, { number: 42, share: 'false' }, { number: '42', share: false }, { number: 42.5, share: false },
    { number: -42, share: false }, { number: 0, share: false }, { number: [42], share: false }, { share: false }, { key: 'PROJ-123', share: false },
  ]) {
    assert.equal(covers('open issue 42 and share it', args), false, JSON.stringify(args));
  }
  for (const typed of [5, null, undefined]) assert.equal(covers(typed, plain), false);
});

// --- the sentences -------------------------------------------------------------------

test('what the record, the sheet and the asker\'s panel say about an issue', () => {
  const texts = TOOL_TEXTS.open_issue;
  const plain = { number: 42, share: false };
  const shared = { number: 42, share: true };
  // the record is read by everyone in the meeting: no number in it
  assert.equal(texts.asked(plain), 'Asked to open an issue');
  assert.equal(texts.asked(shared), 'Asked to open an issue');
  assert.equal(texts.done(plain), 'Opened an issue');
  assert.equal(texts.done(shared), 'Opened an issue and opened the share dialog');
  assert.equal(ISSUE_SHARE_FAILED_LABEL, 'Opened an issue. Couldn\'t open the share dialog.');
  assert.equal(texts.question(plain), 'Open issue #42 in your browser?');
  assert.equal(texts.question(shared), 'Open issue #42 in your browser and share your screen?');
  assert.equal(texts.primary(plain), 'Open');
  assert.equal(texts.primary(shared), 'Open and share');
  assert.equal(texts.reply(plain), 'Done: opened issue #42.');
  assert.equal(texts.reply(shared), 'Done: opened issue #42 and opened the share dialog.');
  assert.equal(toolStep('open_issue', plain), 'Opening issue #42');
  assert.equal(toolStep('open_issue', shared), 'Opening issue #42');
  // a number that is not one is never shown
  for (const args of [null, undefined, {}, { number: 'https://evil.example' }, { number: '42' }, { number: 'x'.repeat(500) }, { number: -1 }, { number: 4.2 }, { number: 1e21 }, 42]) {
    assert.equal(toolStep('open_issue', args), 'Opening an issue');
    assert.equal(texts.question(args), 'Open an issue in your browser?');
  }
  assert.equal(noHands('open_issue'), 'Open Arlo to let it do that.');
  assert.equal(issueShareFailed(shared), 'Opened issue #42. Couldn\'t open the share dialog.');
  assert.equal(failedReply('open_issue', 'share_failed', shared), 'Opened issue #42. Couldn\'t open the share dialog.');
  // only for an issue that was to be shared
  assert.equal(failedReply('open_issue', 'share_failed', plain), null);
  assert.equal(failedReply('open_issue', 'sdk_error', shared), null);
  assert.equal(failedReply('send_reaction', 'share_failed', { reaction: 'clap' }), null);
});

// --- the settings --------------------------------------------------------------------

test('the settings say which repository the deployment has to someone who is signed in, and to nobody else', async () => {
  const srv = await h.startServer();
  try {
    const { generateToken } = require('../src/services/auth');
    const { userStore } = require('../src/lib/memoryStore');
    const user = userStore.upsert('zoom-settings-ana', { email: 'ana@example.test', displayName: 'Ana Ruiz', avatarUrl: null });
    const cookie = `sessionToken=${generateToken({ userId: user.id, zoomUserId: 'zoom-settings-ana' })}`;
    const res = await fetch(`${srv.base}/api/auth/settings`, { headers: { cookie } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body.features.github, { repo: REPO });
    // no session, or one that is not valid: the other settings, and no repository
    for (const headers of [{}, { cookie: 'sessionToken=forged.token.value' }, { cookie: 'meetingAccess=anything' }]) {
      const open = await fetch(`${srv.base}/api/auth/settings`, { headers });
      const text = await open.text();
      assert.equal(open.status, 200);
      assert.deepEqual(JSON.parse(text).features.github, { repo: null });
      assert.equal(typeof JSON.parse(text).demoMode, 'boolean');
      assert.equal(/example-org|arlo\.test_repo/.test(text), false);
    }
  } finally {
    srv.server.closeAllConnections?.();
    srv.server.close();
  }
});
