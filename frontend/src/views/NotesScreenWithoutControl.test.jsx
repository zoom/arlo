import { screen, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';
import {
  FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage, arloPath, ARLO_ABSENT, pastSheetGuard,
} from '../test/harness';

// The notes screen for someone who cannot control Arlo, in the real app with
// the real parts of the screen (the component test uses stand-ins).
//
// The app does not put anyone there today: only an owner gets the notes
// screen, and an owner can control Arlo. So the one rule that says who can
// (lib/arloScreen.js canControlArlo) is made to say "no" here, and everything
// else is the app as it runs. What is tested is LiveNotes' own gate: if the
// two rules ever come apart, the owner-only actions do not show.
vi.mock('../lib/arloScreen', async (importOriginal) => ({
  ...(await importOriginal()),
  canControlArlo: () => false,
}));

const NOTES = {
  summary: 'The beta moves to March 3 so billing can finish first.',
  decisions: ['Beta launch moves to March 3'],
  actionItems: [{ text: 'Send the revised timeline', owner: 'Ana' }],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const OWNER = { present: true, role: 'owner', ownerName: 'Ana', myStreamLive: true };
const ID1 = '11111111-1111-4111-8111-111111111111';

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });

afterEach(() => {
  vi.restoreAllMocks();
  resetHarness();
});

describe('the notes screen for someone who cannot control Arlo', () => {
  test.each([
    ['not shared', false],
    ['shared', true],
  ])('notes %s: no sharing switch, no "Post notes to chat", no who-can-ask, and no sheet', async (_name, notesShared) => {
    const state = { ...OWNER, notesShared };
    mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }) });
    renderInMeeting();
    await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState(state));
    await send(serverMessage.notes(NOTES));

    // the notes screen: the notes, the record link and the question input
    expect(await screen.findByRole('heading', { name: 'Your notes' })).toBeInTheDocument();
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toBeInTheDocument();

    for (const name of ['Share notes with everyone', 'Stop sharing', 'Post notes to chat', 'Change']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Shared with everyone in the meeting')).not.toBeInTheDocument();
    expect(screen.queryByText(/who can ask/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();

    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await pastSheetGuard();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toBeInTheDocument();
  });
});
