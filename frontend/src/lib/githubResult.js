/**
 * What Arlo found or did on GitHub, as the server sends it to the owner who
 * asked (`result` of POST …/arlo/ask, or `arlo.result` on the socket), read
 * as untrusted input: an issue's title, labels and body are text anyone with
 * access to the repository wrote. The result is rebuilt here from known
 * fields; anything that is not exactly one of the three kinds is no result
 * (null) and nothing is shown. What is kept is only ever rendered as text.
 *
 *   { kind: 'github_issues', repo, total, issues: [{ number, title, labels }] }   at most 10
 *   { kind: 'github_issue', repo, issue: { number, title, state, body } }          state: 'open' | 'closed' | null
 *   { kind: 'github_issue_created', repo, number, title }
 *
 * `repo` is "owner/name" in exactly that form, and the deployment's
 * repository (the server's settings) when this panel knows it: an issue's
 * link is built from it (lib/arloActions.js `githubIssueUrl`), never taken
 * from the server.
 */
import { githubIssueUrl, githubRepoOf } from './arloActions';

export const GITHUB_RESULT_LIMITS = Object.freeze({
  title: 200, label: 50, body: 1000, issues: 10, labels: 10, chatLines: 5, chatTitle: 80, chatMessage: 1000,
});
const MAX_ISSUE_NUMBER = 9999999;
const MAX_TOTAL = 10000000;
// Text longer than this is not looked at
const MAX_RAW_CHARS = 100000;

// Never shown: invisible format characters (a direction override turns the
// text around it), private-use and unassigned characters, lone surrogates.
// The two joiners that names and emoji sequences need stay (as lib/thinkingStep.js)
const NOT_SHOWN = /(?![\u200C\u200D])[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu;
// A tab and every kind of line break: a space on one line. Other control characters go
const BREAKS = /[\t\n\v\f\r\u0085\p{Zl}\p{Zp}]/gu;
const CONTROLS = /\p{Cc}/gu;
// In a body the line break stays; every other control character goes
const BODY_CONTROLS = /(?!\n)[\p{Cc}]/gu;

/** At most `max` characters (code points), the last one "…" when something was cut. */
export function cutText(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** One line of text as it can be shown, or null: cleaned, single spaces, trimmed, cut to `max`. */
function line(value, max) {
  if (typeof value !== 'string' || value.length > MAX_RAW_CHARS) return null;
  const text = value.replace(BREAKS, ' ').replace(CONTROLS, '').replace(NOT_SHOWN, '').replace(/\s+/gu, ' ').trim();
  return text.length > 0 ? cutText(text, max) : null;
}

/** An issue's body: its lines kept, everything invisible removed, cut. '' when there is none. */
function bodyText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_RAW_CHARS) return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/[\p{Zl}\p{Zp}]/gu, '\n').replace(/\t/g, ' ')
    .replace(BODY_CONTROLS, '').replace(NOT_SHOWN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cutText(text, GITHUB_RESULT_LIMITS.body);
}

const issueNumber = (value) => (
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER ? value : null
);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function labelsOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((label) => typeof label !== 'string')) return null;
  return value.slice(0, GITHUB_RESULT_LIMITS.labels).map((label) => line(label, GITHUB_RESULT_LIMITS.label)).filter((label) => label !== null);
}

function listedIssue(value) {
  if (!isObject(value)) return null;
  const number = issueNumber(value.number);
  const title = line(value.title, GITHUB_RESULT_LIMITS.title);
  const labels = labelsOf(value.labels);
  return number === null || title === null || labels === null ? null : { number, title, labels };
}

/**
 * The result as this panel may show it, or null. `knownRepo`: the
 * deployment's repository from the server's settings (`features.github.repo`);
 * when it is one, a result about another repository is no result.
 */
export function parseGithubResult(value, knownRepo = null) {
  if (!isObject(value)) return null;
  const repo = githubRepoOf(value.repo);
  if (repo === null) return null;
  const known = githubRepoOf(knownRepo);
  if (known !== null && repo !== known) return null;

  switch (value.kind) {
    case 'github_issues': {
      if (!Array.isArray(value.issues) || value.issues.length > GITHUB_RESULT_LIMITS.issues) return null;
      const issues = value.issues.map(listedIssue);
      if (issues.some((issue) => issue === null)) return null;
      if (new Set(issues.map((issue) => issue.number)).size !== issues.length) return null;
      const { total } = value;
      if (typeof total !== 'number' || !Number.isInteger(total) || total < issues.length || total > MAX_TOTAL) return null;
      return { kind: 'github_issues', repo, total, issues };
    }
    case 'github_issue': {
      if (!isObject(value.issue)) return null;
      const number = issueNumber(value.issue.number);
      const title = line(value.issue.title, GITHUB_RESULT_LIMITS.title);
      const body = bodyText(value.issue.body);
      const state = value.issue.state ?? null;
      if (number === null || title === null || body === null) return null;
      if (state !== null && state !== 'open' && state !== 'closed') return null;
      return { kind: 'github_issue', repo, issue: { number, title, state, body } };
    }
    case 'github_issue_created': {
      const number = issueNumber(value.number);
      const title = line(value.title, GITHUB_RESULT_LIMITS.title);
      if (number === null || title === null) return null;
      return { kind: 'github_issue_created', repo, number, title };
    }
    default:
      return null;
  }
}

/** How many open issues the list does not show. */
export const issuesNotShown = (result, shown = result.issues.length) => Math.max(0, result.total - shown);

/**
 * What "Post to chat" posts for a result (already parsed), as one message of
 * at most 1000 characters; '' when there is nothing to post (an empty list, a
 * created issue). A list: its heading, up to 5 issues with the title cut to
 * 80 characters, and how many more there are. One issue: its number and
 * title, and its link, built here.
 */
export function githubResultChatMessage(result) {
  if (result?.kind === 'github_issues') {
    if (result.issues.length === 0) return '';
    const rows = result.issues.slice(0, GITHUB_RESULT_LIMITS.chatLines);
    const more = issuesNotShown(result, rows.length);
    return [
      `Open issues in ${result.repo}:`,
      ...rows.map((issue) => `#${issue.number} ${cutText(issue.title, GITHUB_RESULT_LIMITS.chatTitle)}`),
      ...(more > 0 ? [`… and ${more} more`] : []),
    ].join('\n').slice(0, GITHUB_RESULT_LIMITS.chatMessage);
  }
  if (result?.kind === 'github_issue') {
    const url = githubIssueUrl(result.repo, result.issue.number);
    if (url === null) return '';
    return `#${result.issue.number} ${result.issue.title}\n${url}`.slice(0, GITHUB_RESULT_LIMITS.chatMessage);
  }
  return '';
}

/**
 * Open an issue of a result in this person's system browser, at the URL built
 * here from the repository and the number. `inZoom`: the app runs in the
 * Zoom client, where only Zoom opens the browser. true when it was opened.
 */
export async function openGithubIssue({ zoomSdk, inZoom, repo, number }) {
  const url = githubIssueUrl(repo, number);
  if (url === null) return false;
  try {
    if (!inZoom) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
    if (typeof zoomSdk?.openUrl !== 'function') return false;
    await zoomSdk.openUrl({ url });
    return true;
  } catch {
    return false;
  }
}
