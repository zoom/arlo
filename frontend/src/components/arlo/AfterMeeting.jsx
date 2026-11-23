import React from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../contexts/ToastContext';
import { notesToText } from '../../lib/notesText';
import Button from '../ui/Button';
import NotesDocument from './NotesDocument';

/** The meeting has ended: the same notes, now the meeting's page, with one action. */
export default function AfterMeeting({ title, notes, demoMode, recordPath }) {
  const { addToast } = useToast();

  const copyNotes = async () => {
    try {
      await navigator.clipboard.writeText(notesToText(notes, { title }));
      addToast('Notes copied', 'success');
    } catch {
      // No clipboard in this webview, or permission refused
      addToast('Could not copy the notes', 'error');
    }
  };

  return (
    <div className="arlo-screen">
      <h1 className="arlo-title arlo-after-title">{title}</h1>
      <div className="arlo-scroll">
        <NotesDocument notes={notes} />
      </div>
      {demoMode && <p className="arlo-muted">Demo mode: meetings and notes are not stored.</p>}
      <Link className="arlo-link" to={recordPath}>Meeting record</Link>
      <Button onClick={copyNotes}>Copy notes</Button>
    </div>
  );
}
