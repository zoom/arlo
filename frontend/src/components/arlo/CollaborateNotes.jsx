import React, { useEffect, useRef, useState } from 'react';
import { useZoomSdk } from '../../contexts/ZoomSdkContext';
import { useToast } from '../../contexts/ToastContext';
import Button from '../ui/Button';
import StatusLine from './StatusLine';
import NotesDocument from './NotesDocument';

const NO_NOTES_YET = 'Notes appear after the first minute or so.';

/**
 * Arlo's notes as a document, while the app runs in Zoom's Collaborate mode
 * (ZoomSdkContext `inCollaborate`): a wide page, read by everyone in the
 * meeting at once. It replaces the notes screen and the participant view for
 * as long as Collaborate lasts.
 *
 * `owner`: this person brought Arlo in. THEIR VIEW IS WHAT ZOOM SHARES AS A
 * SCREEN with people who cannot join Collaborate, so nothing private is on
 * it: no Ask Arlo (no question, no answer), no "who can ask", no sharing or
 * chat actions, and of what Arlo did only the public actions (`actions` is
 * filtered here; an owner's own private answers are in the list the server
 * gives them). The one bar has the status line, with the stream's own
 * controls, and "Close for everyone": it ends Collaborate for the meeting and
 * leaves sharing the notes as it is. The status line is told that Arlo is
 * thinking only for a request said aloud in the meeting.
 * (An approval sheet still rises over this view when a request arrives, and
 * is seen on the shared screen: it must be answerable. See ApprovalHost.)
 *
 * Everyone else reads the same page with "Leave" (out of Collaborate, for
 * this person only): no asks, no choices. `notes` is null for them unless an
 * owner shares the notes (`notesShared`).
 *
 * Zoom's error text is never shown or logged.
 */
export default function CollaborateNotes({
  owner, notes, notesShared = false, actions = null, status = null,
}) {
  const { zoomSdk } = useZoomSdk();
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /** One call of Zoom's, without arguments; a failure is said, in this screen's words. */
  const ask = async (method, failed) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (typeof zoomSdk?.[method] !== 'function') throw new Error('unsupported');
      await zoomSdk[method]();
    } catch {
      addToast(failed, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const publicActions = (Array.isArray(actions) ? actions : []).filter((action) => action?.public === true);
  const hidden = !owner && notesShared !== true;

  return (
    <div className="arlo-screen arlo-collab">
      <div className="arlo-collab-bar">
        {owner && status && (
          <StatusLine
            {...status}
            thinking={status.thinking === true && status.thinkingChannel === 'voice'}
          />
        )}
        <div className="arlo-collab-bar-actions">
          {owner ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => ask('endCollaborate', 'Couldn\'t close the notes for everyone. Try again.')}>
              Close for everyone
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => ask('leaveCollaborate', 'Couldn\'t leave. Try again.')}>
              Leave
            </Button>
          )}
        </div>
      </div>
      <div className="arlo-scroll">
        <div className="arlo-collab-page">
          <h1 className="arlo-collab-title" tabIndex={-1} data-arlo-focus>Meeting notes</h1>
          <p className="arlo-muted">Written by Arlo · updates as the meeting goes on</p>
          {hidden
            ? <p className="arlo-muted">The notes are not shared right now.</p>
            : <NotesDocument notes={notes} actions={publicActions} emptyText={NO_NOTES_YET} />}
        </div>
      </div>
    </div>
  );
}
