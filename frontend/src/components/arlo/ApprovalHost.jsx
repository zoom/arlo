import React, { useCallback, useEffect, useState } from 'react';
import { useArlo } from '../../contexts/ArloContext';
import { useAuth } from '../../contexts/AuthContext';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { useToast } from '../../contexts/ToastContext';
import { canControlArlo } from '../../lib/arloScreen';
import { firstShowableApproval } from '../../lib/approvalKinds';
import ApprovalSheet from './ApprovalSheet';

/** The heading of the screen that is showing, made focusable when it is not. */
function screenHeading() {
  const heading = document.querySelector('.app-main [data-arlo-focus]') ?? document.querySelector('.app-main h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}

/**
 * Where an owner is asked, whatever screen they are on while in the meeting:
 * the notes, the meeting record, Settings, Home, the classic dashboard. The
 * app shell renders it once. It shows the oldest request this panel can show
 * (ArloContext `approvals`, which only an owner in a meeting that is not over
 * holds), one at a time, in a sheet over the screen; the sheet puts the rest
 * of the app out of reach while it is open.
 *
 * While the notes are open for everyone (Zoom's Collaborate mode,
 * components/arlo/CollaborateNotes.jsx) the owner's view is on everyone's
 * screen, so the sheet is the reduced one: "Arlo needs your OK", the
 * countdown, "Not now" and "Close for everyone" (ends Collaborate). Nothing
 * of the request is on it, and it cannot be agreed to. When Collaborate has
 * ended and the request is still open, the full sheet takes its place, as a
 * sheet that has just opened.
 *
 * Several requests in a row are one run of sheets. The focus goes back to
 * where it was before the first of them when the last one closes, if that
 * element is still in the document and takes the focus; otherwise to the
 * heading of the screen.
 */
export default function ApprovalHost() {
  const { role, approvals, answerApproval } = useArlo();
  const { isAuthenticated } = useAuth();
  const { zoomSdk, inCollaborate } = useZoomSdk();
  const { addToast } = useToast();
  const reduced = inCollaborate === true;
  const closeShared = useCallback(async () => {
    try {
      if (typeof zoomSdk?.endCollaborate !== 'function') throw new Error('unsupported');
      await zoomSdk.endCollaborate();
    } catch {
      // Zoom's error text is never shown or logged
      addToast('Couldn\'t close the notes for everyone. Try again.', 'error');
    }
  }, [zoomSdk, addToast]);
  const mayAnswer = canControlArlo({ guest: !isAuthenticated, arloRole: role });
  const approval = mayAnswer ? firstShowableApproval(approvals) : null;
  const asked = approval !== null;

  // Where the focus was before this run of sheets: read while rendering, before
  // the first sheet is in the document (making the screen inert can move it)
  const [run, setRun] = useState(null);
  if (asked && run === null) setRun({ focusBefore: document.activeElement });

  // In an effect: by then the sheet that closed has given the screen back
  useEffect(() => {
    if (asked || run === null) return;
    setRun(null);
    const before = run.focusBefore;
    if (before && before !== document.body && before.isConnected && typeof before.focus === 'function') {
      before.focus();
      if (document.activeElement === before) return;
    }
    screenHeading()?.focus();
  }, [asked, run]);

  if (!asked) return null;
  // A sheet of its own per form: the full one that follows the reduced one
  // starts with its guard, and with nothing read yet
  return (
    <ApprovalSheet
      key={`${approval.id}:${reduced ? 'reduced' : 'full'}`}
      approval={approval}
      onAnswer={answerApproval}
      reduced={reduced}
      onCloseShared={closeShared}
    />
  );
}
