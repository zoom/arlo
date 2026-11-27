import React, { useEffect, useId, useRef, useState } from 'react';
import { useArlo } from '../../contexts/ArloContext';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { useToast } from '../../contexts/ToastContext';
import { githubResultChatMessage, issuesNotShown, openGithubIssue } from '../../lib/githubResult';
import Button from '../ui/Button';

const STATES = Object.freeze({ open: 'Open', closed: 'Closed' });

/**
 * "Post to chat" under a result: everyone in the meeting sees the message and
 * it cannot be taken back, so the first click only asks; "Post" sends (as
 * components/arlo/PostNotesToChat.jsx does for the notes). What is posted is
 * text this panel built from the result the owner sees. Never logged.
 */
function PostResultToChat({ message }) {
  const { zoomSdk } = useZoomSdk();
  const { addToast } = useToast();
  const questionId = useId();
  // 'idle' | 'confirming' | 'sending' | 'posted'
  const [step, setStep] = useState('idle');
  const postRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (step === 'confirming') postRef.current?.focus();
  }, [step]);

  const post = async () => {
    if (step !== 'confirming') return;
    setStep('sending');
    let sent = false;
    try {
      // Same call as lib/postNotes.js
      await zoomSdk.sendMessageToChat({ message });
      sent = true;
    } catch {
      // Not logged: Zoom's error may quote the message
    }
    addToast(sent ? 'Posted to the chat' : 'Couldn\'t post to the chat. Try again.', sent ? 'success' : 'error');
    if (mountedRef.current) setStep(sent ? 'posted' : 'idle');
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || step !== 'confirming') return;
    event.stopPropagation();
    setStep('idle');
  };

  return (
    <div className="arlo-post">
      <span className="arlo-post-status" role="status">{step === 'posted' ? 'Posted to chat just now' : ''}</span>
      {step === 'idle' && (
        <Button variant="link" size="sm" onClick={() => setStep('confirming')}>Post to chat</Button>
      )}
      {(step === 'confirming' || step === 'sending') && (
        // onKeyDown: Escape from either button
        <div className="arlo-post-confirm" role="group" aria-labelledby={questionId} onKeyDown={onKeyDown}>
          <span className="arlo-post-question" id={questionId}>Post this to everyone in the chat?</span>
          <Button variant="outline" size="sm" ref={postRef} onClick={post} disabled={step === 'sending'}>Post</Button>
          <Button variant="ghost" size="sm" onClick={() => setStep('idle')} disabled={step === 'sending'}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

/**
 * What Arlo last found or did on GitHub for this owner (ArloContext
 * `githubResult`, already checked and cleaned by lib/githubResult.js): a list
 * of open issues, one issue, or the issue it created. Private to the owner:
 * rendered on the notes screen only, never in the Collaborate view, the
 * participant view or the meeting record.
 *
 * Everything from GitHub is rendered as text. An issue opens in the system
 * browser at a link this panel builds from the repository and the number.
 * A new result replaces this one; "Close" takes it away.
 */
export default function GithubResult() {
  const { githubResult: result, dismissGithubResult } = useArlo();
  const { zoomSdk, chatSupported, isTestMode } = useZoomSdk();
  const { addToast } = useToast();
  if (!result) return null;

  const open = async (number) => {
    const opened = await openGithubIssue({ zoomSdk, inZoom: !isTestMode, repo: result.repo, number });
    if (!opened) addToast(isTestMode ? 'Couldn\'t open the issue. Try again.' : 'Zoom could not open the browser.', 'error');
  };
  const issueLink = (number, title) => (
    <Button className="arlo-github-issue" variant="link" size="sm" onClick={() => open(number)}>
      {`#${number} ${title}`}
    </Button>
  );

  const message = chatSupported ? githubResultChatMessage(result) : '';
  let content;
  if (result.kind === 'github_issues') {
    const more = issuesNotShown(result);
    content = result.issues.length === 0 ? (
      <p className="arlo-github-heading">{`No open issues in ${result.repo}.`}</p>
    ) : (
      <>
        <h2 className="arlo-github-heading">{`Open issues in ${result.repo}`}</h2>
        <ul className="arlo-github-list">
          {result.issues.map((issue) => (
            <li key={issue.number}>
              {issueLink(issue.number, issue.title)}
              {issue.labels.length > 0 && <span className="arlo-github-labels">{issue.labels.join(' · ')}</span>}
            </li>
          ))}
        </ul>
        {more > 0 && <p className="arlo-github-more">{`… and ${more} more`}</p>}
      </>
    );
  } else if (result.kind === 'github_issue') {
    const { issue } = result;
    content = (
      <>
        {issueLink(issue.number, issue.title)}
        {issue.state !== null && <p className="arlo-github-labels">{STATES[issue.state]}</p>}
        {issue.body !== '' && <p className="arlo-github-body">{issue.body}</p>}
      </>
    );
  } else {
    content = (
      <p className="arlo-github-created">
        <span>Created issue </span>
        {issueLink(result.number, result.title)}
      </p>
    );
  }

  return (
    <section className="arlo-github" aria-label="From GitHub">
      <div aria-live="polite">{content}</div>
      <div className="arlo-ask-answer-foot">
        <span className="arlo-muted">Only you see this.</span>
        <span className="arlo-github-actions">
          {/* A new result is another thing to post: its own question, its own "posted" */}
          {message !== '' && <PostResultToChat key={message} message={message} />}
          <Button variant="link" size="sm" onClick={dismissGithubResult}>Close</Button>
        </span>
      </div>
    </section>
  );
}
