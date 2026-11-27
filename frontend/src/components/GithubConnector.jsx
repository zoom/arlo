import React, { useEffect, useId, useRef, useState } from 'react';
import { useConnectors } from '../contexts/ConnectorsContext';
import { useToast } from '../contexts/ToastContext';
import Button from './ui/Button';

/**
 * Settings → Connectors → GitHub: whether this person's GitHub account is
 * connected, and the one action that fits. The only place the GitHub login
 * is shown (a meeting view can be on everyone's screen).
 *
 * "Connect GitHub" sends the system browser to GitHub's sign-in
 * (lib/connectGithub.js); the row reads "Finish in your browser…" until the
 * server says the connectors changed, the panel is looked at again, or five
 * minutes passed. "Disconnect" asks first, in the row.
 *
 * Renders nothing until the server has said how things stand.
 */
export default function GithubConnector() {
  const { github, githubConnect, connectGithub, disconnectGithub } = useConnectors();
  const { addToast } = useToast();
  const questionId = useId();
  // 'idle' | 'confirming' | 'disconnecting'
  const [step, setStep] = useState('idle');
  const confirmRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const connected = github?.connected === true;
  // Disconnected meanwhile (somewhere else): nothing left to ask about
  useEffect(() => {
    if (!connected && step === 'confirming') setStep('idle');
  }, [connected, step]);
  useEffect(() => {
    if (step === 'confirming') confirmRef.current?.focus();
  }, [step]);

  if (!github) return null;

  const connect = async () => {
    const went = await connectGithub();
    if (went === 'failed') addToast('Couldn\'t connect GitHub. Try again.', 'error');
    if (went === 'refused') addToast('Zoom could not open the browser.', 'error');
  };

  const disconnect = async () => {
    if (step !== 'confirming') return;
    setStep('disconnecting');
    const done = await disconnectGithub();
    addToast(done ? 'GitHub disconnected' : 'Couldn\'t disconnect GitHub. Try again.', done ? 'success' : 'error');
    if (mountedRef.current) setStep('idle');
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || step !== 'confirming') return;
    event.stopPropagation();
    setStep('idle');
  };

  let status;
  let action = null;
  if (!github.available) {
    status = 'GitHub is not set up on this server.';
  } else if (connected) {
    status = github.login ? `Connected as ${github.login}` : 'Connected';
    action = step === 'idle' ? (
      <Button variant="outline" size="sm" onClick={() => setStep('confirming')}>Disconnect</Button>
    ) : (
      // onKeyDown: Escape from either button
      <div className="settings-connector-confirm" role="group" aria-labelledby={questionId} onKeyDown={onKeyDown}>
        <span className="text-sans text-sm" id={questionId}>Disconnect GitHub?</span>
        <Button variant="outline" size="sm" ref={confirmRef} onClick={disconnect} disabled={step === 'disconnecting'}>Disconnect</Button>
        <Button variant="ghost" size="sm" onClick={() => setStep('idle')} disabled={step === 'disconnecting'}>Cancel</Button>
      </div>
    );
  } else if (githubConnect === 'waiting') {
    status = 'Finish in your browser…';
  } else {
    status = githubConnect === 'timeout' ? 'That took too long. Try again.' : 'Not connected';
    action = (
      <Button variant="outline" size="sm" onClick={connect} disabled={githubConnect === 'starting'}>Connect GitHub</Button>
    );
  }

  return (
    <div className="settings-connector-row">
      <div className="settings-toggle-text">
        <p className="text-sans font-medium">GitHub</p>
        <p className="text-sans text-sm text-muted" role="status">{status}</p>
      </div>
      {action}
    </div>
  );
}
