import React from 'react';
import { actionItemText } from '../../lib/notesText';
import { doneActions } from '../../lib/arloDid';
import ArloDid from './ArloDid';

/**
 * The notes as one document: Summary, Decisions, Action items. A section with
 * nothing in it is not rendered. Only the summary is announced when it changes.
 * `listening` is false when Arlo is not in the meeting (it left, or is on its way back).
 * `actions`: what Arlo was asked and did (ArloContext `actions`); the ones that
 * were done are listed last, under "Arlo did", also before the first notes.
 * `emptyText`: what stands in for notes that are not written yet, when the
 * screen has its own words for it.
 */
export default function NotesDocument({ notes, listening = true, actions = null, emptyText = null }) {
  const summary = typeof notes?.summary === 'string' ? notes.summary.trim() : '';
  const decisions = Array.isArray(notes?.decisions) ? notes.decisions : [];
  const actionItems = Array.isArray(notes?.actionItems) ? notes.actionItems : [];

  const empty = !summary && decisions.length === 0 && actionItems.length === 0;
  const did = doneActions(actions).length > 0;
  const nothingYet = emptyText ?? (listening ? 'Arlo is listening. Notes appear after the first minute or so.' : 'No notes yet.');

  if (empty && !did) {
    return (
      <div className="arlo-notes">
        <p className="arlo-notes-empty">
          {nothingYet}
        </p>
      </div>
    );
  }

  return (
    <article className="arlo-notes" aria-label="Notes">
      {empty && (
        <p className="arlo-notes-empty">
          {nothingYet}
        </p>
      )}
      {summary && (
        <section>
          <h2 className="arlo-notes-heading">Summary</h2>
          <p aria-live="polite">{summary}</p>
        </section>
      )}
      {decisions.length > 0 && (
        <section>
          <h2 className="arlo-notes-heading">Decisions</h2>
          <ul>
            {decisions.map((decision, index) => (
              <li key={`${index}-${decision}`}>{decision}</li>
            ))}
          </ul>
        </section>
      )}
      {actionItems.length > 0 && (
        <section>
          <h2 className="arlo-notes-heading">Action items</h2>
          <ul>
            {actionItems.map((item, index) => (
              <li key={`${index}-${item.text}`}>{actionItemText(item)}</li>
            ))}
          </ul>
        </section>
      )}
      <ArloDid actions={actions} />
    </article>
  );
}
