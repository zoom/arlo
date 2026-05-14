/**
 * Voice Command Parser for Arlo
 * Detects "Arlo" or "Hey Arlo" trigger phrases and parses commands
 */

// Trigger phrases to detect (case-insensitive)
// More lenient matching to handle transcription variations
const TRIGGER_PHRASES = [
  'hey arlo',
  'hey, arlo',
  'hey. arlo',
  'hi arlo',
  'hi, arlo',
  'hi. arlo',
  'a arlo',  // common transcription of "hey"
  'hay arlo',
  'arlo,',
  'arlo.',
  'arlo ',
  'arlo:',
  // Handle common transcription errors
  'carlo',
  'harlo',
  'hey carlo',
];

// Command definitions with aliases and patterns
export const COMMANDS = {
  summarize: {
    aliases: ['summarize', 'summary', 'sum up', 'recap', 'give me a summary', 'what happened'],
    description: 'Generate a meeting summary',
    action: 'SUMMARIZE',
  },
  actionItems: {
    aliases: ['action items', 'action item', 'tasks', 'to-dos', 'to dos', 'todos', 'what do i need to do', 'what are the action items'],
    description: 'Extract action items',
    action: 'ACTION_ITEMS',
  },
  highlight: {
    aliases: ['highlight', 'bookmark', 'mark this', 'save this', 'remember this', 'flag this'],
    description: 'Create a highlight at current time',
    action: 'HIGHLIGHT',
  },
  decisions: {
    aliases: ['decisions', 'what did we decide', 'what were the decisions', 'key decisions'],
    description: 'Show decisions made',
    action: 'DECISIONS',
  },
  questions: {
    aliases: ['questions', 'open questions', 'what questions', 'unanswered questions'],
    description: 'Show open questions',
    action: 'QUESTIONS',
  },
  sendToChat: {
    aliases: ['send to chat', 'share to chat', 'post to chat', 'send summary to chat', 'share summary'],
    description: 'Send summary to meeting chat',
    action: 'SEND_TO_CHAT',
  },
  whoSaid: {
    aliases: ['who said', 'what did', 'when did'],
    description: 'Search for who said something',
    action: 'SEARCH',
    hasParameter: true,
  },
  help: {
    aliases: ['help', 'what can you do', 'commands', 'what are your commands'],
    description: 'Show available commands',
    action: 'HELP',
  },
};

/**
 * Check if text contains an Arlo trigger phrase
 * @param {string} text - Transcript text to check
 * @returns {object|null} - { triggerIndex, triggerPhrase, textAfterTrigger } or null
 */
export function detectTrigger(text) {
  if (!text || typeof text !== 'string') return null;

  const lowerText = text.toLowerCase();

  for (const phrase of TRIGGER_PHRASES) {
    const index = lowerText.indexOf(phrase);
    if (index !== -1) {
      const textAfterTrigger = text.substring(index + phrase.length).trim();
      return {
        triggerIndex: index,
        triggerPhrase: phrase.trim(),
        textAfterTrigger,
      };
    }
  }

  return null;
}

/**
 * Parse a command from text after the trigger phrase
 * @param {string} text - Text after "Arlo" trigger
 * @returns {object|null} - { command, action, parameter } or null
 */
export function parseCommand(text) {
  if (!text || typeof text !== 'string') return null;

  const lowerText = text.toLowerCase().trim();

  // Remove common filler words at the start
  const cleanedText = lowerText
    .replace(/^(please|can you|could you|would you|i need you to|i want you to)\s*/i, '')
    .trim();

  // Try to match each command
  for (const [commandKey, commandDef] of Object.entries(COMMANDS)) {
    for (const alias of commandDef.aliases) {
      if (cleanedText.startsWith(alias)) {
        const parameter = commandDef.hasParameter
          ? cleanedText.substring(alias.length).trim()
          : null;

        return {
          command: commandKey,
          action: commandDef.action,
          description: commandDef.description,
          parameter,
          rawText: text,
        };
      }
    }
  }

  // No command matched - could be a general question
  if (cleanedText.length > 3) {
    return {
      command: 'ask',
      action: 'ASK',
      description: 'Ask a question about the meeting',
      parameter: text.trim(),
      rawText: text,
    };
  }

  return null;
}

/**
 * Process transcript text for voice commands
 * @param {string} text - Full transcript segment text
 * @returns {object|null} - Parsed command or null
 */
export function processTranscriptForCommand(text) {
  const trigger = detectTrigger(text);
  if (!trigger) return null;

  const command = parseCommand(trigger.textAfterTrigger);
  if (!command) return null;

  return {
    ...command,
    trigger: trigger.triggerPhrase,
    fullText: text,
  };
}

/**
 * Get help text for all available commands
 * @returns {string} - Formatted help text
 */
export function getHelpText() {
  const lines = ['Available commands:', ''];

  for (const [, commandDef] of Object.entries(COMMANDS)) {
    const mainAlias = commandDef.aliases[0];
    lines.push(`• "Arlo, ${mainAlias}" - ${commandDef.description}`);
  }

  lines.push('', 'Or ask any question: "Arlo, what did John say about the deadline?"');

  return lines.join('\n');
}

export default {
  detectTrigger,
  parseCommand,
  processTranscriptForCommand,
  getHelpText,
  COMMANDS,
};
