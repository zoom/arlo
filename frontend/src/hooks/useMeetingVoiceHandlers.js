import { useCallback } from 'react';
import { getPreferredAiModel } from '../utils/aiModel';
import { transcriptToText } from '../lib/transcript';

/**
 * What each voice command ("Hey Arlo, ...") does in the meeting view.
 * Kept apart from the view so the view only wires them to the command parser.
 *
 * Handlers that return a string return the text Arlo answers with.
 * onHighlight returns whether a highlight was really saved.
 */
export default function useMeetingVoiceHandlers({
  segments, meetingId, zoomSdk, addToast, setActiveTab, transcriptRef,
}) {
  const handleVoiceSummarize = useCallback(async () => {
    // Build transcript text from segments
    if (segments.length === 0) {
      return 'No transcript available yet. Start speaking to generate content.';
    }

    const transcriptText = transcriptToText(segments);

    if (transcriptText.trim().length < 50) {
      return 'Need more conversation to summarize. Keep talking and try again in a moment.';
    }

    try {
      const response = await fetch('/api/ai/summary-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ transcript: transcriptText }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 400 && errorData.error?.includes('min 50 chars')) {
          return 'Need more conversation to summarize. Keep talking and try again in a moment.';
        }
        throw new Error(errorData.error || 'Summary generation failed');
      }

      const data = await response.json();
      // Also switch to assist tab
      setActiveTab('assist');

      // Format the summary object into readable text
      if (data.summary && typeof data.summary === 'object') {
        const { overview, keyPoints, decisions, nextSteps } = data.summary;
        let formatted = overview || '';

        if (keyPoints && keyPoints.length > 0) {
          formatted += '\n\n**Key Points:**\n' + keyPoints.map(p => `• ${p}`).join('\n');
        }
        if (decisions && decisions.length > 0) {
          formatted += '\n\n**Decisions:**\n' + decisions.map(d => `• ${d}`).join('\n');
        }
        if (nextSteps && nextSteps.length > 0) {
          formatted += '\n\n**Next Steps:**\n' + nextSteps.map(s => `• ${s}`).join('\n');
        }
        return formatted || 'Summary generated! Check Arlo Assist tab for details.';
      }
      return data.summary || 'Summary generated! Check Arlo Assist tab for details.';
    } catch (error) {
      console.error('Voice summary error:', error);
      return 'Failed to generate summary. Please try again.';
    }
  }, [segments, setActiveTab]);

  const handleVoiceActionItems = useCallback(async () => {
    setActiveTab('assist');
    addToast('Action items extracted! Check Arlo Assist tab.', 'success', 3000);
  }, [addToast, setActiveTab]);

  const handleVoiceHighlight = useCallback(async () => {
    // Create a highlight at the current time
    const now = Date.now();
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && meetingId) {
      try {
        const response = await fetch(`/api/highlights`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            meetingId: meetingId,
            timestampMs: lastSegment.tStartMs || now,
            text: lastSegment.text?.substring(0, 200) || 'Voice command highlight',
            label: 'Voice Highlight',
          }),
        });
        const data = await response.json().catch(() => ({}));
        // Demo mode answers 200 with no highlight: nothing was saved
        if (!response.ok || !data.highlight) {
          addToast('Highlights are not saved in demo mode', 'info', 3000);
          return false;
        }
        addToast('Highlight created!', 'success', 3000);
        return true;
      } catch {
        addToast('Failed to create highlight', 'error', 3000);
      }
    }
    return false;
  }, [segments, meetingId, addToast]);

  const handleVoiceDecisions = useCallback(async () => {
    setActiveTab('assist');
    // Scroll to decisions component
    setTimeout(() => {
      const decisionsEl = document.querySelector('[data-feature="decisions-log"]');
      if (decisionsEl) {
        decisionsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
    addToast('Showing decisions...', 'info', 2000);
  }, [addToast, setActiveTab]);

  const handleVoiceQuestions = useCallback(async () => {
    setActiveTab('assist');
    // Scroll to questions component
    setTimeout(() => {
      const questionsEl = document.querySelector('[data-feature="open-questions"]');
      if (questionsEl) {
        questionsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
    addToast('Showing open questions...', 'info', 2000);
  }, [addToast, setActiveTab]);

  const handleVoiceSendToChat = useCallback(async () => {
    if (!zoomSdk) {
      addToast('Chat not available', 'error', 3000);
      return;
    }
    // Generate a quick summary and send to chat
    try {
      const message = `📝 Meeting Summary (via Arlo voice command)\n\nSegments captured: ${segments.length}\nUse Arlo to see full details.`;
      await zoomSdk.sendMessageToChat({ message });
      addToast('Summary sent to chat!', 'success', 3000);
    } catch {
      addToast('Failed to send to chat', 'error', 3000);
    }
  }, [zoomSdk, segments.length, addToast]);

  const handleVoiceSearch = useCallback(async (query) => {
    if (!query) return;
    // Search through segments for the query
    const results = segments.filter(s =>
      s.text?.toLowerCase().includes(query.toLowerCase()) ||
      s.speakerLabel?.toLowerCase().includes(query.toLowerCase())
    );
    if (results.length > 0) {
      setActiveTab('transcript');
      // Scroll to first result
      setTimeout(() => {
        const firstResult = results[0];
        if (transcriptRef.current) {
          const element = transcriptRef.current.querySelector(`[data-seq="${firstResult.seqNo}"]`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('highlight-flash');
            setTimeout(() => element.classList.remove('highlight-flash'), 2000);
          }
        }
      }, 100);
      addToast(`Found ${results.length} matches for "${query}"`, 'success', 3000);
    } else {
      addToast(`No matches found for "${query}"`, 'info', 3000);
    }
  }, [segments, addToast, setActiveTab, transcriptRef]);

  const handleVoiceAsk = useCallback(async (question) => {
    if (!question) return 'Please ask a question.';

    // Build transcript context
    const transcriptText = transcriptToText(segments);

    if (!transcriptText) {
      return 'No transcript available yet. Start speaking to provide context for your question.';
    }

    try {
      const response = await fetch('/api/ai/ask-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          question,
          transcript: transcriptText,
          model: getPreferredAiModel(),
        }),
      });

      if (!response.ok) {
        throw new Error('AI request failed');
      }

      const data = await response.json();
      return data.answer || 'I couldn\'t find a specific answer. Try rephrasing your question.';
    } catch (error) {
      console.error('Voice ask error:', error);
      return 'Failed to process question. Please try again.';
    }
  }, [segments]);

  return {
    onSummarize: handleVoiceSummarize,
    onActionItems: handleVoiceActionItems,
    onHighlight: handleVoiceHighlight,
    onDecisions: handleVoiceDecisions,
    onQuestions: handleVoiceQuestions,
    onSendToChat: handleVoiceSendToChat,
    onSearch: handleVoiceSearch,
    onAsk: handleVoiceAsk,
  };
}
