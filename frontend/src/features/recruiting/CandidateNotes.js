import React, { useState, useEffect } from 'react';
import { FileText, Lightbulb, HelpCircle, Building, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import Textarea from '../../components/ui/Textarea';
import './CandidateNotes.css';

/**
 * CandidateNotes — Candidate-facing panel for interview preparation and note-taking.
 *
 * Features:
 * - Company-provided prep notes and prompts (read-only)
 * - Personal notes area for the candidate
 * - FAQ section with common questions
 * - Job/role information card
 *
 * This provides a low-pressure, helpful experience for candidates
 * rather than surveillance-style monitoring.
 */

// Demo company prep content (in production, this comes from the company's setup)
const DEMO_PREP_CONTENT = {
  companyName: 'Acme Corp',
  roleName: 'Senior Software Engineer',
  welcomeMessage: `Welcome to your interview! We're excited to learn more about you.

This session will last approximately 45 minutes. Feel free to ask questions at any time.`,
  prepNotes: [
    "We'll start with introductions and a brief overview of the role",
    "Be ready to discuss a challenging technical project you've worked on",
    "We value concrete examples — think of specific situations you can share",
    "At the end, you'll have time to ask us questions about the team and role",
  ],
  tips: [
    "Take your time to think before answering — it's okay to pause",
    "If you need clarification on a question, just ask",
    "Use the STAR method: Situation, Task, Action, Result",
  ],
  faq: [
    {
      q: "What is the team structure?",
      a: "You would join a team of 6 engineers working on our core platform. The team follows agile practices with 2-week sprints.",
    },
    {
      q: "What is the interview process?",
      a: "Today is a technical screen. If we move forward, you'll have a virtual onsite with 4 sessions: system design, coding, behavioral, and team fit.",
    },
    {
      q: "Is this position remote?",
      a: "Yes, this is a remote-first position. We have team members across multiple time zones and meet in person quarterly.",
    },
  ],
};

export default function CandidateNotes({
  prepContent = DEMO_PREP_CONTENT,
  onNotesChange,
  showDemoData = true,
}) {
  const [personalNotes, setPersonalNotes] = useState('');
  const [expandedFaq, setExpandedFaq] = useState(null);
  const [activeSection, setActiveSection] = useState('prep');

  const content = showDemoData || !prepContent ? DEMO_PREP_CONTENT : prepContent;

  // Auto-save notes to localStorage
  useEffect(() => {
    const saved = localStorage.getItem('arlo-candidate-notes');
    if (saved) {
      setPersonalNotes(saved);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('arlo-candidate-notes', personalNotes);
    onNotesChange?.(personalNotes);
  }, [personalNotes, onNotesChange]);

  return (
    <div className="candidate-notes">
      {/* Welcome Header */}
      <Card className="candidate-welcome">
        <div className="welcome-header">
          <Building size={20} className="welcome-icon" />
          <div className="welcome-text">
            <h3 className="text-serif font-medium">{content.companyName}</h3>
            <p className="text-sm text-muted">{content.roleName}</p>
          </div>
        </div>
        <p className="welcome-message text-sm">{content.welcomeMessage}</p>
      </Card>

      {/* Section Tabs */}
      <div className="candidate-tabs">
        <button
          className={`candidate-tab ${activeSection === 'prep' ? 'active' : ''}`}
          onClick={() => setActiveSection('prep')}
        >
          <Lightbulb size={16} />
          Prep Notes
        </button>
        <button
          className={`candidate-tab ${activeSection === 'notes' ? 'active' : ''}`}
          onClick={() => setActiveSection('notes')}
        >
          <FileText size={16} />
          My Notes
        </button>
        <button
          className={`candidate-tab ${activeSection === 'faq' ? 'active' : ''}`}
          onClick={() => setActiveSection('faq')}
        >
          <HelpCircle size={16} />
          FAQ
        </button>
      </div>

      {/* Prep Notes Section */}
      {activeSection === 'prep' && (
        <Card className="candidate-section-card">
          <h4 className="text-sm font-medium section-title">What to Expect</h4>
          <ul className="prep-list">
            {content.prepNotes.map((note, i) => (
              <li key={i} className="prep-item">
                <span className="prep-number">{i + 1}</span>
                <span className="text-sm">{note}</span>
              </li>
            ))}
          </ul>

          <h4 className="text-sm font-medium section-title" style={{ marginTop: 16 }}>Tips</h4>
          <ul className="tips-list">
            {content.tips.map((tip, i) => (
              <li key={i} className="text-sm text-muted">
                <Lightbulb size={12} className="tip-icon" />
                {tip}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Personal Notes Section */}
      {activeSection === 'notes' && (
        <Card className="candidate-section-card">
          <h4 className="text-sm font-medium section-title">Your Notes</h4>
          <p className="text-xs text-muted" style={{ marginBottom: 12 }}>
            Jot down questions to ask, points to mention, or anything you want to remember.
            These notes are private and only visible to you.
          </p>
          <Textarea
            value={personalNotes}
            onChange={(e) => setPersonalNotes(e.target.value)}
            placeholder="• Questions I want to ask...
• Things I want to mention...
• Key points from my experience..."
            className="candidate-notes-textarea"
            rows={8}
          />
          <p className="text-xs text-muted notes-saved-indicator">
            {personalNotes.length > 0 ? '✓ Auto-saved' : ''}
          </p>
        </Card>
      )}

      {/* FAQ Section */}
      {activeSection === 'faq' && (
        <Card className="candidate-section-card">
          <h4 className="text-sm font-medium section-title">Frequently Asked Questions</h4>
          <div className="faq-list">
            {content.faq.map((item, i) => (
              <div key={i} className="faq-item">
                <button
                  className="faq-question"
                  onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                >
                  <span className="text-sm">{item.q}</span>
                  {expandedFaq === i ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {expandedFaq === i && (
                  <p className="faq-answer text-sm text-muted">{item.a}</p>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
