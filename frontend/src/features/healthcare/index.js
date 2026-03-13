/**
 * Healthcare Vertical Features
 *
 * Components for the Arlo for Healthcare experience:
 * - SOAPNotesPanel: Auto-populated SOAP clinical documentation
 * - PatientContextCard: Patient info sidebar
 * - PreviousSessionsCard: Past appointment history
 * - ClinicalAlerts: Real-time warnings and contradictions
 * - QuickActions: One-click time-saving actions
 * - HealthcareTagsSummary: Detected symptoms/medications bar
 * - highlightMedicalTerms: Function to highlight medical terms in text
 */

export { default as SOAPNotesPanel } from './SOAPNotesPanel';
export { default as PatientContextCard } from './PatientContextCard';
export { default as PreviousSessionsCard } from './PreviousSessionsCard';
export { default as ClinicalAlerts } from './ClinicalAlerts';
export { default as QuickActions } from './QuickActions';
export {
  default as HealthcareTagsSummary,
  highlightMedicalTerms,
} from './HealthcareTags';
