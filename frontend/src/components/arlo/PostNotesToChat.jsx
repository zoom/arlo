import React, { useEffect, useId, useRef, useState } from 'react';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { useToast } from '../../contexts/ToastContext';
import { notesToChatMessage } from '../../lib/notesText';
import { postNotesToChat } from '../../lib/postNotes';
import Button from '../ui/Button';

// How long "Posted to chat just now" stands in for the action, so the notes
// are not posted twice by accident
const POSTED_MS = 30000;

/**
 * "Post notes to chat": the owner posts the notes as they are now into the
 * Zoom meeting chat. Everyone in the meeting sees the message and it cannot be
 * taken back, so the first click only asks; "Post" sends. The question waits
 * for an answer: it does not time out.
 *
 * Renders nothing when there are no notes to post, or when this Zoom client
 * has no sendMessageToChat. The notes text is never logged.
 */
export default function PostNotesToChat({ notes }) {
  const { zoomSdk, chatSupported } = useZoomSdk();
  const { addToast } = useToast();
  const questionId = useId();
  // 'idle' | 'confirming' | 'sending' | 'posted'
  const [step, setStep] = useState('idle');
  const rootRef = useRef(null);
  const actionRef = useRef(null);
  const postRef = useRef(null);
  const statusRef = useRef(null);
  // The focus was on what the last step showed: it follows to what replaces it
  const followFocusRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const message = notesToChatMessage(notes);
  const available = chatSupported && message !== '';

  // The notes went away under an open question: nothing left to ask about
  useEffect(() => {
    if (!available && step === 'confirming') setStep('idle');
  }, [available, step]);

  useEffect(() => {
    if (step !== 'posted') return undefined;
    const timer = setTimeout(() => {
      followFocusRef.current = document.activeElement === statusRef.current;
      setStep('idle');
    }, POSTED_MS);
    return () => clearTimeout(timer);
  }, [step]);

  useEffect(() => {
    if (step === 'confirming') {
      postRef.current?.focus();
      return;
    }
    if (!followFocusRef.current) return;
    if (step === 'idle') actionRef.current?.focus();
    if (step === 'posted') statusRef.current?.focus();
    if (step !== 'sending') followFocusRef.current = false;
  }, [step]);

  if (!available) return null;

  const leave = (next) => {
    const active = document.activeElement;
    followFocusRef.current = active === document.body || rootRef.current?.contains(active) === true;
    setStep(next);
  };

  const post = async () => {
    if (step !== 'confirming' || !message) return;
    setStep('sending');
    const sent = (await postNotesToChat(zoomSdk, notes)) === 'sent';
    addToast(sent ? 'Notes posted to the chat' : 'Couldn\'t post to the chat. Try again.', sent ? 'success' : 'error');
    if (mountedRef.current) leave(sent ? 'posted' : 'idle');
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || step !== 'confirming') return;
    event.stopPropagation();
    leave('idle');
  };

  const asking = step === 'confirming' || step === 'sending';

  return (
    <div className="arlo-post" ref={rootRef}>
      {/* Always here, so a screen reader hears the text when it appears */}
      <span className="arlo-post-status" role="status" tabIndex={-1} ref={statusRef}>
        {step === 'posted' ? 'Posted to chat just now' : ''}
      </span>
      {step === 'idle' && (
        <Button variant="link" size="sm" ref={actionRef} onClick={() => setStep('confirming')}>
          Post notes to chat
        </Button>
      )}
      {asking && (
        // onKeyDown: Escape from either button
        <div className="arlo-post-confirm" role="group" aria-labelledby={questionId} onKeyDown={onKeyDown}>
          <span className="arlo-post-question" id={questionId}>Post these notes to everyone in the chat?</span>
          <Button variant="outline" size="sm" ref={postRef} onClick={post} disabled={step === 'sending'}>Post</Button>
          <Button variant="ghost" size="sm" onClick={() => leave('idle')} disabled={step === 'sending'}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
