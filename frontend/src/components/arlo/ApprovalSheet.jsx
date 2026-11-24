import React, { useEffect, useId, useRef, useState } from 'react';
import { useToast } from '../../contexts/ToastContext';
import useSecondsLeft from '../../hooks/useSecondsLeft';
import { approvalKind } from '../../lib/approvalKinds';
import { makeOutsideInert } from '../../lib/outsideInert';
import Button from '../ui/Button';

/** How long after it opens the sheet takes no answer, from a button or from Escape. */
export const SHEET_GUARD_MS = 700;

/**
 * The owner is asked: a sheet that rises over the notes with one question,
 * who asked, a primary button and "Not now". Nothing else can be done until
 * it is answered or goes away (another owner answered, or it ran out).
 *
 * Agreeing reports the answer; the server does the work (for 'share_notes':
 * it shares the notes with everyone in the meeting who has Arlo open), and
 * the owner is told whether it did. The texts come from lib/approvalKinds.js;
 * a kind that is not there renders nothing.
 *
 * Nothing is ever agreed to without a deliberate act. The sheet can open
 * while the owner is typing or clicking somewhere else, so:
 * - the focus goes to the sheet itself, never to a button: Enter or Space
 *   there does nothing, Tab reaches the buttons;
 * - for the first SHEET_GUARD_MS the buttons and Escape do nothing, so a key
 *   or a click already on its way cannot answer. A timer started when the
 *   sheet opens says when that is over, not a clock.
 * - Escape is "Not now" wherever the focus is.
 *
 * While it is open everything outside it is out of reach: `inert` and hidden
 * from assistive technology (lib/outsideInert.js), and, for a browser without
 * `inert`, Tab goes round the sheet's buttons only, focus that lands outside
 * comes back, and a click outside does nothing.
 *
 * `onAnswer(id, { approve })` reports the answer and resolves true when the
 * server took it. Mount one per approval (`key={approval.id}`): the focus
 * goes back to where it was when it closes.
 */
export default function ApprovalSheet({ approval, onAnswer }) {
  const { addToast } = useToast();
  const questionId = useId();
  const detailId = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const armedRef = useRef(false);
  const sheetRef = useRef(null);
  const primaryRef = useRef(null);
  const secondaryRef = useRef(null);
  // Where the focus was, read before the sheet is in the document: making the
  // screen behind it inert can take the focus away from there
  const [focusBefore] = useState(() => document.activeElement);
  const secondsLeft = useSecondsLeft(approval.expiresAt);
  const kind = approvalKind(approval.kind);

  /** True when an answer may be given now: past the guard, and none on its way. */
  const takesAnswer = () => armedRef.current && !busyRef.current;

  const decline = async () => {
    if (!takesAnswer()) return;
    busyRef.current = true;
    setBusy(true);
    await onAnswer(approval.id, { approve: false });
  };
  const declineRef = useRef(decline);
  declineRef.current = decline;

  const agree = async () => {
    if (!takesAnswer() || !kind) return;
    busyRef.current = true;
    setBusy(true);
    let done = false;
    try {
      done = (await onAnswer(approval.id, { approve: true })) === true;
    } catch {
      // Not logged: an error may quote meeting content
    }
    addToast(done ? kind.doneToast : kind.failedToast, done ? 'success' : 'error');
  };

  useEffect(() => {
    const timer = setTimeout(() => { armedRef.current = true; }, SHEET_GUARD_MS);
    return () => clearTimeout(timer);
  }, []);

  // Everything outside is out of reach while the sheet is open. Before the
  // focus effect: on closing, the outside is in reach again before the focus
  // goes back to it.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return undefined;
    const release = makeOutsideInert(sheet);

    const onKeyDown = (event) => {
      const inside = sheet.contains(event.target);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        declineRef.current();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        // Only a button of the sheet takes these, and not before it takes an answer
        const onButton = inside && event.target !== sheet && event.target.closest('button') !== null;
        if (!onButton || !armedRef.current) event.preventDefault();
        if (!inside) event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;
      // Tab goes round the sheet's buttons
      const buttons = [primaryRef.current, secondaryRef.current].filter((button) => button && !button.disabled);
      event.preventDefault();
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement);
      const step = event.shiftKey ? -1 : 1;
      const next = at === -1 ? (event.shiftKey ? buttons.length - 1 : 0) : (at + step + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    const onFocusIn = (event) => {
      if (!sheet.contains(event.target)) sheet.focus();
    };
    const onClick = (event) => {
      if (sheet.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('click', onClick, true);
      release();
    };
  }, []);

  // The focus comes to the sheet, and goes back to where it was. In an effect,
  // not a layout effect: by then what is behind the sheet is no longer inert.
  useEffect(() => {
    sheetRef.current?.focus();
    return () => {
      const before = focusBefore;
      if (before && before !== document.body && before.isConnected && typeof before.focus === 'function') before.focus();
    };
  }, [focusBefore]);

  if (!kind) return null;

  return (
    <div
      className="arlo-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={questionId}
      aria-describedby={detailId}
      tabIndex={-1}
      ref={sheetRef}
    >
      <p className="arlo-sheet-question" id={questionId}>{kind.question}</p>
      <p className="arlo-sheet-detail" id={detailId}>{kind.detail(approval.askedBy)}</p>
      <Button className="arlo-sheet-button" ref={primaryRef} onClick={agree} disabled={busy}>
        {kind.primary}
      </Button>
      <Button className="arlo-sheet-button" variant="ghost" ref={secondaryRef} onClick={decline} disabled={busy}>
        {kind.secondary}
      </Button>
      {secondsLeft !== null && <p className="arlo-sheet-countdown">{`${secondsLeft}s`}</p>}
    </div>
  );
}
