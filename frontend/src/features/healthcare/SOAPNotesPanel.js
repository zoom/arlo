import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { FileText, ChevronDown, ChevronRight, Loader2, RefreshCw, Check, AlertCircle, Tag, ClipboardCheck, LayoutTemplate } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Textarea from '../../components/ui/Textarea';
import './SOAPNotesPanel.css';

// Visit templates for quick-start documentation
const VISIT_TEMPLATES = [
  { id: 'blank', label: 'Blank', description: 'Start from scratch' },
  { id: 'follow-up', label: 'Follow-up', description: 'Routine follow-up visit' },
  { id: 'acute', label: 'Acute Visit', description: 'New problem or urgent issue' },
  { id: 'wellness', label: 'Wellness Exam', description: 'Annual physical / preventive' },
  { id: 'chronic', label: 'Chronic Care', description: 'Chronic condition management' },
];

// Demo ICD-10 codes based on assessment content — Chronic pain scenario
const SUGGESTED_CODES = [
  { code: 'M54.5', description: 'Low back pain', type: 'ICD-10', confidence: 0.98 },
  { code: 'E11.65', description: 'Type 2 diabetes with hyperglycemia', type: 'ICD-10', confidence: 0.95 },
  { code: 'I10', description: 'Essential hypertension', type: 'ICD-10', confidence: 0.92 },
  { code: 'F32.1', description: 'Major depressive disorder, moderate', type: 'ICD-10', confidence: 0.85 },
  { code: 'M54.41', description: 'Lumbago with sciatica, left side', type: 'ICD-10', confidence: 0.78 },
  { code: '99214', description: 'Office visit, established, moderate complexity', type: 'CPT', confidence: 0.94 },
];

// Quality measures for the visit
const QUALITY_MEASURES = [
  { id: 'cc', label: 'Chief complaint documented', required: true },
  { id: 'hpi', label: 'History of present illness', required: true },
  { id: 'vitals', label: 'Vital signs recorded', required: true },
  { id: 'assessment', label: 'Assessment/diagnosis', required: true },
  { id: 'plan', label: 'Treatment plan', required: true },
  { id: 'followup', label: 'Follow-up scheduled', required: false },
  { id: 'education', label: 'Patient education provided', required: false },
];

/**
 * SOAPNotesPanel — Real-time SOAP notes auto-population for healthcare vertical.
 *
 * Doctors can proofread and edit AI-generated notes instead of writing from scratch.
 * Each section updates as new transcript content arrives.
 */

const SOAP_SECTIONS = [
  {
    key: 'subjective',
    label: 'Subjective',
    shortLabel: 'S',
    description: 'Patient-reported symptoms, history, and concerns',
    placeholder: 'Chief complaint, history of present illness, patient statements...',
  },
  {
    key: 'objective',
    label: 'Objective',
    shortLabel: 'O',
    description: 'Observable, measurable findings',
    placeholder: 'Vital signs, physical exam findings, test results discussed...',
  },
  {
    key: 'assessment',
    label: 'Assessment',
    shortLabel: 'A',
    description: 'Clinical interpretation and diagnosis',
    placeholder: 'Diagnoses, differential diagnoses, clinical reasoning...',
  },
  {
    key: 'plan',
    label: 'Plan',
    shortLabel: 'P',
    description: 'Treatment plan and next steps',
    placeholder: 'Medications, referrals, follow-up, patient education...',
  },
];

export default function SOAPNotesPanel({ segments, meetingId, isLive }) {
  // Demo data for testing UI — Chronic pain management scenario for Maria Rodriguez
  const DEMO_SOAP_DATA = {
    subjective: `• Chief Complaint: Chronic low back pain follow-up
• Pain Level: Reports 5/10 today (baseline 6-7/10)
• Location: Lower lumbar region, bilateral
• Radiation: Occasional numbness down left leg
• Function: Able to walk 20 min now (vs. 10 min last visit)
• Sleep: Still waking 2-3×/night from pain
• Mood: "Feeling a bit better overall"
• Current Tx: Gabapentin helping, no side effects
• Diabetes: Checking sugars daily, mostly 120-150 fasting`,
    objective: `• Vitals: BP 134/86 | HR 72 | Temp 98.2°F | Weight 178 lbs (↓2 lbs)
• General: Alert, pleasant, mild discomfort when sitting
• Back: Tenderness L4-L5 paraspinal muscles, no midline tenderness
• Neuro: Strength 5/5 bilateral LE, reflexes 2+ symmetric
• Gait: Slightly antalgic, improved from prior visit
• Recent A1c: 7.2% (Feb 2026) — improved from 7.8%`,
    assessment: `1. Chronic low back pain — improving on current regimen
   → Functional gains noted, continue multimodal approach
2. Type 2 Diabetes — well-controlled (A1c 7.2%)
   → Continue current Metformin dose
3. Hypertension — borderline today (134/86)
   → May need adjustment if persists
4. Mild depression — stable on Duloxetine
   → Dual benefit for pain and mood`,
    plan: `1. CONTINUE: Current medication regimen (Gabapentin, Duloxetine, Metformin, Lisinopril)
2. ADD: Physical therapy referral — core strengthening, 2×/week × 6 weeks
3. CONSIDER: If pain not improving, may trial Gabapentin 400mg TID
4. LIFESTYLE:
   • Continue walking program — goal 30 min/day
   • Weight loss discussed — target 5 lbs over next 3 months
5. LABS: Recheck A1c in 3 months
6. FOLLOW-UP: 6 weeks for pain reassessment
7. PRECAUTION: Avoid NSAIDs — documented GI bleeding history`,
  };

  const [soapData, setSoapData] = useState(DEMO_SOAP_DATA);
  const [expandedSections, setExpandedSections] = useState({
    subjective: true,
    objective: true,
    assessment: true,
    plan: true,
  });
  const [editedSections, setEditedSections] = useState({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastProcessedCount, setLastProcessedCount] = useState(0);
  const [aiConfidence, setAiConfidence] = useState({
    subjective: 0.92,
    objective: 0.88,
    assessment: 0.75,
    plan: 0.85,
  });
  const [error, setError] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState('blank');
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [showCodes, setShowCodes] = useState(false);
  const [copiedCode, setCopiedCode] = useState(null);

  // Calculate quality measure completion based on SOAP content
  const qualityProgress = useMemo(() => {
    const checks = {
      cc: soapData.subjective?.includes('Chief Complaint') || soapData.subjective?.length > 20,
      hpi: soapData.subjective?.length > 50,
      vitals: soapData.objective?.includes('Vitals') || soapData.objective?.includes('BP'),
      assessment: soapData.assessment?.length > 20,
      plan: soapData.plan?.length > 20,
      followup: soapData.plan?.toLowerCase().includes('follow') || soapData.plan?.toLowerCase().includes('week'),
      education: soapData.plan?.toLowerCase().includes('counsel') || soapData.plan?.toLowerCase().includes('discuss'),
    };
    const required = QUALITY_MEASURES.filter(m => m.required);
    const completed = required.filter(m => checks[m.id]).length;
    return { checks, completed, total: required.length, percent: Math.round((completed / required.length) * 100) };
  }, [soapData]);

  // Copy code to clipboard
  const copyCode = (code) => {
    navigator.clipboard?.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  // Process transcript with AI to extract SOAP notes
  const processTranscript = useCallback(async (forceRefresh = false) => {
    if (!segments || segments.length === 0) return;

    // Only process if we have new content (or forcing refresh)
    if (!forceRefresh && segments.length === lastProcessedCount) return;

    setIsProcessing(true);
    setError(null);

    try {
      // Combine transcript text
      const transcriptText = segments
        .map(s => `${s.speakerLabel}: ${s.text}`)
        .join('\n');

      const res = await fetch('/api/ai/extract-soap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          meetingId,
          transcript: transcriptText,
          currentSoap: soapData,
        }),
      });

      if (res.ok) {
        const data = await res.json();

        // Merge AI results with user edits (user edits take precedence)
        setSoapData(prev => ({
          subjective: editedSections.subjective ? prev.subjective : (data.subjective || prev.subjective),
          objective: editedSections.objective ? prev.objective : (data.objective || prev.objective),
          assessment: editedSections.assessment ? prev.assessment : (data.assessment || prev.assessment),
          plan: editedSections.plan ? prev.plan : (data.plan || prev.plan),
        }));

        if (data.confidence) {
          setAiConfidence(data.confidence);
        }

        setLastProcessedCount(segments.length);
      } else {
        // API endpoint might not exist yet - use mock data for demo
        console.log('SOAP API not available, using demo mode');
        generateMockSOAPData(segments);
      }
    } catch (err) {
      console.error('Error processing SOAP notes:', err);
      // Fallback to mock data for demo
      generateMockSOAPData(segments);
    } finally {
      setIsProcessing(false);
    }
  }, [segments, meetingId, lastProcessedCount, soapData, editedSections]);

  // Generate mock SOAP data based on transcript content
  const generateMockSOAPData = useCallback((segs) => {
    if (!segs || segs.length === 0) return;

    const text = segs.map(s => s.text.toLowerCase()).join(' ');

    // Extract relevant content based on keywords
    const newSoap = { ...soapData };

    // Look for subjective content (symptoms, complaints)
    const symptomKeywords = ['pain', 'ache', 'hurts', 'feeling', 'noticed', 'started', 'worse', 'better', 'week', 'days'];
    const hasSymptoms = symptomKeywords.some(kw => text.includes(kw));
    if (hasSymptoms && !editedSections.subjective) {
      const relevantSegs = segs.filter(s =>
        symptomKeywords.some(kw => s.text.toLowerCase().includes(kw))
      );
      if (relevantSegs.length > 0) {
        newSoap.subjective = `Patient reports: ${relevantSegs.slice(0, 3).map(s => s.text).join(' ')}`;
      }
    }

    // Look for objective content (vitals, measurements)
    const objectiveKeywords = ['blood pressure', 'temperature', 'pulse', 'weight', 'height', 'exam', 'test'];
    const hasObjective = objectiveKeywords.some(kw => text.includes(kw));
    if (hasObjective && !editedSections.objective) {
      const relevantSegs = segs.filter(s =>
        objectiveKeywords.some(kw => s.text.toLowerCase().includes(kw))
      );
      if (relevantSegs.length > 0) {
        newSoap.objective = relevantSegs.slice(0, 2).map(s => s.text).join('\n');
      }
    }

    // Look for assessment/diagnosis
    const assessmentKeywords = ['diagnosis', 'think', 'appears', 'likely', 'suspect', 'condition'];
    const hasAssessment = assessmentKeywords.some(kw => text.includes(kw));
    if (hasAssessment && !editedSections.assessment) {
      const relevantSegs = segs.filter(s =>
        assessmentKeywords.some(kw => s.text.toLowerCase().includes(kw))
      );
      if (relevantSegs.length > 0) {
        newSoap.assessment = relevantSegs.slice(0, 2).map(s => s.text).join('\n');
      }
    }

    // Look for plan content
    const planKeywords = ['prescribe', 'recommend', 'follow-up', 'schedule', 'refer', 'medication', 'take'];
    const hasPlan = planKeywords.some(kw => text.includes(kw));
    if (hasPlan && !editedSections.plan) {
      const relevantSegs = segs.filter(s =>
        planKeywords.some(kw => s.text.toLowerCase().includes(kw))
      );
      if (relevantSegs.length > 0) {
        newSoap.plan = relevantSegs.slice(0, 2).map(s => s.text).join('\n');
      }
    }

    setSoapData(newSoap);
    setLastProcessedCount(segs.length);
  }, [soapData, editedSections]);

  // Auto-process when new segments arrive (debounced)
  useEffect(() => {
    if (!isLive || segments.length === 0) return;

    const timer = setTimeout(() => {
      processTranscript();
    }, 3000); // Process every 3 seconds of new content

    return () => clearTimeout(timer);
  }, [segments.length, isLive, processTranscript]);

  // Toggle section expansion
  const toggleSection = (key) => {
    setExpandedSections(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // Handle section edit
  const handleSectionChange = (key, value) => {
    setSoapData(prev => ({ ...prev, [key]: value }));
    setEditedSections(prev => ({ ...prev, [key]: true }));
  };

  // Clear user edit flag (revert to AI)
  const revertToAI = (key) => {
    setEditedSections(prev => ({ ...prev, [key]: false }));
    // Trigger re-process to get AI content
    processTranscript(true);
  };

  // Refresh all sections
  const handleRefreshAll = () => {
    setEditedSections({});
    processTranscript(true);
  };

  // Get confidence indicator
  const getConfidenceIndicator = (key) => {
    const confidence = aiConfidence[key];
    if (!confidence) return null;

    if (confidence >= 0.8) return { color: 'var(--healthcare-accent)', label: 'High' };
    if (confidence >= 0.5) return { color: '#f59e0b', label: 'Medium' };
    return { color: 'var(--destructive)', label: 'Low' };
  };

  return (
    <div className="soap-notes-panel">
      <div className="soap-header">
        <div className="soap-header-left">
          <FileText size={18} className="soap-header-icon" />
          <h3 className="text-serif font-medium">SOAP Notes</h3>

          {/* Template selector */}
          <div className="soap-template-selector">
            <button
              className="soap-template-btn"
              onClick={() => setShowTemplateMenu(!showTemplateMenu)}
            >
              <LayoutTemplate size={12} />
              <span className="text-xs">{VISIT_TEMPLATES.find(t => t.id === selectedTemplate)?.label}</span>
              <ChevronDown size={12} />
            </button>
            {showTemplateMenu && (
              <div className="soap-template-menu">
                {VISIT_TEMPLATES.map(template => (
                  <button
                    key={template.id}
                    className={`soap-template-option ${selectedTemplate === template.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedTemplate(template.id);
                      setShowTemplateMenu(false);
                    }}
                  >
                    <span className="text-sm font-medium">{template.label}</span>
                    <span className="text-xs text-muted">{template.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="soap-header-right">
          {/* Quality progress indicator */}
          <div className="soap-quality-indicator" title={`${qualityProgress.completed}/${qualityProgress.total} required items complete`}>
            <ClipboardCheck size={14} className={qualityProgress.percent === 100 ? 'quality-complete' : ''} />
            <span className={`text-xs ${qualityProgress.percent === 100 ? 'quality-complete' : 'text-muted'}`}>
              {qualityProgress.percent}%
            </span>
          </div>

          {isProcessing && (
            <span className="soap-processing">
              <Loader2 size={14} className="spin" />
              <span className="text-xs text-muted">Updating...</span>
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshAll}
            disabled={isProcessing || segments.length === 0}
            title="Refresh all sections"
          >
            <RefreshCw size={14} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="soap-error">
          <AlertCircle size={14} />
          <span className="text-sm">{error}</span>
        </div>
      )}

      <div className="soap-sections">
        {SOAP_SECTIONS.map((section) => {
          const isExpanded = expandedSections[section.key];
          const isEdited = editedSections[section.key];
          const confidenceInfo = getConfidenceIndicator(section.key);
          const hasContent = soapData[section.key]?.trim().length > 0;

          return (
            <Card key={section.key} className="soap-section-card">
              <button
                className="soap-section-header"
                onClick={() => toggleSection(section.key)}
              >
                <div className="soap-section-title">
                  <span className="soap-section-letter">{section.shortLabel}</span>
                  <span className="text-sans font-medium">{section.label}</span>
                  {hasContent && !isExpanded && (
                    <Check size={14} className="soap-has-content" />
                  )}
                  {isEdited && (
                    <span className="soap-edited-badge">Edited</span>
                  )}
                  {confidenceInfo && !isEdited && (
                    <span
                      className="soap-confidence-badge"
                      style={{ color: confidenceInfo.color }}
                    >
                      {confidenceInfo.label}
                    </span>
                  )}
                </div>
                {isExpanded ? (
                  <ChevronDown size={16} className="text-muted" />
                ) : (
                  <ChevronRight size={16} className="text-muted" />
                )}
              </button>

              {isExpanded && (
                <div className="soap-section-content">
                  <p className="soap-section-description text-xs text-muted">
                    {section.description}
                  </p>
                  <Textarea
                    value={soapData[section.key]}
                    onChange={(e) => handleSectionChange(section.key, e.target.value)}
                    placeholder={section.placeholder}
                    className="soap-textarea"
                    rows={4}
                  />
                  {isEdited && (
                    <button
                      className="soap-revert-btn text-xs"
                      onClick={() => revertToAI(section.key)}
                    >
                      Revert to AI suggestion
                    </button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Suggested billing codes - collapsible */}
      {(soapData.assessment || soapData.plan) && (
        <div className="soap-codes-section">
          <button
            className="soap-codes-header"
            onClick={() => setShowCodes(!showCodes)}
          >
            <Tag size={14} className="soap-codes-icon" />
            <span className="text-sm font-medium">Suggested Codes</span>
            <span className="soap-codes-count">{SUGGESTED_CODES.length}</span>
            {showCodes ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>

          {showCodes && (
            <div className="soap-codes-list">
              {SUGGESTED_CODES.map((item, i) => (
                <button
                  key={i}
                  className="soap-code-item"
                  onClick={() => copyCode(item.code)}
                  title="Click to copy"
                >
                  <span className={`soap-code-badge ${item.type.toLowerCase()}`}>
                    {item.type}
                  </span>
                  <span className="soap-code-value">{item.code}</span>
                  <span className="soap-code-desc text-xs text-muted">{item.description}</span>
                  <span className="soap-code-confidence text-xs" style={{
                    color: item.confidence >= 0.8 ? 'var(--healthcare-accent)' : '#f59e0b'
                  }}>
                    {copiedCode === item.code ? '✓ Copied' : `${Math.round(item.confidence * 100)}%`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {segments.length === 0 && !soapData.subjective && !soapData.objective && !soapData.assessment && !soapData.plan && (
        <p className="soap-empty-state text-sm text-muted">
          SOAP notes will auto-populate as the conversation progresses.
        </p>
      )}
    </div>
  );
}
