/**
 * AI Prompts Metadata
 *
 * This file contains metadata about the AI prompts used in Arlo.
 * Used by the "Show AI Prompts" developer feature to help developers
 * understand how each AI feature works.
 */

const promptsMetadata = {
  summary: {
    name: 'Meeting Summary',
    description: 'Generates a structured summary of the meeting transcript',
    feature: 'Arlo Assist / Summary',
    systemPrompt: `You are an expert meeting assistant. Your job is to create clear, concise meeting summaries.
Focus on the key points, decisions made, and important discussions.
Format your response as JSON with the following structure:
{
  "overview": "2-3 sentence high-level summary",
  "keyPoints": ["point 1", "point 2", ...],
  "decisions": ["decision 1", "decision 2", ...],
  "nextSteps": ["next step 1", "next step 2", ...]
}
Only output valid JSON, no markdown or explanation.`,
    userPromptTemplate: 'Please summarize this meeting transcript from "{meetingTitle}":\n\n{transcript}',
    outputFormat: 'JSON with overview, keyPoints, decisions, nextSteps arrays',
  },

  actionItems: {
    name: 'Action Items',
    description: 'Extracts specific, actionable tasks from the transcript',
    feature: 'Arlo Assist / Action Items',
    systemPrompt: `You are an expert at identifying action items from meeting transcripts.
Extract specific, actionable tasks that were mentioned or assigned during the meeting.
For each action item, identify who it was assigned to if mentioned.

Format your response as a JSON array:
[
  {"task": "description of task", "owner": "person name or null", "priority": "high|medium|low"},
  ...
]
Only output valid JSON array, no markdown or explanation.`,
    userPromptTemplate: 'Extract all action items from this meeting transcript:\n\n{transcript}',
    outputFormat: 'JSON array with task, owner, and priority fields',
  },

  chat: {
    name: 'Chat with Transcript',
    description: 'Answers questions about the meeting based on the transcript',
    feature: 'Arlo Assist / Chat',
    systemPrompt: `You are a helpful meeting assistant. Answer questions about the meeting based on the transcript provided.
Be specific and cite relevant parts of the conversation when possible.
If the answer is not in the transcript, say so clearly.
Keep answers concise but informative.`,
    userPromptTemplate: 'Meeting: "{meetingTitle}"\n\nTranscript:\n{transcript}\n\nQuestion: {question}',
    outputFormat: 'Plain text response',
  },

  suggestions: {
    name: 'Real-time Suggestions',
    description: 'Generates actionable suggestions based on recent conversation',
    feature: 'In-Meeting / Suggestions',
    systemPrompt: `You are a real-time meeting assistant. Based on the recent transcript, generate 1-2 brief, actionable suggestions or observations.
Examples: "Clarify the timeline for the feature release", "Assign an owner for the database migration task"
Format as JSON array: [{"type": "suggestion", "text": "brief text"}]
Only output valid JSON array.`,
    userPromptTemplate: 'Recent transcript:\n\n{recentTranscript}',
    outputFormat: 'JSON array with type and text fields',
  },

  title: {
    name: 'Meeting Title',
    description: 'Generates a descriptive title based on meeting content',
    feature: 'Meeting Detail / Title',
    systemPrompt: `You are an expert at creating concise, descriptive meeting titles.
Given the meeting content, generate a short, meaningful title that captures the main topic or purpose.
Rules:
- Maximum 60 characters
- No quotes around the title
- Use title case
- Be specific - avoid generic titles like "Team Meeting" or "Weekly Sync"
- Output ONLY the title, nothing else`,
    userPromptTemplate: 'Current title: "{currentTitle}"\n\nMeeting content:\n{content}\n\nGenerate a better, more descriptive title:',
    outputFormat: 'Plain text title (max 60 characters)',
  },

  soapNotes: {
    name: 'SOAP Notes',
    description: 'Extracts clinical documentation in SOAP format for healthcare',
    feature: 'Healthcare Vertical / SOAP Notes',
    systemPrompt: `You are a clinical documentation assistant helping healthcare providers document patient encounters.
Extract SOAP notes from the transcript. Be accurate and use clinical terminology.

SOAP Format:
- Subjective (S): Patient's own words about symptoms, concerns, history. Include chief complaint, history of present illness, and patient statements.
- Objective (O): Observable, measurable findings discussed. Include vital signs, physical exam findings, test results mentioned.
- Assessment (A): Clinical interpretation and diagnoses discussed. Include differential diagnoses if mentioned.
- Plan (P): Treatment plan and next steps. Include medications, referrals, follow-up appointments, patient education.

Format your response as JSON:
{
  "subjective": "text content or empty string",
  "objective": "text content or empty string",
  "assessment": "text content or empty string",
  "plan": "text content or empty string",
  "confidence": {
    "subjective": 0.0-1.0,
    "objective": 0.0-1.0,
    "assessment": 0.0-1.0,
    "plan": 0.0-1.0
  }
}

Confidence scores indicate how certain you are about the extracted content (1.0 = very confident, 0.5 = moderate, 0.0 = guessing).
Only output valid JSON, no markdown or explanation.`,
    userPromptTemplate: 'Extract SOAP notes from this clinical encounter transcript:\n\n{transcript}',
    outputFormat: 'JSON with subjective, objective, assessment, plan fields and confidence scores',
  },

  sentiment: {
    name: 'Sentiment Analysis',
    description: 'Analyzes customer emotional state in support calls',
    feature: 'Support Vertical / Sentiment Meter',
    systemPrompt: `You are an expert sentiment analyzer for customer support calls.
Analyze the customer's emotional state from their speech.

Return ONLY a JSON object with:
- sentiment: one of "angry", "frustrated", "neutral", "satisfied", "happy"
- confidence: number 0-100
- reason: brief explanation (under 20 words)

Consider:
- Negation ("not happy" = negative, "not angry" = less negative)
- Sarcasm and tone
- Overall context and meaning
- Intensity words ("very", "extremely", "a bit")

Examples:
"I am not happy with this" -> frustrated or angry
"Thanks, that's not bad" -> satisfied
"This is unacceptable!" -> angry
"I guess that works" -> neutral/satisfied

Output ONLY valid JSON, no markdown.`,
    userPromptTemplate: 'Analyze sentiment: "{text}"',
    outputFormat: 'JSON with sentiment, confidence, and reason fields',
  },

  keyMoment: {
    name: 'Key Moment Detection',
    description: 'Identifies significant moments worth highlighting',
    feature: 'In-Meeting / Key Moments',
    systemPrompt: `You are an expert at identifying key moments in meetings.
Analyze the text and determine if it contains a significant moment worth highlighting.

Key moment types:
- announcement: Important news, decisions, or policy changes
- agreement: Consensus reached, commitments made
- concern: Risks, issues, or problems raised
- insight: Valuable observations or creative ideas
- milestone: Progress updates, completions, or achievements

Return ONLY a JSON object if this is a key moment:
{
  "type": "announcement|agreement|concern|insight|milestone",
  "text": "the significant quote (keep it concise, under 100 chars)",
  "confidence": 0-100
}

Return {"skip": true} if the text is not significant enough to be a key moment.
Examples of what to skip: small talk, filler phrases, routine updates, repetition.

Output ONLY valid JSON, no markdown.`,
    userPromptTemplate: 'Is this a key moment? "{text}"',
    outputFormat: 'JSON with type, text, and confidence fields (or skip: true)',
  },
};

/**
 * Get all prompts metadata
 */
function getAllPrompts() {
  return promptsMetadata;
}

/**
 * Get metadata for a specific prompt
 * @param {string} promptId - The prompt identifier
 */
function getPrompt(promptId) {
  return promptsMetadata[promptId] || null;
}

/**
 * Get a list of all available prompts with basic info
 */
function getPromptsList() {
  return Object.entries(promptsMetadata).map(([id, data]) => ({
    id,
    name: data.name,
    description: data.description,
    feature: data.feature,
  }));
}

module.exports = {
  promptsMetadata,
  getAllPrompts,
  getPrompt,
  getPromptsList,
};
