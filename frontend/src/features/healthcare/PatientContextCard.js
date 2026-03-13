import React, { useState, useEffect } from 'react';
import { User, Calendar, AlertTriangle, Pill, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import './PatientContextCard.css';

/**
 * PatientContextCard — Shows patient context for healthcare vertical.
 *
 * Displays:
 * - Patient identifier (if detected from transcript)
 * - Last session summary
 * - Known conditions/allergies
 * - Active medications
 * - Follow-up reminders
 */

// Demo data for testing UI
const DEMO_PATIENT_INFO = {
  name: 'Sarah Mitchell',
  lastVisit: 'February 15, 2026 — Follow-up for anxiety management',
  conditions: ['Generalized Anxiety Disorder', 'Hypertension', 'Insomnia'],
  allergies: ['Penicillin', 'Sulfa'],
  medications: ['Lisinopril 10mg', 'Sertraline 50mg', 'Melatonin 5mg PRN'],
};

export default function PatientContextCard({ segments, meetingId }) {
  const [patientInfo, setPatientInfo] = useState(DEMO_PATIENT_INFO);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  // Try to detect patient info from transcript
  useEffect(() => {
    if (!segments || segments.length === 0) return;

    // In a real implementation, this would call an AI endpoint
    // For demo, we'll extract basic info from transcript keywords
    detectPatientInfo(segments);
  }, [segments]);

  const detectPatientInfo = (segs) => {
    const text = segs.map(s => s.text.toLowerCase()).join(' ');

    // Demo: Look for name patterns like "Hi [Name]" or "Mr./Mrs. [Name]"
    let patientName = null;
    const namePatterns = [
      /(?:hi|hello|good morning|good afternoon)\s+(?:mr\.|mrs\.|ms\.|miss)?\s*([a-z]+)/i,
      /patient\s+(?:is\s+)?([a-z]+\s+[a-z]+)/i,
    ];

    for (const pattern of namePatterns) {
      const match = text.match(pattern);
      if (match) {
        patientName = match[1].charAt(0).toUpperCase() + match[1].slice(1);
        break;
      }
    }

    // Detect conditions mentioned
    const conditions = [];
    const conditionKeywords = {
      'diabetes': 'Diabetes',
      'hypertension': 'Hypertension',
      'high blood pressure': 'Hypertension',
      'asthma': 'Asthma',
      'anxiety': 'Anxiety',
      'depression': 'Depression',
      'arthritis': 'Arthritis',
      'migraine': 'Migraines',
    };

    for (const [keyword, label] of Object.entries(conditionKeywords)) {
      if (text.includes(keyword) && !conditions.includes(label)) {
        conditions.push(label);
      }
    }

    // Detect allergies
    const allergies = [];
    if (text.includes('allergic to') || text.includes('allergy')) {
      const allergyKeywords = ['penicillin', 'peanut', 'shellfish', 'latex', 'sulfa', 'aspirin'];
      for (const allergy of allergyKeywords) {
        if (text.includes(allergy)) {
          allergies.push(allergy.charAt(0).toUpperCase() + allergy.slice(1));
        }
      }
    }

    // Only set patient info if we detected something
    if (patientName || conditions.length > 0 || allergies.length > 0) {
      setPatientInfo(prev => ({
        ...prev,
        name: patientName || prev?.name,
        conditions: conditions.length > 0 ? conditions : prev?.conditions,
        allergies: allergies.length > 0 ? allergies : prev?.allergies,
        lastVisit: prev?.lastVisit || null,
        medications: prev?.medications || [],
      }));
    }
  };

  // Load patient context from backend (if we have patient ID)
  const loadPatientContext = async (patientId) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/healthcare/patient-context/${patientId}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setPatientInfo(data);
      }
    } catch (err) {
      console.error('Error loading patient context:', err);
    } finally {
      setIsLoading(false);
    }
  };

  if (!patientInfo && segments.length === 0) {
    return null; // Don't show card until we have content
  }

  return (
    <Card className="patient-context-card">
      <button
        className="patient-context-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="patient-context-title">
          <User size={16} className="patient-icon" />
          <span className="text-sans font-medium">
            {patientInfo?.name || 'Patient Context'}
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp size={16} className="text-muted" />
        ) : (
          <ChevronDown size={16} className="text-muted" />
        )}
      </button>

      {isExpanded && (
        <div className="patient-context-content">
          {/* Last visit */}
          {patientInfo?.lastVisit && (
            <div className="patient-context-row">
              <Clock size={14} className="text-muted" />
              <div className="patient-context-row-content">
                <span className="text-xs text-muted">Last Visit</span>
                <span className="text-sm">{patientInfo.lastVisit}</span>
              </div>
            </div>
          )}

          {/* Conditions */}
          {patientInfo?.conditions?.length > 0 && (
            <div className="patient-context-row">
              <Calendar size={14} className="text-muted" />
              <div className="patient-context-row-content">
                <span className="text-xs text-muted">Known Conditions</span>
                <div className="patient-tags">
                  {patientInfo.conditions.map((condition, i) => (
                    <span key={i} className="patient-tag condition-tag">
                      {condition}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Allergies */}
          {patientInfo?.allergies?.length > 0 && (
            <div className="patient-context-row">
              <AlertTriangle size={14} className="allergy-icon" />
              <div className="patient-context-row-content">
                <span className="text-xs text-muted">Allergies</span>
                <div className="patient-tags">
                  {patientInfo.allergies.map((allergy, i) => (
                    <span key={i} className="patient-tag allergy-tag">
                      {allergy}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Active medications */}
          {patientInfo?.medications?.length > 0 && (
            <div className="patient-context-row">
              <Pill size={14} className="text-muted" />
              <div className="patient-context-row-content">
                <span className="text-xs text-muted">Active Medications</span>
                <div className="patient-tags">
                  {patientInfo.medications.map((med, i) => (
                    <span key={i} className="patient-tag medication-tag">
                      {med}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!patientInfo?.conditions?.length && !patientInfo?.allergies?.length && !patientInfo?.medications?.length && (
            <p className="patient-context-empty text-xs text-muted">
              Patient information will appear as it's detected from the conversation.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
