import React, { useState } from 'react';
import { User, FileText, Calendar, Building, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import Card from '../../components/ui/Card';
import './CandidateContext.css';

/**
 * CandidateContext — BrightHire-style candidate background panel.
 *
 * Displays relevant context about the candidate for interviewers:
 * - Resume/CV summary
 * - Prior interview history and feedback
 * - Current stage in hiring pipeline
 * - Notes from recruiter/hiring manager
 */

// Demo data for showcase
const DEMO_CANDIDATE = {
  name: 'Sarah Chen',
  email: 'sarah.chen@example.com',
  role: 'Senior Software Engineer',
  stage: 'Technical Interview',
  recruiter: 'Alex Johnson',
  source: 'LinkedIn',
  applied: '2026-10-28',
  resume: {
    currentRole: 'Software Engineer at Stripe',
    experience: '6 years',
    education: 'BS Computer Science, Stanford',
    skills: ['Python', 'Go', 'Kubernetes', 'PostgreSQL', 'React'],
    highlights: [
      'Led migration of payment processing system to microservices',
      'Reduced P99 latency by 40% through caching optimization',
      'Mentored 3 junior engineers',
    ],
  },
  priorInterviews: [
    {
      type: 'Phone Screen',
      interviewer: 'Alex Johnson',
      date: '2026-11-01',
      verdict: 'advance',
      notes: 'Strong communication, good technical foundation. Recommended for onsite.',
    },
    {
      type: 'Hiring Manager',
      interviewer: 'Jordan Lee',
      date: '2026-11-05',
      verdict: 'advance',
      notes: 'Clear thinker, asked great questions about team dynamics.',
    },
  ],
  recruiterNotes: 'Candidate is very interested in our distributed systems work. Currently interviewing with 2 other companies, timeline is 2 weeks.',
};

export default function CandidateContext({
  candidate = DEMO_CANDIDATE,
  showDemoData = true,
}) {
  const [expandedSection, setExpandedSection] = useState('resume');

  const data = showDemoData || !candidate ? DEMO_CANDIDATE : candidate;

  const toggleSection = (section) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  const getVerdictBadge = (verdict) => {
    switch (verdict) {
      case 'advance':
        return <span className="verdict-badge advance">Advance</span>;
      case 'hold':
        return <span className="verdict-badge hold">Hold</span>;
      case 'reject':
        return <span className="verdict-badge reject">No Hire</span>;
      default:
        return null;
    }
  };

  return (
    <Card className="candidate-context">
      {/* Header */}
      <div className="candidate-header">
        <div className="candidate-avatar">
          <User size={24} />
        </div>
        <div className="candidate-info">
          <h3 className="text-serif font-medium">{data.name}</h3>
          <p className="text-sans text-sm text-muted">{data.role}</p>
        </div>
        <div className="candidate-stage">
          <span className="stage-badge">{data.stage}</span>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="candidate-stats">
        <div className="candidate-stat">
          <Building size={14} />
          <span className="text-xs">{data.resume?.currentRole}</span>
        </div>
        <div className="candidate-stat">
          <Calendar size={14} />
          <span className="text-xs">Applied {new Date(data.applied).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Expandable Sections */}
      <div className="candidate-sections">
        {/* Resume Summary */}
        <div className="candidate-section">
          <button
            className="section-header"
            onClick={() => toggleSection('resume')}
          >
            <div className="section-title">
              <FileText size={16} />
              <span className="text-sm font-medium">Resume Summary</span>
            </div>
            {expandedSection === 'resume' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {expandedSection === 'resume' && (
            <div className="section-content">
              <div className="resume-grid">
                <div className="resume-item">
                  <span className="text-xs text-muted">Experience</span>
                  <span className="text-sm">{data.resume?.experience}</span>
                </div>
                <div className="resume-item">
                  <span className="text-xs text-muted">Education</span>
                  <span className="text-sm">{data.resume?.education}</span>
                </div>
              </div>

              <div className="resume-skills">
                <span className="text-xs text-muted">Skills</span>
                <div className="skill-tags">
                  {data.resume?.skills?.map(skill => (
                    <span key={skill} className="skill-tag">{skill}</span>
                  ))}
                </div>
              </div>

              <div className="resume-highlights">
                <span className="text-xs text-muted">Key Highlights</span>
                <ul className="highlights-list">
                  {data.resume?.highlights?.map((h, i) => (
                    <li key={i} className="text-xs">{h}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Prior Interviews */}
        <div className="candidate-section">
          <button
            className="section-header"
            onClick={() => toggleSection('history')}
          >
            <div className="section-title">
              <Calendar size={16} />
              <span className="text-sm font-medium">Prior Interviews ({data.priorInterviews?.length || 0})</span>
            </div>
            {expandedSection === 'history' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {expandedSection === 'history' && (
            <div className="section-content">
              {data.priorInterviews?.map((interview, i) => (
                <div key={i} className="prior-interview">
                  <div className="interview-header">
                    <div className="interview-type">
                      <span className="text-sm font-medium">{interview.type}</span>
                      <span className="text-xs text-muted">
                        {interview.interviewer} · {new Date(interview.date).toLocaleDateString()}
                      </span>
                    </div>
                    {getVerdictBadge(interview.verdict)}
                  </div>
                  <p className="text-xs interview-notes">{interview.notes}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recruiter Notes */}
        {data.recruiterNotes && (
          <div className="candidate-section">
            <button
              className="section-header"
              onClick={() => toggleSection('notes')}
            >
              <div className="section-title">
                <User size={16} />
                <span className="text-sm font-medium">Recruiter Notes</span>
              </div>
              {expandedSection === 'notes' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {expandedSection === 'notes' && (
              <div className="section-content">
                <p className="text-sm recruiter-notes">{data.recruiterNotes}</p>
                <p className="text-xs text-muted" style={{ marginTop: 8 }}>
                  — {data.recruiter}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ATS Link (placeholder) */}
      <button className="candidate-ats-link">
        <ExternalLink size={14} />
        <span className="text-xs">View in ATS</span>
      </button>
    </Card>
  );
}
