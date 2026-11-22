/**
 * Voice Command Parser for Arlo
 * Detects "Arlo" or "Hey Arlo" trigger phrases and parses commands
 */

// The wake word, plus two common mis-transcriptions of it. Always matched as a
// whole word, so names like "Carlos", "Marlo" or "Harlow" never trigger.
const WAKE_WORD = '(?:arlo|carlo|harlo)';
const AFTER = '[\\s,.:;!?]*';

// "Hey Arlo" (also "hi", and "hay"/"a" as transcribed) works anywhere in a sentence.
const GREETING_TRIGGER = new RegExp(`(?:^|[^a-z])(?:hey|hi|hay|a)[\\s,.]+(${WAKE_WORD})\\b${AFTER}`, 'i');
// Bare "Arlo, ..." only counts when it starts the sentence: "I showed Arlo to
// the team" is talking about Arlo, not to it.
const BARE_TRIGGER = new RegExp(`(?:^|[.!?]\\s+)(${WAKE_WORD})\\b${AFTER}`, 'i');

// Command definitions with aliases and patterns
export const COMMANDS = {
  summarize: {
    aliases: ['summarize', 'summarize this', 'summarize this meeting', 'summarize the meeting', 'summary', 'sum up', 'recap', 'give me a summary', 'give me the summary', 'give me a meeting summary', 'give me the meeting summary', 'what happened', 'highlights', 'meeting highlights', 'give me the highlights', 'give me the meeting highlights', 'give me meeting highlights', 'key points', 'key takeaways', 'what are the highlights', 'what are the key points', 'what are the key takeaways'],
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

  const match = GREETING_TRIGGER.exec(text) || BARE_TRIGGER.exec(text);
  if (!match) return null;

  let textAfterTrigger = text.substring(match.index + match[0].length).trim();
  if (textAfterTrigger.length > 0) {
    textAfterTrigger = textAfterTrigger.charAt(0).toUpperCase() + textAfterTrigger.slice(1);
  }

  return {
    triggerIndex: match.index,
    triggerPhrase: match[0].trim().toLowerCase(),
    textAfterTrigger,
  };
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

  // Try to match each command by exact alias
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

  // Keyword-based fallback matching for common commands
  const keywordMatches = [
    { keywords: ['summary', 'summarize', 'recap', 'highlights', 'key points', 'takeaways'], command: 'summarize' },
    { keywords: ['action items', 'action item', 'tasks', 'todos', 'to-dos'], command: 'actionItems' },
    { keywords: ['decisions', 'decided', 'decision'], command: 'decisions' },
    { keywords: ['questions', 'open questions'], command: 'questions' },
  ];

  for (const { keywords, command } of keywordMatches) {
    if (keywords.some(kw => cleanedText.includes(kw))) {
      const commandDef = COMMANDS[command];
      return {
        command,
        action: commandDef.action,
        description: commandDef.description,
        parameter: null,
        rawText: text,
      };
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

const voiceCommands = {
  detectTrigger,
  parseCommand,
  processTranscriptForCommand,
  getHelpText,
  COMMANDS,
};

export default voiceCommands;
