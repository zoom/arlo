import React, { useState } from 'react';
import {
  Zap,
  FileText,
  Calendar,
  Send,
  Clipboard,
  Printer,
  FlaskConical,
  Stethoscope,
  Pill,
  Clock,
  Check,
  ChevronRight,
} from 'lucide-react';
import Button from '../../components/ui/Button';
import './QuickActions.css';

/**
 * QuickActions — One-click time-saving actions for doctors.
 *
 * Features:
 * - Common order templates
 * - Quick follow-up scheduling
 * - Patient instructions
 * - Copy/export SOAP notes
 * - Send to EHR (simulated)
 */

const QUICK_ACTIONS = [
  {
    id: 'labs',
    icon: FlaskConical,
    label: 'Order Labs',
    description: 'Common lab panels',
    options: [
      { id: 'cbc', label: 'CBC', description: 'Complete blood count' },
      { id: 'cmp', label: 'CMP', description: 'Comprehensive metabolic panel' },
      { id: 'lipid', label: 'Lipid Panel', description: 'Cholesterol screening' },
      { id: 'tsh', label: 'TSH', description: 'Thyroid function' },
      { id: 'hba1c', label: 'HbA1c', description: 'Diabetes monitoring' },
    ],
  },
  {
    id: 'referral',
    icon: Stethoscope,
    label: 'Referral',
    description: 'Specialist referrals',
    options: [
      { id: 'neuro', label: 'Neurology', description: 'Headache, seizure, neuropathy' },
      { id: 'cardio', label: 'Cardiology', description: 'Heart, BP, chest pain' },
      { id: 'psych', label: 'Psychiatry', description: 'Mental health' },
      { id: 'endo', label: 'Endocrinology', description: 'Diabetes, thyroid, hormones' },
      { id: 'gi', label: 'Gastroenterology', description: 'GI issues' },
    ],
  },
  {
    id: 'followup',
    icon: Calendar,
    label: 'Follow-up',
    description: 'Schedule next visit',
    options: [
      { id: '1week', label: '1 Week', description: 'Acute follow-up' },
      { id: '2weeks', label: '2 Weeks', description: 'Short-term follow-up' },
      { id: '4weeks', label: '4 Weeks', description: 'Standard follow-up' },
      { id: '3months', label: '3 Months', description: 'Quarterly check' },
      { id: '6months', label: '6 Months', description: 'Semi-annual' },
    ],
  },
  {
    id: 'rx',
    icon: Pill,
    label: 'Rx Template',
    description: 'Common prescriptions',
    options: [
      { id: 'nsaid', label: 'NSAID', description: 'Ibuprofen 400mg TID PRN' },
      { id: 'abx', label: 'Antibiotic', description: 'Amoxicillin 500mg TID x 10d' },
      { id: 'ppi', label: 'PPI', description: 'Omeprazole 20mg daily' },
      { id: 'ssri', label: 'SSRI', description: 'Sertraline 50mg daily' },
      { id: 'steroid', label: 'Steroid Pack', description: 'Prednisone taper' },
    ],
  },
];

const EXPORT_ACTIONS = [
  { id: 'copy', icon: Clipboard, label: 'Copy Notes', description: 'Copy to clipboard' },
  { id: 'ehr', icon: Send, label: 'Send to EHR', description: 'Export to medical record' },
  { id: 'print', icon: Printer, label: 'Print Summary', description: 'Patient visit summary' },
  { id: 'instructions', icon: FileText, label: 'Patient Summary', description: 'Plain-language handout' },
];

// Generate patient-friendly summary from SOAP data
const generatePatientSummary = () => {
  return `VISIT SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT WE DISCUSSED TODAY:
You came in because you've been having headaches for the past 2 weeks. You described the pain as throbbing, mostly on the right side of your head, and worse in the mornings.

YOUR EXAM RESULTS:
• Blood pressure: 128/82 (slightly elevated - we'll keep an eye on this)
• Heart rate: 76 (normal)
• Neurological exam: Normal

WHAT WE THINK IS HAPPENING:
Your headaches are most likely tension-type headaches, related to stress and difficulty sleeping. We don't think this is anything more serious.

YOUR TREATMENT PLAN:

1. NEW MEDICATION:
   Amitriptyline 10mg - Take one tablet at bedtime
   This helps prevent headaches and may also help you sleep better.

2. CONTINUE:
   Ibuprofen as needed for pain, but try to limit to 2-3 times per week

3. LIFESTYLE CHANGES:
   • Try to go to bed and wake up at the same time each day
   • Avoid screens (phone, TV, computer) for 1 hour before bed
   • Practice stress management - deep breathing, taking breaks

4. TRACK YOUR HEADACHES:
   Keep a diary of when headaches happen and what might trigger them

FOLLOW-UP:
Please schedule a follow-up appointment in 4 weeks so we can see how you're doing.

WHEN TO CALL US OR SEEK CARE:
• Sudden severe headache ("worst headache of your life")
• Headache with fever, stiff neck, or rash
• Vision changes, confusion, or weakness
• Headaches getting significantly worse

Questions? Call our office at [PHONE NUMBER]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This summary is for your reference. It does not replace
the conversation you had with your healthcare provider.`;
};

export default function QuickActions({ soapData, onAction }) {
  const [expandedAction, setExpandedAction] = useState(null);
  const [completedActions, setCompletedActions] = useState(new Set());
  const [recentlyCompleted, setRecentlyCompleted] = useState(null);
  const [showPatientSummary, setShowPatientSummary] = useState(false);

  const handleOptionClick = (actionId, optionId, optionLabel) => {
    // Simulate action completion
    const key = `${actionId}-${optionId}`;
    setCompletedActions(prev => new Set([...prev, key]));
    setRecentlyCompleted({ actionId, optionId, label: optionLabel });

    // Clear the "recently completed" indicator after 2 seconds
    setTimeout(() => setRecentlyCompleted(null), 2000);

    // Close the expanded section
    setExpandedAction(null);

    // Callback for parent component
    if (onAction) {
      onAction(actionId, optionId);
    }
  };

  const handleExportAction = (actionId) => {
    if (actionId === 'copy' && soapData) {
      const text = `SOAP NOTE\n\nSUBJECTIVE:\n${soapData.subjective}\n\nOBJECTIVE:\n${soapData.objective}\n\nASSESSMENT:\n${soapData.assessment}\n\nPLAN:\n${soapData.plan}`;
      navigator.clipboard?.writeText(text);
      setRecentlyCompleted({ actionId, label: 'Copied!' });
      setTimeout(() => setRecentlyCompleted(null), 2000);
    } else if (actionId === 'instructions') {
      setShowPatientSummary(true);
    } else if (actionId === 'print') {
      // Generate and open print view
      const summary = generatePatientSummary();
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(`<pre style="font-family: system-ui, sans-serif; white-space: pre-wrap; padding: 40px; max-width: 600px; margin: 0 auto;">${summary}</pre>`);
        printWindow.document.close();
        printWindow.print();
      }
      setRecentlyCompleted({ actionId, label: 'Opened' });
      setTimeout(() => setRecentlyCompleted(null), 2000);
    }
    // EHR export would be implemented with actual integration
  };

  const copyPatientSummary = () => {
    const summary = generatePatientSummary();
    navigator.clipboard?.writeText(summary);
    setRecentlyCompleted({ actionId: 'summary-copy', label: 'Copied!' });
    setTimeout(() => setRecentlyCompleted(null), 2000);
  };

  return (
    <div className="quick-actions">
      <div className="quick-actions-header">
        <Zap size={16} className="quick-actions-icon" />
        <span className="text-sans font-medium">Quick Actions</span>
      </div>

      {/* Main action buttons */}
      <div className="quick-actions-grid">
        {QUICK_ACTIONS.map(action => {
          const Icon = action.icon;
          const isExpanded = expandedAction === action.id;

          return (
            <div key={action.id} className="quick-action-container">
              <button
                className={`quick-action-btn ${isExpanded ? 'expanded' : ''}`}
                onClick={() => setExpandedAction(isExpanded ? null : action.id)}
              >
                <Icon size={16} />
                <span>{action.label}</span>
                <ChevronRight size={14} className={`quick-action-chevron ${isExpanded ? 'expanded' : ''}`} />
              </button>

              {isExpanded && (
                <div className="quick-action-options">
                  {action.options.map(option => {
                    const isCompleted = completedActions.has(`${action.id}-${option.id}`);
                    const isRecent = recentlyCompleted?.actionId === action.id &&
                                     recentlyCompleted?.optionId === option.id;

                    return (
                      <button
                        key={option.id}
                        className={`quick-action-option ${isCompleted ? 'completed' : ''} ${isRecent ? 'recent' : ''}`}
                        onClick={() => handleOptionClick(action.id, option.id, option.label)}
                      >
                        <span className="quick-action-option-label">{option.label}</span>
                        <span className="quick-action-option-desc text-xs text-muted">{option.description}</span>
                        {isRecent && <Check size={14} className="quick-action-check" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Export actions */}
      <div className="quick-actions-export">
        {EXPORT_ACTIONS.map(action => {
          const Icon = action.icon;
          const isRecent = recentlyCompleted?.actionId === action.id;

          return (
            <button
              key={action.id}
              className={`quick-export-btn ${isRecent ? 'recent' : ''}`}
              onClick={() => handleExportAction(action.id)}
              title={action.description}
            >
              {isRecent ? <Check size={14} /> : <Icon size={14} />}
              <span className="text-xs">{isRecent ? recentlyCompleted.label : action.label}</span>
            </button>
          );
        })}
      </div>

      {/* Time saved indicator */}
      {completedActions.size > 0 && (
        <div className="quick-actions-stats">
          <Clock size={12} />
          <span className="text-xs text-muted">
            ~{completedActions.size * 2} min saved this session
          </span>
        </div>
      )}

      {/* Patient Summary Modal */}
      {showPatientSummary && (
        <div className="patient-summary-overlay" onClick={() => setShowPatientSummary(false)}>
          <div className="patient-summary-modal" onClick={e => e.stopPropagation()}>
            <div className="patient-summary-header">
              <h3 className="text-serif font-medium">Patient-Friendly Summary</h3>
              <button
                className="patient-summary-close"
                onClick={() => setShowPatientSummary(false)}
              >
                ×
              </button>
            </div>
            <div className="patient-summary-content">
              <pre className="patient-summary-text">{generatePatientSummary()}</pre>
            </div>
            <div className="patient-summary-actions">
              <button
                className="patient-summary-btn"
                onClick={copyPatientSummary}
              >
                <Clipboard size={14} />
                {recentlyCompleted?.actionId === 'summary-copy' ? 'Copied!' : 'Copy to Clipboard'}
              </button>
              <button
                className="patient-summary-btn primary"
                onClick={() => {
                  const summary = generatePatientSummary();
                  const printWindow = window.open('', '_blank');
                  if (printWindow) {
                    printWindow.document.write(`<pre style="font-family: system-ui, sans-serif; white-space: pre-wrap; padding: 40px; max-width: 600px; margin: 0 auto;">${summary}</pre>`);
                    printWindow.document.close();
                    printWindow.print();
                  }
                }}
              >
                <Printer size={14} />
                Print for Patient
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
