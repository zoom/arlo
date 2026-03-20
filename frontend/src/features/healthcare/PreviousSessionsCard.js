import React, { useState } from 'react';
import { History, ChevronDown, ChevronUp, Calendar, FileText, AlertCircle } from 'lucide-react';
import Card from '../../components/ui/Card';
import './PreviousSessionsCard.css';

/**
 * PreviousSessionsCard — Shows summary of past appointments for context.
 * Helps doctors quickly recall what was discussed previously.
 */

// Demo data for past sessions — Maria Rodriguez chronic pain history
const DEMO_PREVIOUS_SESSIONS = [
  {
    id: 1,
    date: 'Feb 28, 2026',
    chiefComplaint: 'Chronic back pain + diabetes check',
    summary: 'Pain improving on Gabapentin 300mg TID. A1c down to 7.2% from 7.8%. Weight stable. Mood better on Duloxetine. Walking tolerance increased.',
    plan: 'Continue current regimen, PT referral, recheck A1c in 3 months',
    flags: [],
  },
  {
    id: 2,
    date: 'Jan 10, 2026',
    chiefComplaint: 'Back pain — Gabapentin start',
    summary: 'Trialed tramadol but stopped due to nausea. Started Gabapentin 300mg TID. Also started Duloxetine 30mg for pain + mood. A1c 7.8%.',
    plan: 'Gabapentin 300mg TID, Duloxetine 30mg daily, continue Metformin, follow-up 6 weeks',
    flags: ['A1c above target'],
  },
  {
    id: 3,
    date: 'Nov 5, 2025',
    chiefComplaint: 'Chronic low back pain — initial eval',
    summary: 'New patient. Reports 2-year history of low back pain after lifting injury. Failed OTC acetaminophen. MRI shows L4-L5 disc bulge. Depression screening positive.',
    plan: 'Start conservative treatment. Avoid NSAIDs (GI bleed history). Order PT eval. Consider Gabapentin. Address depression.',
    flags: ['NSAID allergy', 'Depression screening +'],
  },
  {
    id: 4,
    date: 'Sep 18, 2025',
    chiefComplaint: 'Diabetes annual',
    summary: 'Diabetes well-controlled on Metformin 1000mg BID. A1c 7.4%. Hypertension stable on Lisinopril 20mg. Foot exam normal. Eye exam due.',
    plan: 'Continue current diabetes/HTN regimen, schedule ophthalmology referral',
    flags: [],
  },
];

export default function PreviousSessionsCard({ patientId }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedSession, setExpandedSession] = useState(null);
  const sessions = DEMO_PREVIOUS_SESSIONS; // Would fetch from API in production

  return (
    <Card className="previous-sessions-card">
      <button
        className="previous-sessions-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="previous-sessions-title">
          <History size={16} className="previous-sessions-icon" />
          <span className="text-sans font-medium">Previous Sessions</span>
          <span className="previous-sessions-count">{sessions.length}</span>
        </div>
        {isExpanded ? (
          <ChevronUp size={16} className="text-muted" />
        ) : (
          <ChevronDown size={16} className="text-muted" />
        )}
      </button>

      {isExpanded && (
        <div className="previous-sessions-content">
          {sessions.map((session) => (
            <div key={session.id} className="previous-session-item">
              <button
                className="previous-session-summary"
                onClick={() => setExpandedSession(
                  expandedSession === session.id ? null : session.id
                )}
              >
                <div className="previous-session-date">
                  <Calendar size={12} />
                  <span className="text-xs">{session.date}</span>
                </div>
                <span className="previous-session-complaint text-sm">
                  {session.chiefComplaint}
                </span>
                {session.flags.length > 0 && (
                  <span className="previous-session-flag">
                    <AlertCircle size={12} />
                  </span>
                )}
                {expandedSession === session.id ? (
                  <ChevronUp size={14} className="text-muted" />
                ) : (
                  <ChevronDown size={14} className="text-muted" />
                )}
              </button>

              {expandedSession === session.id && (
                <div className="previous-session-details">
                  <div className="previous-session-detail">
                    <span className="text-xs text-muted">Summary</span>
                    <p className="text-sm">{session.summary}</p>
                  </div>
                  <div className="previous-session-detail">
                    <span className="text-xs text-muted">Plan</span>
                    <p className="text-sm">{session.plan}</p>
                  </div>
                  {session.flags.length > 0 && (
                    <div className="previous-session-flags">
                      {session.flags.map((flag, i) => (
                        <span key={i} className="previous-session-flag-tag">
                          <AlertCircle size={10} />
                          {flag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
