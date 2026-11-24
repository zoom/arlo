/**
 * Arlo's agent as the running server uses it: the detector that hears
 * "Arlo, …" in the stored transcript, the agent that decides and runs what was
 * asked, and the hands that reach an owner's panel, wired to the meeting
 * store, the owners, the approvals, the sockets and the models.
 *
 *   lineStored(meetingId, line)  a transcript line was stored (routes/rtms.js)
 *   forget(meetingId)            the meeting's data is gone (the meeting lifecycle)
 *
 * The model calls go through the openrouter module object, so tests replace
 * them; nothing here is called at require time.
 */
const { createAgent } = require('./agent');
const { createCommandDetector } = require('./commandDetector');
const { createSpeakerMatch } = require('./speakerMatch');
const { getHands } = require('./hands');
const { listTools } = require('./tools');

let runtime = null;

function getAgentRuntime() {
  if (!runtime) {
    // Required here, not at the top: the lifecycle, the sockets and the
    // approvals require each other's neighbours, and tests build agents
    // without config
    /* eslint-disable global-require */
    const config = require('../../config');
    const { getMeetingStore } = require('../../storage');
    const { getArloPresence } = require('../arloPresence');
    const { getApprovals } = require('../approvals');
    const {
      sendApprovalOpened, sendArloThinking, sendArloDid, hasOwnerPanel,
    } = require('../websocket');
    const { shareNotes } = require('../notesSharing');
    const openrouter = require('../openrouter');
    /* eslint-enable global-require */
    const store = getMeetingStore();
    const hands = getHands();

    const agent = createAgent({
      store,
      presence: getArloPresence(),
      approvals: getApprovals(),
      hands,
      // The request and the tool table: nothing of the meeting goes to the model that picks
      choose: ({ request }) => openrouter.chooseTool({
        request, tools: listTools(), model: config.agentModel,
      }),
      answer: ({ question, lines }) => openrouter.answerFromTranscript({ question, lines, model: config.notesModel }),
      shareNotes: (meetingId, userId) => typeof userId === 'string' && shareNotes(meetingId, userId, true) !== 'refused',
      isVerifiedOwnerSpeaker: createSpeakerMatch({ mode: config.agentSpeakerMatch, store }),
      // A spoken request is looked at only while an owner's panel is open
      hasOwnerPanel,
      send: { thinking: sendArloThinking, did: sendArloDid, approval: sendApprovalOpened },
    });

    const detector = createCommandDetector({
      onRequest: (meetingId, heard) => {
        agent.handle(meetingId, {
          text: heard.text,
          channel: 'voice',
          askedBy: { speakerId: heard.speakerId, speakerLabel: heard.speakerLabel },
        }).catch(() => {
          // handle() does not reject; this is only so nothing is ever unhandled
        });
      },
    });

    runtime = {
      agent,
      detector,
      hands,
      /** A stored transcript line. Nothing is listened for while AI is off. Never throws. */
      lineStored(meetingId, line) {
        if (!config.aiEnabled) return;
        try {
          detector.lineStored(meetingId, line);
        } catch {
          // Listening for requests must never get in the way of keeping the transcript
        }
      },
      forget(meetingId) {
        detector.forget(meetingId);
        agent.forget(meetingId);
        hands.forget(meetingId);
      },
    };
  }
  return runtime;
}

module.exports = { getAgentRuntime };
