import React, { useEffect, useState } from 'react';
import { useArlo } from '../../contexts/ArloContext';
import { useAuth } from '../../contexts/AuthContext';
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
 * Several requests in a row are one run of sheets. The focus goes back to
 * where it was before the first of them when the last one closes, if that
 * element is still in the document and takes the focus; otherwise to the
 * heading of the screen.
 */
export default function ApprovalHost() {
  const { role, approvals, answerApproval } = useArlo();
  const { isAuthenticated } = useAuth();
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
  return <ApprovalSheet key={approval.id} approval={approval} onAnswer={answerApproval} />;
}
