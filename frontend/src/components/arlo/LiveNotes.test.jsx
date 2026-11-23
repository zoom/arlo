import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import LiveNotes from './LiveNotes';

// What LiveNotes itself decides: which of its parts someone who cannot control
// Arlo gets. The parts are stand-ins; each has tests of its own.
vi.mock('./StatusLine', () => ({ default: ({ canControl }) => <div data-testid="status-line" data-can-control={String(canControl)} /> }));
vi.mock('./NotesDocument', () => ({ default: () => <div data-testid="notes-document" /> }));
vi.mock('./AskArlo', () => ({ default: () => <div data-testid="ask-arlo" /> }));
vi.mock('./WhoCanAsk', () => ({ default: () => <div data-testid="who-can-ask" /> }));
vi.mock('./PostNotesToChat', () => ({ default: () => <button type="button">Post notes to chat</button> }));

const NOTES = { summary: 'The beta moves to March 3.', decisions: [], actionItems: [], updatedAt: '2026-11-23T12:00:00.000Z', throughSeqNo: 3 };

const show = (canControl) => render(
  <MemoryRouter>
    <LiveNotes
      notes={NOTES}
      present
      paused={false}
      myStreamPaused={false}
      myStreamLive={canControl}
      canControl={canControl}
      recordPath="/meeting/M/record"
      whoCanAsk="owner"
      onWhoCanAskChange={() => {}}
    />
  </MemoryRouter>,
);

describe('LiveNotes', () => {
  test('someone who can control Arlo gets "Post notes to chat" and the who-can-ask setting', () => {
    show(true);
    expect(screen.getByRole('button', { name: 'Post notes to chat' })).toBeInTheDocument();
    expect(screen.getByTestId('who-can-ask')).toBeInTheDocument();
    expect(screen.getByTestId('status-line')).toHaveAttribute('data-can-control', 'true');
  });

  test('someone who cannot (a guest, or not an owner) gets neither: posting to everyone is the owner\'s call', () => {
    show(false);
    expect(screen.queryByRole('button', { name: 'Post notes to chat' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('who-can-ask')).not.toBeInTheDocument();
    // the notes, the record link and the question input are still there
    expect(screen.getByTestId('notes-document')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();
    expect(screen.getByTestId('ask-arlo')).toBeInTheDocument();
    expect(screen.getByTestId('status-line')).toHaveAttribute('data-can-control', 'false');
  });
});
