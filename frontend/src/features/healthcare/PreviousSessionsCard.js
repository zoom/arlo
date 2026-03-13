import React, { useState } from 'react';
import { History, ChevronDown, ChevronUp, Calendar, FileText, AlertCircle } from 'lucide-react';
import Card from '../../components/ui/Card';
import './PreviousSessionsCard.css';

/**
 * PreviousSessionsCard — Shows summary of past appointments for context.
 * Helps doctors quickly recall what was discussed previously.
 */

// Demo data for past sessions
const DEMO_PREVIOUS_SESSIONS = [
  {
    id: 1,
    date: 'Feb 15, 2026',
    chiefComplaint: 'Anxiety follow-up',
    summary: 'Patient reports improved anxiety with current Sertraline dose. Sleep still occasionally disrupted. Discussed continuing current regimen.',
    plan: 'Continue Sertraline 50mg, follow-up in 8 weeks',
    flags: [],
  },
  {
    id: 2,
    date: 'Dec 3, 2025',
    chiefComplaint: 'Annual physical + anxiety',
    summary: 'Annual exam within normal limits. Started Sertraline 50mg for generalized anxiety. BP slightly elevated at 132/84.',
    plan: 'Start Sertraline 50mg daily, lifestyle modifications for BP, recheck in 3 months',
    flags: ['BP elevated'],
  },
  {
    id: 3,
    date: 'Aug 22, 2025',
    chiefComplaint: 'Insomnia, stress',
    summary: 'Reports difficulty sleeping due to work stress. No anxiety medication at this time. Recommended sleep hygiene measures and Melatonin PRN.',
    plan: 'Melatonin 5mg PRN, sleep hygiene counseling, follow-up if not improving',
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
