/**
 * Compliance Rules Configuration
 *
 * Each vertical has its own set of compliance rules with:
 * - keywords: Exact or partial phrase matches
 * - patterns: Regex patterns for more complex matching
 * - severity: 'info' | 'warning' | 'critical'
 * - category: Grouping for the alert
 * - message: What to show the user
 * - suggestion: Recommended action
 */

export const complianceRules = {
  // ═══════════════════════════════════════════════════════════════════════════
  // HEALTHCARE - HIPAA, PHI, Medical Advice
  // ═══════════════════════════════════════════════════════════════════════════
  healthcare: [
    {
      id: 'hipaa-phi-name',
      category: 'HIPAA / PHI',
      severity: 'critical',
      keywords: ['patient name is', 'the patient is', 'their name is'],
      message: 'Potential PHI disclosure detected',
      suggestion: 'Avoid stating patient names in recorded sessions. Use "the patient" instead.',
    },
    {
      id: 'hipaa-ssn',
      category: 'HIPAA / PHI',
      severity: 'critical',
      patterns: [/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/], // SSN pattern
      message: 'Possible SSN mentioned',
      suggestion: 'Never state Social Security Numbers verbally. Request via secure channel.',
    },
    {
      id: 'hipaa-dob',
      category: 'HIPAA / PHI',
      severity: 'warning',
      keywords: ['date of birth is', 'born on', 'birthday is'],
      message: 'Date of birth mentioned',
      suggestion: 'Verify patient identity through secure methods, not verbal confirmation.',
    },
    {
      id: 'medical-advice-disclaimer',
      category: 'Medical Advice',
      severity: 'warning',
      keywords: ['you should take', 'i recommend you take', 'just take some'],
      message: 'Medical recommendation without context',
      suggestion: 'Ensure proper documentation and patient consent before treatment recommendations.',
    },
    {
      id: 'diagnosis-caution',
      category: 'Medical Advice',
      severity: 'info',
      keywords: ['i think you have', 'it looks like you have', 'you probably have'],
      message: 'Informal diagnosis language detected',
      suggestion: 'Use clinical terminology and document findings properly.',
    },
    {
      id: 'third-party-phi',
      category: 'HIPAA / PHI',
      severity: 'critical',
      keywords: ['another patient', 'other patient', 'someone else who had'],
      message: 'Potential third-party PHI disclosure',
      suggestion: 'Never reference other patients, even anonymously, without proper consent.',
    },
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  // LEGAL - Privilege, Confidentiality, Unauthorized Advice
  // ═══════════════════════════════════════════════════════════════════════════
  legal: [
    {
      id: 'privilege-waiver',
      category: 'Attorney-Client Privilege',
      severity: 'critical',
      keywords: ['my client told me', 'client admitted', 'client confessed'],
      message: 'Potential privilege waiver',
      suggestion: 'Avoid discussing privileged communications in non-privileged settings.',
    },
    {
      id: 'unauthorized-advice',
      category: 'Unauthorized Practice',
      severity: 'warning',
      keywords: ['you should sue', 'you have a case', 'you will win'],
      message: 'Potential unauthorized legal advice',
      suggestion: 'Ensure proper engagement letter before providing legal opinions.',
    },
    {
      id: 'confidential-settlement',
      category: 'Confidentiality',
      severity: 'critical',
      keywords: ['settlement amount', 'they offered', 'we settled for'],
      message: 'Confidential settlement terms mentioned',
      suggestion: 'Settlement terms are typically confidential. Verify before discussing.',
    },
    {
      id: 'off-record',
      category: 'Record Integrity',
      severity: 'warning',
      keywords: ['off the record', 'between us', 'dont tell anyone'],
      message: '"Off the record" statement detected',
      suggestion: 'This session is being recorded. All statements are on the record.',
    },
    {
      id: 'witness-coaching',
      category: 'Ethics',
      severity: 'critical',
      keywords: ['just say that', 'tell them that', 'dont mention'],
      message: 'Potential witness coaching detected',
      suggestion: 'Avoid language that could be construed as witness coaching.',
    },
    {
      id: 'conflict-disclosure',
      category: 'Conflicts',
      severity: 'warning',
      keywords: ['i also represent', 'conflict of interest', 'on the other side'],
      message: 'Potential conflict of interest mentioned',
      suggestion: 'Document and disclose any conflicts per ethics rules.',
    },
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  // SALES - Promises, Pricing, Competitor Statements
  // ═══════════════════════════════════════════════════════════════════════════
  sales: [
    {
      id: 'unauthorized-discount',
      category: 'Pricing',
      severity: 'warning',
      keywords: ['i can give you', 'special discount', 'just for you', 'off the books'],
      message: 'Potential unauthorized discount offered',
      suggestion: 'Verify discount authority before committing. Document in CRM.',
    },
    {
      id: 'guarantee-promise',
      category: 'Promises',
      severity: 'critical',
      keywords: ['i guarantee', 'i promise', '100 percent', 'definitely will', 'absolutely will'],
      message: 'Guarantee language detected',
      suggestion: 'Avoid absolute guarantees. Use "typically" or "in most cases" instead.',
    },
    {
      id: 'competitor-disparagement',
      category: 'Competitor Statements',
      severity: 'warning',
      keywords: ['they are terrible', 'their product sucks', 'they are going out of business', 'dont use them'],
      message: 'Competitor disparagement detected',
      suggestion: 'Focus on your product strengths rather than competitor weaknesses.',
    },
    {
      id: 'false-scarcity',
      category: 'Sales Tactics',
      severity: 'warning',
      keywords: ['only today', 'last chance', 'prices going up tomorrow', 'limited time'],
      message: 'Urgency/scarcity tactic detected',
      suggestion: 'Ensure any scarcity claims are accurate and documented.',
    },
    {
      id: 'feature-promise',
      category: 'Product Claims',
      severity: 'warning',
      keywords: ['coming soon', 'on the roadmap', 'we will have', 'next release'],
      message: 'Future feature promise detected',
      suggestion: 'Avoid committing to unreleased features. Check with Product team.',
    },
    {
      id: 'contract-modification',
      category: 'Contract Terms',
      severity: 'critical',
      keywords: ['we can change the contract', 'ignore that clause', 'dont worry about that term'],
      message: 'Unauthorized contract modification suggested',
      suggestion: 'Contract changes require legal review. Do not promise modifications.',
    },
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  // SUPPORT - SLA, Refunds, Escalation
  // ═══════════════════════════════════════════════════════════════════════════
  support: [
    {
      id: 'unauthorized-refund',
      category: 'Refunds',
      severity: 'warning',
      keywords: ['full refund', 'money back', 'i will refund', 'refund you'],
      message: 'Refund commitment detected',
      suggestion: 'Verify refund policy and authorization limits before committing.',
    },
    {
      id: 'sla-promise',
      category: 'SLA',
      severity: 'warning',
      keywords: ['within 24 hours', 'by tomorrow', 'right away', 'immediately fix'],
      message: 'Time-bound commitment detected',
      suggestion: 'Check SLA terms before committing to specific timeframes.',
    },
    {
      id: 'blame-engineering',
      category: 'Internal Attribution',
      severity: 'info',
      keywords: ['engineering messed up', 'its a bug', 'developers fault', 'known issue'],
      message: 'Internal blame language detected',
      suggestion: 'Focus on resolution, not blame. Use "we are working on it" instead.',
    },
    {
      id: 'credit-promise',
      category: 'Credits',
      severity: 'warning',
      keywords: ['free month', 'credit your account', 'free upgrade', 'complimentary'],
      message: 'Credit/compensation offered',
      suggestion: 'Verify authorization for credits. Document in ticket.',
    },
    {
      id: 'escalation-threat',
      category: 'Escalation',
      severity: 'info',
      keywords: ['supervisor', 'manager', 'escalate', 'speak to someone else', 'cancel my account'],
      message: 'Escalation trigger detected',
      suggestion: 'Customer may need elevated support. Consider proactive escalation.',
    },
    {
      id: 'legal-threat',
      category: 'Legal',
      severity: 'critical',
      keywords: ['lawyer', 'lawsuit', 'sue', 'legal action', 'attorney'],
      message: 'Legal threat detected',
      suggestion: 'Do not respond to legal threats. Escalate to Legal team immediately.',
    },
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTES (General) - Universal Compliance
  // ═══════════════════════════════════════════════════════════════════════════
  notes: [
    {
      id: 'discrimination-language',
      category: 'HR / Discrimination',
      severity: 'critical',
      keywords: ['because of your age', 'too old', 'too young', 'because youre a woman', 'because youre a man'],
      message: 'Potentially discriminatory language',
      suggestion: 'Avoid any language that could be perceived as discriminatory.',
    },
    {
      id: 'harassment-indicator',
      category: 'HR / Harassment',
      severity: 'critical',
      keywords: ['dont tell hr', 'keep this between us', 'youre being too sensitive'],
      message: 'Potential harassment indicator',
      suggestion: 'This language may indicate a hostile work environment. Document concerns.',
    },
    {
      id: 'confidential-info',
      category: 'Confidentiality',
      severity: 'warning',
      keywords: ['confidential', 'dont share this', 'internal only', 'not public'],
      message: 'Confidential information discussed',
      suggestion: 'Ensure this meeting has appropriate attendees for confidential content.',
    },
    {
      id: 'recording-awareness',
      category: 'Recording Consent',
      severity: 'info',
      keywords: ['is this being recorded', 'are you recording', 'dont record'],
      message: 'Recording awareness mentioned',
      suggestion: 'Confirm all participants consent to recording.',
    },
    {
      id: 'pii-disclosure',
      category: 'PII',
      severity: 'warning',
      patterns: [
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
        /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, // Phone number
      ],
      message: 'PII (email/phone) detected in conversation',
      suggestion: 'Avoid stating PII verbally when being recorded.',
    },
  ],
};

/**
 * Get compliance rules for a specific vertical
 */
export function getRulesForVertical(vertical) {
  return complianceRules[vertical] || complianceRules.notes;
}

/**
 * Get all available verticals with compliance rules
 */
export function getComplianceVerticals() {
  return Object.keys(complianceRules);
}

export default complianceRules;
