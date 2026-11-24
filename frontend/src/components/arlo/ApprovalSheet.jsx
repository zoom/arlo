import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useToast } from '../../contexts/ToastContext';
import useSecondsLeft from '../../hooks/useSecondsLeft';
import { approvalTexts } from '../../lib/approvalKinds';
import { makeOutsideInert } from '../../lib/outsideInert';
import Button from '../ui/Button';
import './ApprovalSheet.css';

/** How long after it opens the sheet takes no answer, from a button or from Escape. */
export const SHEET_GUARD_MS = 700;

// How close to its end the text counts as scrolled to the end (rounding of zoomed layouts)
const END_SLACK_PX = 2;

/**
 * The owner is asked: a sheet that rises over the screen with one question,
 * who asked, a primary button and "Not now". Nothing else can be done until
 * it is answered or goes away (another owner answered, or it ran out).
 *
 * Agreeing reports the answer; the server does the work (for 'share_notes':
 * it shares the notes with everyone in the meeting who has Arlo open), and
 * the owner is told whether it did. For something Arlo was asked to do
 * ('agent_action') the texts are the server's, shown whole, and agreeing is
 * all the panel does: the server runs it. The texts come from
 * lib/approvalKinds.js; an approval it has none for renders nothing.
 *
 * The owner approves exactly what they see. Text that will be posted (`body`)
 * is shown in full in its own box, which scrolls when it is long; the primary
 * button stays disabled until that box is on screen and, when the text is
 * taller than the box, until it has been scrolled to its end once. Under it:
 * who asked, as far as the server knows, and what they asked.
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
 * `inert`, Tab goes round the sheet's stops only (the text that will be
 * posted, then the buttons), focus that lands outside comes back, and a click
 * outside does nothing.
 *
 * `onAnswer(id, { approve })` reports the answer and resolves true when the
 * server took it. Mount one per approval (`key={approval.id}`). Where the
 * focus goes when the last sheet closes is ApprovalHost's business.
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
  const bodyRef = useRef(null);
  const secondsLeft = useSecondsLeft(approval.expiresAt);
  const kind = approvalTexts(approval);
  const body = kind?.body ?? null;
  // The whole of what will be posted has been on screen. Nothing to see: true
  const [bodySeen, setBodySeen] = useState(body === null);
  const bodySeenRef = useRef(bodySeen);

  /** True when an answer may be given now: past the guard, and none on its way. */
  const takesAnswer = () => armedRef.current && !busyRef.current;

  // The text's box shows its end: all of it fits, or it was scrolled there
  const noteBodyEnd = useCallback(() => {
    const box = bodyRef.current;
    if (!box || bodySeenRef.current) return;
    if (box.scrollTop + box.clientHeight < box.scrollHeight - END_SLACK_PX) return;
    bodySeenRef.current = true;
    setBodySeen(true);
  }, []);
  // Measured once it is laid out, and again when its box changes size (a
  // panel made wider can make all of it fit)
  useLayoutEffect(() => {
    const box = bodyRef.current;
    if (!box) return undefined;
    noteBodyEnd();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(noteBodyEnd);
    observer.observe(box);
    return () => observer.disconnect();
  }, [noteBodyEnd]);

  const decline = async () => {
    if (!takesAnswer()) return;
    busyRef.current = true;
    setBusy(true);
    await onAnswer(approval.id, { approve: false });
  };
  const declineRef = useRef(decline);
  declineRef.current = decline;

  const agree = async () => {
    if (!takesAnswer() || !kind || !bodySeenRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let done = false;
    try {
      done = (await onAnswer(approval.id, { approve: true })) === true;
    } catch {
      // Not logged: an error may quote meeting content
    }
    const toast = done ? kind.doneToast : kind.failedToast;
    if (toast) addToast(toast, done ? 'success' : 'error');
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
        // Space scrolls the text that will be posted
        if (event.key === ' ' && bodyRef.current !== null && event.target === bodyRef.current) return;
        // Only a button of the sheet takes these, and not before it takes an answer
        const onButton = inside && event.target !== sheet && event.target.closest('button') !== null;
        if (!onButton || !armedRef.current) event.preventDefault();
        if (!inside) event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;
      // Tab goes round the sheet's stops: the text that will be posted, then the buttons
      const buttons = [bodyRef.current, primaryRef.current, secondaryRef.current].filter((stop) => stop && !stop.disabled);
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

  // The focus comes to the sheet
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

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
      <h2 className="arlo-sheet-question" id={questionId}>{kind.question}</h2>
      {body !== null && (
        <div
          className="arlo-sheet-body"
          role="region"
          aria-label="What will be posted"
          tabIndex={0}
          ref={bodyRef}
          onScroll={noteBodyEnd}
        >
          {body}
        </div>
      )}
      <p className="arlo-sheet-detail" id={detailId}>{kind.detail}</p>
      {kind.request !== null && <p className="arlo-sheet-request">{`They asked: \u201c${kind.request}\u201d`}</p>}
      {!bodySeen && <p className="arlo-sheet-hint">Scroll to the end of the message to continue.</p>}
      <div className="arlo-sheet-buttons">
        <Button className="arlo-sheet-button" ref={primaryRef} onClick={agree} disabled={busy || !bodySeen}>
          {kind.primary}
        </Button>
        <Button className="arlo-sheet-button" variant="ghost" ref={secondaryRef} onClick={decline} disabled={busy}>
          {kind.secondary}
        </Button>
      </div>
      {secondsLeft !== null && <p className="arlo-sheet-countdown">{`${secondsLeft}s`}</p>}
    </div>
  );
}
