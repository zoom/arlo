/**
 * useVoiceCommands Hook
 * Listens to transcript segments and executes voice commands
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { useZoomSdk } from '../contexts/ZoomSdkContext';
import { processTranscriptForCommand, getHelpText, COMMANDS } from '../utils/voiceCommands';

// Cooldown to prevent duplicate command triggers (ms)
const COMMAND_COOLDOWN = 5000;

// Recent commands cache to prevent duplicates
const recentCommands = new Map();

/**
 * Hook to enable voice commands in the meeting view
 * @param {object} options - Configuration options
 * @param {WebSocket} options.ws - WebSocket connection
 * @param {function} options.onSummarize - Callback for summarize command
 * @param {function} options.onActionItems - Callback for action items command
 * @param {function} options.onHighlight - Callback for highlight command
 * @param {function} options.onDecisions - Callback for decisions command
 * @param {function} options.onQuestions - Callback for questions command
 * @param {function} options.onSendToChat - Callback for send to chat command
 * @param {function} options.onSearch - Callback for search command
 * @param {function} options.onAsk - Callback for general questions
 * @param {boolean} options.enabled - Whether voice commands are enabled
 */
export function useVoiceCommands({
  ws,
  onSummarize,
  onActionItems,
  onHighlight,
  onDecisions,
  onQuestions,
  onSendToChat,
  onSearch,
  onAsk,
  enabled = true,
}) {
  const { addToast } = useToast();
  const { zoomSdk } = useZoomSdk();
  const [lastCommand, setLastCommand] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Refs for callbacks to avoid stale closures
  const callbacksRef = useRef({
    onSummarize,
    onActionItems,
    onHighlight,
    onDecisions,
    onQuestions,
    onSendToChat,
    onSearch,
    onAsk,
  });

  useEffect(() => {
    callbacksRef.current = {
      onSummarize,
      onActionItems,
      onHighlight,
      onDecisions,
      onQuestions,
      onSendToChat,
      onSearch,
      onAsk,
    };
  }, [onSummarize, onActionItems, onHighlight, onDecisions, onQuestions, onSendToChat, onSearch, onAsk]);

  /**
   * Execute a parsed command
   */
  const executeCommand = useCallback(async (command) => {
    // Check cooldown to prevent duplicate triggers
    const commandKey = `${command.action}-${command.parameter || ''}`;
    const lastExecution = recentCommands.get(commandKey);
    if (lastExecution && Date.now() - lastExecution < COMMAND_COOLDOWN) {
      console.log('Voice command on cooldown:', commandKey);
      return;
    }
    recentCommands.set(commandKey, Date.now());

    // Clean up old entries
    for (const [key, time] of recentCommands.entries()) {
      if (Date.now() - time > COMMAND_COOLDOWN * 2) {
        recentCommands.delete(key);
      }
    }

    setIsProcessing(true);
    setLastCommand(command);

    // Show acknowledgment toast
    addToast(`🎤 Heard: "${command.rawText}"`, 'info', 3000);

    try {
      const callbacks = callbacksRef.current;

      switch (command.action) {
        case 'SUMMARIZE':
          addToast('📝 Generating summary...', 'info', 2000);
          if (callbacks.onSummarize) {
            await callbacks.onSummarize();
          }
          break;

        case 'ACTION_ITEMS':
          addToast('✅ Finding action items...', 'info', 2000);
          if (callbacks.onActionItems) {
            await callbacks.onActionItems();
          }
          break;

        case 'HIGHLIGHT':
          addToast('⭐ Creating highlight...', 'info', 2000);
          if (callbacks.onHighlight) {
            await callbacks.onHighlight();
          }
          // Show Zoom notification too
          if (zoomSdk) {
            zoomSdk.showNotification({
              type: 'success',
              title: 'Arlo',
              message: 'Highlight created!',
            }).catch(() => {});
          }
          break;

        case 'DECISIONS':
          addToast('🎯 Showing decisions...', 'info', 2000);
          if (callbacks.onDecisions) {
            await callbacks.onDecisions();
          }
          break;

        case 'QUESTIONS':
          addToast('❓ Showing questions...', 'info', 2000);
          if (callbacks.onQuestions) {
            await callbacks.onQuestions();
          }
          break;

        case 'SEND_TO_CHAT':
          addToast('💬 Sending to chat...', 'info', 2000);
          if (callbacks.onSendToChat) {
            await callbacks.onSendToChat();
          }
          break;

        case 'SEARCH':
          addToast(`🔍 Searching: "${command.parameter}"`, 'info', 2000);
          if (callbacks.onSearch) {
            await callbacks.onSearch(command.parameter);
          }
          break;

        case 'ASK':
          addToast(`💭 Asking: "${command.parameter}"`, 'info', 2000);
          if (callbacks.onAsk) {
            await callbacks.onAsk(command.parameter);
          }
          break;

        case 'HELP':
          addToast(getHelpText(), 'info', 10000);
          break;

        default:
          addToast(`Unknown command: ${command.action}`, 'warning', 3000);
      }
    } catch (error) {
      console.error('Voice command execution error:', error);
      addToast('Command failed. Please try again.', 'error', 3000);
    } finally {
      setIsProcessing(false);
    }
  }, [addToast, zoomSdk]);

  /**
   * Process incoming transcript segment for commands
   */
  const processSegment = useCallback((segment) => {
    if (!enabled || isProcessing) return;

    const text = segment?.text;
    if (!text) return;

    const command = processTranscriptForCommand(text);
    if (command) {
      console.log('Voice command detected:', command);
      executeCommand(command);
    }
  }, [enabled, isProcessing, executeCommand]);

  /**
   * Listen to WebSocket messages for transcript segments
   */
  useEffect(() => {
    if (!ws || !enabled) return;

    const handleMessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'transcript.segment') {
          const segment = message.data?.segment;
          if (segment) {
            processSegment(segment);
          }
        }
      } catch (error) {
        // Ignore parse errors
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, enabled, processSegment]);

  return {
    lastCommand,
    isProcessing,
    executeCommand,
    availableCommands: COMMANDS,
  };
}

export default useVoiceCommands;
