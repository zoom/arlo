import { notesToChatMessage } from './notesText';

/**
 * Post the notes as they are now into the Zoom meeting chat, for everyone.
 * The one place the panel does this: "Post notes to chat" and the owner's
 * "Share notes" answer both come here.
 *
 * 'sent' | 'empty' (there are no notes to post, nothing was sent) | 'failed'.
 * Nothing is logged: Zoom's error may quote the message.
 */
export async function postNotesToChat(zoomSdk, notes) {
  const message = notesToChatMessage(notes);
  if (message === '') return 'empty';
  try {
    // Same call as the rest of the app (MeetingContext, useMeetingVoiceHandlers).
    // Inside try: an SDK that throws at once fails like one that rejects.
    await zoomSdk.sendMessageToChat({ message });
    return 'sent';
  } catch {
    return 'failed';
  }
}
