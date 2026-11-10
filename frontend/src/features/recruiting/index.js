/**
 * Recruiting Vertical Feature Components
 *
 * BrightHire-inspired interview intelligence tools for recruiters
 * and hiring teams, including consent mechanisms, structured
 * evaluation, interviewer coaching, and candidate experience.
 */

// Shared components (shown to both)
export { default as RecordingConsent } from './RecordingConsent';

// Interviewer-only components
export { default as InterviewScorecard } from './InterviewScorecard';
export { default as InterviewerCoaching } from './InterviewerCoaching';
export { default as InterviewGuide } from './InterviewGuide';
export { default as CandidateContext } from './CandidateContext';
export { default as FraudSignals } from './FraudSignals';

// Candidate-only components
export { default as CandidateNotes } from './CandidateNotes';
