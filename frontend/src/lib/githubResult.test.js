import { vi } from 'vitest';
import {
  parseGithubResult, githubResultChatMessage, openGithubIssue, cutText, GITHUB_RESULT_LIMITS,
} from './githubResult';
import { githubIssueUrl } from './arloActions';

const REPO = 'acme/arlo-app';
const list = (extra = {}) => ({
  kind: 'github_issues',
  repo: REPO,
  total: 2,
  issues: [
    { number: 12, title: 'Login fails on Safari', labels: ['bug', 'p1'], updatedAt: '2026-11-26T10:00:00Z' },
    { number: 7, title: 'Add dark mode', labels: [], updatedAt: '2026-11-20T10:00:00Z' },
  ],
  ...extra,
});
const one = (issue = {}, extra = {}) => ({
  kind: 'github_issue', repo: REPO, issue: { number: 12, title: 'Login fails on Safari', state: 'open', body: 'Steps:\n1. Open\n2. Click', ...issue }, ...extra,
});
const created = (extra = {}) => ({ kind: 'github_issue_created', repo: REPO, number: 31, title: 'Write the release notes', ...extra });

describe('parseGithubResult', () => {
  test('the three kinds, rebuilt from known fields', () => {
    expect(parseGithubResult({ ...list(), extra: 'x' }, REPO)).toEqual({
      kind: 'github_issues',
      repo: REPO,
      total: 2,
      issues: [
        { number: 12, title: 'Login fails on Safari', labels: ['bug', 'p1'] },
        { number: 7, title: 'Add dark mode', labels: [] },
      ],
    });
    expect(parseGithubResult(one({ url: 'https://evil.example' }), REPO)).toEqual({
      kind: 'github_issue', repo: REPO, issue: { number: 12, title: 'Login fails on Safari', state: 'open', body: 'Steps:\n1. Open\n2. Click' },
    });
    expect(parseGithubResult(created({ url: 'https://evil.example' }), REPO)).toEqual({
      kind: 'github_issue_created', repo: REPO, number: 31, title: 'Write the release notes',
    });
  });

  test('an empty list, and a state the server does not know', () => {
    expect(parseGithubResult(list({ total: 0, issues: [] }), REPO)).toEqual({ kind: 'github_issues', repo: REPO, total: 0, issues: [] });
    expect(parseGithubResult(one({ state: null, body: null }), REPO).issue).toMatchObject({ state: null, body: '' });
  });

  test.each([
    ['nothing', null],
    ['text', 'github_issues'],
    ['an array', [list()]],
    ['another kind', { ...list(), kind: 'github_pull_requests' }],
    ['no kind', { ...list(), kind: undefined }],
    ['another repository than the settings name', list({ repo: 'evil/arlo-app' })],
    ['a repository that is a path', list({ repo: 'acme/arlo-app/../../evil' })],
    ['a repository that is a URL', list({ repo: 'https://evil.example/a/b' })],
    ['a repository named ".."', list({ repo: 'acme/..' })],
    ['issues that are no list', list({ issues: { 0: {} } })],
    ['more than 10 issues', list({ total: 11, issues: Array.from({ length: 11 }, (_, i) => ({ number: i + 1, title: 't', labels: [] })) })],
    ['a total that is text', list({ total: '2' })],
    ['a total that is a fraction', list({ total: 2.5 })],
    ['a total smaller than the list', list({ total: 1 })],
    ['a number as text', list({ issues: [{ number: '12', title: 't', labels: [] }] , total: 1 })],
    ['a number that is a fraction', list({ issues: [{ number: 1.5, title: 't', labels: [] }], total: 1 })],
    ['a number of zero', list({ issues: [{ number: 0, title: 't', labels: [] }], total: 1 })],
    ['a number that is too large', list({ issues: [{ number: 10000000, title: 't', labels: [] }], total: 1 })],
    ['NaN', list({ issues: [{ number: NaN, title: 't', labels: [] }], total: 1 })],
    ['the same number twice', list({ issues: [{ number: 1, title: 'a', labels: [] }, { number: 1, title: 'b', labels: [] }] })],
    ['a title that is no text', list({ issues: [{ number: 1, title: { toString: () => 'x' }, labels: [] }], total: 1 })],
    ['a title of nothing visible', list({ issues: [{ number: 1, title: ' ​\u0007 ', labels: [] }], total: 1 })],
    ['labels that are no list', list({ issues: [{ number: 1, title: 't', labels: 'bug' }], total: 1 })],
    ['a label that is no text', list({ issues: [{ number: 1, title: 't', labels: [1] }], total: 1 })],
    ['an issue that is no object', one({}, { issue: 'x' })],
    ['a state that is neither', one({ state: 'merged' })],
    ['a body that is no text', one({ body: ['x'] })],
    ['a created issue without a number', created({ number: undefined })],
    ['a created issue with a number as text', created({ number: '31' })],
  ])('%s is no result', (_name, value) => {
    expect(parseGithubResult(value, REPO)).toBeNull();
  });

  test('without a repository in the settings, any well-formed repository is taken', () => {
    expect(parseGithubResult(list({ repo: 'other/repo' }), null)?.repo).toBe('other/repo');
    expect(parseGithubResult(list({ repo: 'other/repo' }), 'not a repo')?.repo).toBe('other/repo');
  });

  test('control and invisible characters are removed, a line break in a title is a space', () => {
    const parsed = parseGithubResult(list({
      total: 1,
      issues: [{ number: 1, title: 'Fix\u0000 the\nlogin‮​  page\u0007', labels: ['b\u0000ug​', '​', 'p1'] }],
    }), REPO);
    expect(parsed.issues[0]).toEqual({ number: 1, title: 'Fix the login page', labels: ['bug', 'p1'] });
  });

  test('a body keeps its line breaks and loses everything else that is not shown', () => {
    const parsed = parseGithubResult(one({ body: 'One\r\nTwo\u0000‮\n\n\n\n\nThree Four\tFive' }), REPO);
    expect(parsed.issue.body).toBe('One\nTwo\n\nThree\nFour Five');
  });

  test('a 10 000-character title is cut to 200, a label to 50, a body to 1000', () => {
    const parsed = parseGithubResult(list({ total: 1, issues: [{ number: 1, title: 'a'.repeat(10000), labels: ['b'.repeat(500)] }] }), REPO);
    expect(parsed.issues[0].title).toHaveLength(200);
    expect(parsed.issues[0].title.endsWith('…')).toBe(true);
    expect(parsed.issues[0].labels[0]).toHaveLength(50);
    expect(parseGithubResult(one({ body: 'c'.repeat(5000) }), REPO).issue.body).toHaveLength(1000);
  });

  test('HTML in a title stays the text it is', () => {
    const title = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    expect(parseGithubResult(created({ title }), REPO).title).toBe(title);
  });

  test('at most 10 labels per issue', () => {
    const labels = Array.from({ length: 30 }, (_, i) => `l${i}`);
    expect(parseGithubResult(list({ total: 1, issues: [{ number: 1, title: 't', labels }] }), REPO).issues[0].labels).toHaveLength(10);
  });
});

describe('githubIssueUrl: the link is built by the panel', () => {
  test('github.com, the repository, "/issues/", the number', () => {
    expect(githubIssueUrl(REPO, 12)).toBe('https://github.com/acme/arlo-app/issues/12');
  });

  test.each([
    ['no repository', null, 1],
    ['a path', 'acme/arlo-app/../x', 1],
    ['a host', 'evil.example/acme', 1.5],
    ['a number as text', REPO, '12'],
    ['zero', REPO, 0],
    ['too large', REPO, 10000000],
    ['a query in the name', 'acme/arlo?x=1', 1],
    ['a fragment in the name', 'acme/arlo#x', 1],
  ])('%s gives no link', (_name, repo, number) => {
    expect(githubIssueUrl(repo, number)).toBeNull();
  });
});

describe('githubResultChatMessage: what "Post to chat" posts', () => {
  test('a list: the heading, up to 5 issues with the title cut to 80, and how many more', () => {
    const issues = Array.from({ length: 8 }, (_, i) => ({ number: i + 1, title: i === 0 ? 'x'.repeat(120) : `Issue ${i + 1}`, labels: ['bug'] }));
    const message = githubResultChatMessage(parseGithubResult(list({ total: 23, issues }), REPO));
    expect(message).toBe([
      'Open issues in acme/arlo-app:',
      `#1 ${'x'.repeat(79)}…`,
      '#2 Issue 2',
      '#3 Issue 3',
      '#4 Issue 4',
      '#5 Issue 5',
      '… and 18 more',
    ].join('\n'));
  });

  test('a short list has no "more" line', () => {
    expect(githubResultChatMessage(parseGithubResult(list(), REPO))).toBe('Open issues in acme/arlo-app:\n#12 Login fails on Safari\n#7 Add dark mode');
  });

  test('one issue: its number and title, and the link built here', () => {
    expect(githubResultChatMessage(parseGithubResult(one(), REPO))).toBe('#12 Login fails on Safari\nhttps://github.com/acme/arlo-app/issues/12');
  });

  test('never more than 1000 characters', () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({ number: 9999990 + i, title: 'y'.repeat(200), labels: [] }));
    expect(githubResultChatMessage(parseGithubResult(list({ total: 10, issues }), REPO)).length).toBeLessThanOrEqual(GITHUB_RESULT_LIMITS.chatMessage);
  });

  test('nothing for an empty list, a created issue, or something that is no result', () => {
    expect(githubResultChatMessage(parseGithubResult(list({ total: 0, issues: [] }), REPO))).toBe('');
    expect(githubResultChatMessage(parseGithubResult(created(), REPO))).toBe('');
    expect(githubResultChatMessage(null)).toBe('');
  });
});

describe('openGithubIssue', () => {
  afterEach(() => vi.restoreAllMocks());

  test('in Zoom: openUrl with the built link and nothing else', async () => {
    const zoomSdk = { openUrl: vi.fn(async () => ({})) };
    expect(await openGithubIssue({ zoomSdk, inZoom: true, repo: REPO, number: 12 })).toBe(true);
    expect(zoomSdk.openUrl).toHaveBeenCalledWith({ url: 'https://github.com/acme/arlo-app/issues/12' });
  });

  test('outside Zoom: a new tab without an opener', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(await openGithubIssue({ zoomSdk: null, inZoom: false, repo: REPO, number: 12 })).toBe(true);
    expect(open).toHaveBeenCalledWith('https://github.com/acme/arlo-app/issues/12', '_blank', 'noopener,noreferrer');
  });

  test('nothing is opened for a repository or number that gives no link, or when Zoom refuses', async () => {
    const zoomSdk = { openUrl: vi.fn(async () => { throw new Error('10015'); }) };
    expect(await openGithubIssue({ zoomSdk, inZoom: true, repo: 'evil.example/x/../y', number: 12 })).toBe(false);
    expect(zoomSdk.openUrl).not.toHaveBeenCalled();
    expect(await openGithubIssue({ zoomSdk, inZoom: true, repo: REPO, number: 12 })).toBe(false);
    expect(await openGithubIssue({ zoomSdk: {}, inZoom: true, repo: REPO, number: 12 })).toBe(false);
  });
});

test('cutText counts characters, not UTF-16 units', () => {
  expect(cutText('😀😀😀😀', 3)).toBe('😀😀…');
  expect(cutText('abc', 3)).toBe('abc');
});
