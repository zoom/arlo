import React, { useEffect, useId, useRef, useState } from 'react';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { useArlo } from '../../contexts/ArloContext';
import { useToast } from '../../contexts/ToastContext';
import { notesToChatMessage } from '../../lib/notesText';
import { startCollaborateForEveryone } from '../../lib/collaborate';
import Button from '../ui/Button';

const FAILED = 'Couldn\'t open the notes for everyone. Try again.';
const SHARED_ONLY = 'Couldn\'t open the notes for everyone. They are still shared with everyone who has Arlo open.';

/**
 * "Open notes for everyone": the owner opens Arlo's notes as a document for
 * the whole meeting (Zoom's Collaborate mode; lib/collaborate.js). Zoom opens
 * Arlo for everyone who has it and shows this person's Arlo view as a screen
 * share to the others, so the first click only asks and says so; "Open" does
 * it. The question waits for an answer: it does not time out.
 *
 * Two steps, in this order: the server turns sharing the notes on
 * (`shareNotesForOpening`, the owner's own click, so no approval sheet), then
 * this panel starts Collaborate. When the server refuses, Zoom is not asked.
 * When Zoom refuses, the notes stay shared and the message says so.
 *
 * Renders nothing when there are no notes, or when this Zoom client did not
 * take startCollaborate. Nothing is logged.
 */
export default function OpenNotesForEveryone({ notes }) {
  const { zoomSdk, collaborateSupported } = useZoomSdk();
  const { shareNotesForOpening } = useArlo();
  const { addToast } = useToast();
  const questionId = useId();
  // 'idle' | 'confirming' | 'opening'
  const [step, setStep] = useState('idle');
  const runningRef = useRef(false);
  const actionRef = useRef(null);
  const openRef = useRef(null);
  // The focus was on the question's buttons: it goes back to the action
  const followFocusRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const available = collaborateSupported === true && notesToChatMessage(notes) !== '';

  // The notes went away under an open question: nothing left to ask about
  useEffect(() => {
    if (!available && step === 'confirming') setStep('idle');
  }, [available, step]);

  useEffect(() => {
    if (step === 'confirming') {
      openRef.current?.focus();
      return;
    }
    if (step === 'idle' && followFocusRef.current) {
      followFocusRef.current = false;
      actionRef.current?.focus();
    }
  }, [step]);

  if (!available) return null;

  const leave = () => {
    followFocusRef.current = true;
    setStep('idle');
  };

  const open = async () => {
    if (step !== 'confirming' || runningRef.current) return;
    runningRef.current = true;
    setStep('opening');
    try {
      if (!(await shareNotesForOpening())) {
        addToast(FAILED, 'error');
      } else if (await startCollaborateForEveryone(zoomSdk)) {
        addToast('Notes opened for everyone', 'success');
      } else {
        addToast(SHARED_ONLY, 'error');
      }
    } finally {
      runningRef.current = false;
      if (mountedRef.current) leave();
    }
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || step !== 'confirming') return;
    event.stopPropagation();
    leave();
  };

  return (
    <div className="arlo-post">
      {step === 'idle' ? (
        <Button variant="link" size="sm" ref={actionRef} onClick={() => setStep('confirming')}>
          Open notes for everyone
        </Button>
      ) : (
        // onKeyDown: Escape from either button
        <div className="arlo-post-confirm" role="group" aria-labelledby={questionId} onKeyDown={onKeyDown}>
          <span className="arlo-post-question" id={questionId}>Everyone in the meeting will see your Arlo view. The notes stay shared until you stop sharing.</span>
          <Button variant="outline" size="sm" ref={openRef} onClick={open} disabled={step === 'opening'}>Open</Button>
          <Button variant="ghost" size="sm" onClick={leave} disabled={step === 'opening'}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
