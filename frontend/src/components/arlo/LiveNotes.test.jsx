import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const show = (canControl, extra = {}) => render(
  <MemoryRouter>
    <LiveNotes
      {...extra}
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

  test('someone who can control Arlo shares the notes with everyone: one button, next to the record link', async () => {
    const onShareNotesChange = vi.fn(async () => true);
    show(true, { notesShared: false, onShareNotesChange });
    const share = screen.getByRole('button', { name: 'Share notes with everyone' });
    expect(share.closest('.arlo-notes-actions')).toContainElement(screen.getByRole('link', { name: 'Meeting record' }));
    expect(screen.queryByText('Shared with everyone in the meeting')).not.toBeInTheDocument();
    await userEvent.click(share);
    expect(onShareNotesChange).toHaveBeenCalledTimes(1);
    expect(onShareNotesChange).toHaveBeenCalledWith(true);
  });

  test('while they are shared it says so, and the button stops it', async () => {
    const onShareNotesChange = vi.fn(async () => true);
    show(true, { notesShared: true, onShareNotesChange });
    expect(screen.getByText('Shared with everyone in the meeting').closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Share notes with everyone' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    expect(onShareNotesChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Post notes to chat' })).toBeInTheDocument();
  });

  test.each([false, true])('someone who cannot control Arlo has no sharing control (shared: %s)', (notesShared) => {
    show(false, { notesShared, onShareNotesChange: () => {} });
    expect(screen.queryByRole('button', { name: 'Share notes with everyone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument();
    expect(screen.queryByText('Shared with everyone in the meeting')).not.toBeInTheDocument();
  });
});
