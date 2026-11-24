import React, { useEffect, useId, useRef, useState } from 'react';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { useToast } from '../../contexts/ToastContext';
import useSecondsLeft from '../../hooks/useSecondsLeft';
import { approvalKind } from '../../lib/approvalKinds';
import Button from '../ui/Button';

/**
 * The owner is asked: a sheet that rises over the notes with one question,
 * who asked, a primary button and "Not now". Nothing else can be done until
 * it is answered or goes away (another owner answered, or it ran out): the
 * caller makes what is behind it inert.
 *
 * Agreeing does the work here, in the owner's panel (for 'share_notes': the
 * notes are posted to the meeting chat), then reports whether it was done.
 * Nothing is ever agreed to without the click. The texts and the work come
 * from lib/approvalKinds.js; a kind that is not there renders nothing.
 *
 * `onAnswer(id, { approve, done? })` reports the answer. Mount one per
 * approval (`key={approval.id}`): the focus goes to the primary button when it
 * opens and back to where it was when it closes.
 */
export default function ApprovalSheet({ approval, notes, onAnswer }) {
  const { zoomSdk, chatSupported } = useZoomSdk();
  const { addToast } = useToast();
  const questionId = useId();
  const detailId = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const sheetRef = useRef(null);
  const primaryRef = useRef(null);
  const secondaryRef = useRef(null);
  const secondsLeft = useSecondsLeft(approval.expiresAt);
  const kind = approvalKind(approval.kind);
  const unavailable = kind ? kind.unavailable({ chatSupported }) : null;

  // The focus comes in, and goes back to where it was. In an effect, not a
  // layout effect: by then what is behind the sheet is no longer inert.
  const canAgree = unavailable === null;
  const canAgreeRef = useRef(canAgree);
  canAgreeRef.current = canAgree;
  useEffect(() => {
    const before = document.activeElement;
    (canAgreeRef.current ? primaryRef.current : secondaryRef.current)?.focus();
    return () => {
      if (before && before !== document.body && before.isConnected && typeof before.focus === 'function') before.focus();
    };
  }, []);

  if (!kind) return null;

  const answer = async (body) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    await onAnswer(approval.id, body);
  };

  const agree = async () => {
    if (busyRef.current || !canAgree) return;
    busyRef.current = true;
    setBusy(true);
    let done = false;
    try {
      done = (await kind.run({ zoomSdk, notes })) === true;
    } catch {
      // Not logged: an error may quote meeting content
    }
    addToast(done ? kind.doneToast : kind.failedToast, done ? 'success' : 'error');
    await onAnswer(approval.id, { approve: true, done });
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      answer({ approve: false });
      return;
    }
    if (event.key !== 'Tab') return;
    // Tab stays inside: from the last button to the first, and back
    const buttons = [primaryRef.current, secondaryRef.current].filter((button) => button && !button.disabled);
    if (buttons.length === 0) {
      event.preventDefault();
      return;
    }
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    const active = document.activeElement;
    if (!sheetRef.current?.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  return (
    <div
      className="arlo-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={questionId}
      aria-describedby={detailId}
      ref={sheetRef}
      onKeyDown={onKeyDown}
    >
      <p className="arlo-sheet-question" id={questionId}>{kind.question}</p>
      <p className="arlo-sheet-detail" id={detailId}>{kind.detail(approval.askedBy)}</p>
      <Button className="arlo-sheet-button" ref={primaryRef} onClick={agree} disabled={busy || !canAgree}>
        {kind.primary}
      </Button>
      {unavailable && <p className="arlo-sheet-note">{unavailable}</p>}
      <Button className="arlo-sheet-button" variant="ghost" ref={secondaryRef} onClick={() => answer({ approve: false })} disabled={busy}>
        {kind.secondary}
      </Button>
      {secondsLeft !== null && <p className="arlo-sheet-countdown">{`${secondsLeft}s`}</p>}
    </div>
  );
}
