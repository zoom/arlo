import { notesToChatMessage } from './notesText';

/**
 * Post the notes as they are now into the Zoom meeting chat, for everyone.
 * The one place the panel does this: the owner's "Post notes to chat", a
 * one-time copy. (Sharing the notes with everyone is something else: they are
 * live in every panel, see ArloContext `setShareNotes`.)
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
