import React, { useMemo } from 'react';
import { Activity, Pill, ThermometerSun, Heart, Brain, Stethoscope } from 'lucide-react';
import './HealthcareTags.css';

/**
 * HealthcareTags — Real-time symptom and medication detection.
 *
 * Scans transcript segments and highlights medical terms inline.
 * Shows a summary of detected items that can be clicked to jump to context.
 */

// Medical term dictionaries for detection
const SYMPTOM_PATTERNS = {
  pain: { label: 'Pain', icon: Activity, category: 'symptom' },
  headache: { label: 'Headache', icon: Brain, category: 'symptom' },
  migraine: { label: 'Migraine', icon: Brain, category: 'symptom' },
  nausea: { label: 'Nausea', icon: ThermometerSun, category: 'symptom' },
  dizziness: { label: 'Dizziness', icon: Activity, category: 'symptom' },
  fatigue: { label: 'Fatigue', icon: Activity, category: 'symptom' },
  fever: { label: 'Fever', icon: ThermometerSun, category: 'symptom' },
  cough: { label: 'Cough', icon: Stethoscope, category: 'symptom' },
  'shortness of breath': { label: 'Shortness of Breath', icon: Stethoscope, category: 'symptom' },
  'chest pain': { label: 'Chest Pain', icon: Heart, category: 'symptom' },
  palpitations: { label: 'Palpitations', icon: Heart, category: 'symptom' },
  swelling: { label: 'Swelling', icon: Activity, category: 'symptom' },
  numbness: { label: 'Numbness', icon: Activity, category: 'symptom' },
  tingling: { label: 'Tingling', icon: Activity, category: 'symptom' },
  insomnia: { label: 'Insomnia', icon: Brain, category: 'symptom' },
  anxiety: { label: 'Anxiety', icon: Brain, category: 'symptom' },
};

const MEDICATION_PATTERNS = {
  ibuprofen: { label: 'Ibuprofen', category: 'medication', type: 'NSAID' },
  aspirin: { label: 'Aspirin', category: 'medication', type: 'NSAID' },
  tylenol: { label: 'Tylenol', category: 'medication', type: 'Analgesic' },
  acetaminophen: { label: 'Acetaminophen', category: 'medication', type: 'Analgesic' },
  metformin: { label: 'Metformin', category: 'medication', type: 'Diabetes' },
  lisinopril: { label: 'Lisinopril', category: 'medication', type: 'ACE Inhibitor' },
  atorvastatin: { label: 'Atorvastatin', category: 'medication', type: 'Statin' },
  omeprazole: { label: 'Omeprazole', category: 'medication', type: 'PPI' },
  amoxicillin: { label: 'Amoxicillin', category: 'medication', type: 'Antibiotic' },
  prednisone: { label: 'Prednisone', category: 'medication', type: 'Steroid' },
  albuterol: { label: 'Albuterol', category: 'medication', type: 'Bronchodilator' },
  gabapentin: { label: 'Gabapentin', category: 'medication', type: 'Anticonvulsant' },
  sertraline: { label: 'Sertraline', category: 'medication', type: 'SSRI' },
  zoloft: { label: 'Zoloft', category: 'medication', type: 'SSRI' },
  lexapro: { label: 'Lexapro', category: 'medication', type: 'SSRI' },
};

const VITAL_PATTERNS = {
  'blood pressure': { label: 'Blood Pressure', icon: Heart, category: 'vital' },
  'heart rate': { label: 'Heart Rate', icon: Heart, category: 'vital' },
  pulse: { label: 'Pulse', icon: Heart, category: 'vital' },
  temperature: { label: 'Temperature', icon: ThermometerSun, category: 'vital' },
  weight: { label: 'Weight', icon: Activity, category: 'vital' },
  'oxygen saturation': { label: 'O2 Saturation', icon: Stethoscope, category: 'vital' },
};

/**
 * Scan transcript for medical terms
 */
function scanTranscript(segments) {
  const detected = {
    symptoms: new Map(),
    medications: new Map(),
    vitals: new Map(),
  };

  if (!segments || segments.length === 0) return detected;

  segments.forEach((segment, segIndex) => {
    const text = segment.text.toLowerCase();

    // Check symptoms
    for (const [pattern, info] of Object.entries(SYMPTOM_PATTERNS)) {
      if (text.includes(pattern)) {
        if (!detected.symptoms.has(pattern)) {
          detected.symptoms.set(pattern, {
            ...info,
            occurrences: [],
          });
        }
        detected.symptoms.get(pattern).occurrences.push({
          segmentIndex: segIndex,
          segmentSeqNo: segment.seqNo,
          speaker: segment.speakerLabel,
          text: segment.text,
        });
      }
    }

    // Check medications
    for (const [pattern, info] of Object.entries(MEDICATION_PATTERNS)) {
      if (text.includes(pattern)) {
        if (!detected.medications.has(pattern)) {
          detected.medications.set(pattern, {
            ...info,
            icon: Pill,
            occurrences: [],
          });
        }
        detected.medications.get(pattern).occurrences.push({
          segmentIndex: segIndex,
          segmentSeqNo: segment.seqNo,
          speaker: segment.speakerLabel,
          text: segment.text,
        });
      }
    }

    // Check vitals
    for (const [pattern, info] of Object.entries(VITAL_PATTERNS)) {
      if (text.includes(pattern)) {
        if (!detected.vitals.has(pattern)) {
          detected.vitals.set(pattern, {
            ...info,
            occurrences: [],
          });
        }
        detected.vitals.get(pattern).occurrences.push({
          segmentIndex: segIndex,
          segmentSeqNo: segment.seqNo,
          speaker: segment.speakerLabel,
          text: segment.text,
        });
      }
    }
  });

  return detected;
}

// Demo data for testing UI
const DEMO_DETECTED = {
  symptoms: new Map([
    ['headache', { label: 'Headache', icon: Brain, category: 'symptom', occurrences: [{ segmentSeqNo: 1, speaker: 'Patient', text: 'persistent headaches for the past 2 weeks' }] }],
    ['pain', { label: 'Pain', icon: Activity, category: 'symptom', occurrences: [{ segmentSeqNo: 1, speaker: 'Patient', text: 'throbbing pain on the right side' }, { segmentSeqNo: 3, speaker: 'Patient', text: 'pain is worse in the morning' }] }],
    ['insomnia', { label: 'Insomnia', icon: Brain, category: 'symptom', occurrences: [{ segmentSeqNo: 5, speaker: 'Patient', text: 'difficulty sleeping' }] }],
  ]),
  medications: new Map([
    ['ibuprofen', { label: 'Ibuprofen', icon: Pill, category: 'medication', type: 'NSAID', occurrences: [{ segmentSeqNo: 4, speaker: 'Patient', text: 'taking ibuprofen 400mg' }] }],
    ['amitriptyline', { label: 'Amitriptyline', icon: Pill, category: 'medication', type: 'TCA', occurrences: [{ segmentSeqNo: 8, speaker: 'Dr. Chen', text: 'start Amitriptyline 10mg at bedtime' }] }],
  ]),
  vitals: new Map([
    ['blood pressure', { label: 'Blood Pressure', icon: Heart, category: 'vital', occurrences: [{ segmentSeqNo: 6, speaker: 'Dr. Chen', text: 'BP 128/82' }] }],
  ]),
};

/**
 * HealthcareTagsSummary — Shows a summary bar of detected medical terms
 */
export function HealthcareTagsSummary({ segments, onTagClick, demoMode = true }) {
  const scannedDetected = useMemo(() => scanTranscript(segments), [segments]);

  // Use demo data if no real segments or in demo mode
  const detected = (segments?.length > 5) ? scannedDetected : (demoMode ? DEMO_DETECTED : scannedDetected);

  const totalCount =
    detected.symptoms.size +
    detected.medications.size +
    detected.vitals.size;

  if (totalCount === 0) return null;

  return (
    <div className="healthcare-tags-summary">
      <span className="healthcare-tags-label text-xs text-muted">Detected:</span>

      <div className="healthcare-tags-list">
        {/* Symptoms */}
        {Array.from(detected.symptoms.entries()).map(([key, item]) => {
          const Icon = item.icon || Activity;
          return (
            <button
              key={`symptom-${key}`}
              className="healthcare-tag symptom-tag"
              onClick={() => onTagClick?.(item.occurrences[0])}
              title={`${item.occurrences.length} mention${item.occurrences.length > 1 ? 's' : ''}`}
            >
              <Icon size={12} />
              {item.label}
              {item.occurrences.length > 1 && (
                <span className="healthcare-tag-count">{item.occurrences.length}</span>
              )}
            </button>
          );
        })}

        {/* Medications */}
        {Array.from(detected.medications.entries()).map(([key, item]) => (
          <button
            key={`med-${key}`}
            className="healthcare-tag medication-tag"
            onClick={() => onTagClick?.(item.occurrences[0])}
            title={`${item.type} — ${item.occurrences.length} mention${item.occurrences.length > 1 ? 's' : ''}`}
          >
            <Pill size={12} />
            {item.label}
            {item.occurrences.length > 1 && (
              <span className="healthcare-tag-count">{item.occurrences.length}</span>
            )}
          </button>
        ))}

        {/* Vitals */}
        {Array.from(detected.vitals.entries()).map(([key, item]) => {
          const Icon = item.icon || Activity;
          return (
            <button
              key={`vital-${key}`}
              className="healthcare-tag vital-tag"
              onClick={() => onTagClick?.(item.occurrences[0])}
              title={`${item.occurrences.length} mention${item.occurrences.length > 1 ? 's' : ''}`}
            >
              <Icon size={12} />
              {item.label}
              {item.occurrences.length > 1 && (
                <span className="healthcare-tag-count">{item.occurrences.length}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * highlightMedicalTerms — Returns JSX with highlighted medical terms
 */
export function highlightMedicalTerms(text) {
  if (!text) return text;

  const lowerText = text.toLowerCase();
  const highlights = [];

  // Find all matches
  const allPatterns = {
    ...SYMPTOM_PATTERNS,
    ...MEDICATION_PATTERNS,
    ...VITAL_PATTERNS,
  };

  for (const [pattern, info] of Object.entries(allPatterns)) {
    let startIndex = 0;
    while (true) {
      const index = lowerText.indexOf(pattern, startIndex);
      if (index === -1) break;

      highlights.push({
        start: index,
        end: index + pattern.length,
        category: info.category,
        label: info.label,
      });

      startIndex = index + 1;
    }
  }

  if (highlights.length === 0) return text;

  // Sort by start position
  highlights.sort((a, b) => a.start - b.start);

  // Remove overlapping highlights (keep first)
  const filtered = [];
  let lastEnd = 0;
  for (const h of highlights) {
    if (h.start >= lastEnd) {
      filtered.push(h);
      lastEnd = h.end;
    }
  }

  // Build JSX
  const result = [];
  let cursor = 0;

  filtered.forEach((h, i) => {
    // Add text before highlight
    if (h.start > cursor) {
      result.push(text.slice(cursor, h.start));
    }

    // Add highlighted term
    result.push(
      <mark
        key={i}
        className={`healthcare-highlight ${h.category}-highlight`}
        title={h.label}
      >
        {text.slice(h.start, h.end)}
      </mark>
    );

    cursor = h.end;
  });

  // Add remaining text
  if (cursor < text.length) {
    result.push(text.slice(cursor));
  }

  return result;
}

export default HealthcareTagsSummary;
