import React from 'react';
import { actionItemText } from '../../lib/notesText';

/**
 * The notes as one document: Summary, Decisions, Action items. A section with
 * nothing in it is not rendered. Only the summary is announced when it changes.
 */
export default function NotesDocument({ notes }) {
  const summary = typeof notes?.summary === 'string' ? notes.summary.trim() : '';
  const decisions = Array.isArray(notes?.decisions) ? notes.decisions : [];
  const actionItems = Array.isArray(notes?.actionItems) ? notes.actionItems : [];

  if (!summary && decisions.length === 0 && actionItems.length === 0) {
    return (
      <div className="arlo-notes">
        <p className="arlo-notes-empty">Arlo is listening. Notes appear after the first minute or so.</p>
      </div>
    );
  }

  return (
    <article className="arlo-notes" aria-label="Notes">
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
    </article>
  );
}
