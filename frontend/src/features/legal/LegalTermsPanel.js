import React, { useState, useMemo } from 'react';
import { BookOpen, ChevronDown, ChevronUp, Copy, Check, Search, ExternalLink } from 'lucide-react';
import Card from '../../components/ui/Card';
import './LegalTermsPanel.css';

/**
 * LegalTermsPanel — Extracts and organizes key legal terms from testimony.
 *
 * Features:
 * - Auto-detection of legal terminology, case citations, statutes
 * - Categorization: Parties, Dates, Amounts, Locations, Documents, Citations
 * - Click to jump to transcript reference
 * - Copy individual terms or full list
 */

// Demo extracted terms for testing — Employment discrimination case (Thompson v. Nexus Technologies)
const DEMO_TERMS = {
  parties: [
    { id: 1, term: 'Patricia Hernandez', role: 'HR Director / Deponent', mentions: 32, firstSeqNo: 1 },
    { id: 2, term: 'David Thompson', role: 'Plaintiff', mentions: 28, firstSeqNo: 8 },
    { id: 3, term: 'Nexus Technologies Inc.', role: 'Defendant', mentions: 15, firstSeqNo: 12 },
    { id: 4, term: 'Michael Chen', role: 'CEO (decision-maker)', mentions: 11, firstSeqNo: 42 },
    { id: 5, term: 'Jennifer Walsh', role: 'Plaintiff\'s Counsel', mentions: 8, firstSeqNo: 3 },
    { id: 6, term: 'Raj Patel', role: 'Plaintiff\'s Direct Supervisor', mentions: 6, firstSeqNo: 58 },
  ],
  dates: [
    { id: 1, term: 'January 15, 2025', context: 'Annual performance review', mentions: 4, firstSeqNo: 35 },
    { id: 2, term: 'February 28, 2025', context: 'EEOC complaint filed', mentions: 3, firstSeqNo: 78 },
    { id: 3, term: 'March 15, 2025', context: 'PIP issued to plaintiff', mentions: 5, firstSeqNo: 48 },
    { id: 4, term: 'April 22, 2025', context: 'Termination date', mentions: 7, firstSeqNo: 98 },
    { id: 5, term: 'October 2024', context: 'Plaintiff promoted to Senior Engineer', mentions: 2, firstSeqNo: 28 },
  ],
  amounts: [
    { id: 1, term: '$185,000', context: 'Plaintiff\'s annual salary', mentions: 2, firstSeqNo: 38 },
    { id: 2, term: '$45,000', context: 'Severance offered', mentions: 2, firstSeqNo: 112 },
    { id: 3, term: '18 years', context: 'Plaintiff\'s tenure at company', mentions: 4, firstSeqNo: 22 },
    { id: 4, term: '52 years old', context: 'Plaintiff\'s age at termination', mentions: 3, firstSeqNo: 15 },
  ],
  locations: [
    { id: 1, term: 'Building C, Conference Room 4B', context: 'Termination meeting location', mentions: 3, firstSeqNo: 98 },
    { id: 2, term: 'HR Office, 3rd Floor', context: 'PIP delivery location', mentions: 2, firstSeqNo: 48 },
  ],
  documents: [
    { id: 1, term: 'Performance Improvement Plan', context: 'Dated March 15, 2025', mentions: 12, firstSeqNo: 48 },
    { id: 2, term: 'Annual Performance Review', context: 'January 2025 — "Meets Expectations"', mentions: 6, firstSeqNo: 35 },
    { id: 3, term: 'EEOC Charge of Discrimination', context: 'Filed Feb 28, 2025 (age discrimination)', mentions: 5, firstSeqNo: 78 },
    { id: 4, term: 'Termination Letter', context: 'Dated April 22, 2025', mentions: 4, firstSeqNo: 98 },
    { id: 5, term: 'Email from M. Chen', context: 'Re: "Refreshing the team" — March 2, 2025', mentions: 3, firstSeqNo: 88 },
  ],
  citations: [
    { id: 1, term: 'ADEA, 29 U.S.C. § 623', context: 'Age Discrimination in Employment Act', mentions: 2, firstSeqNo: 145 },
    { id: 2, term: 'McDonnell Douglas burden-shifting', context: 'Framework for discrimination claims', mentions: 2, firstSeqNo: 156 },
    { id: 3, term: 'Title VII, 42 U.S.C. § 2000e-3(a)', context: 'Retaliation provision', mentions: 1, firstSeqNo: 168 },
  ],
};

const CATEGORY_CONFIG = {
  parties: { label: 'Parties & Witnesses', icon: '👤', color: '#8b5cf6' },
  dates: { label: 'Key Dates', icon: '📅', color: '#0d9488' },
  amounts: { label: 'Amounts & Figures', icon: '💰', color: '#059669' },
  locations: { label: 'Locations', icon: '📍', color: '#dc2626' },
  documents: { label: 'Documents', icon: '📄', color: '#f59e0b' },
  citations: { label: 'Legal Citations', icon: '⚖️', color: '#6366f1' },
};

export default function LegalTermsPanel({ segments, onJumpToSegment }) {
  const [expandedCategories, setExpandedCategories] = useState(['parties', 'dates']);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedTerm, setCopiedTerm] = useState(null);

  // Filter terms by search
  const filteredTerms = useMemo(() => {
    if (!searchQuery.trim()) return DEMO_TERMS;

    const query = searchQuery.toLowerCase();
    const filtered = {};

    Object.entries(DEMO_TERMS).forEach(([category, terms]) => {
      const matches = terms.filter(t =>
        t.term.toLowerCase().includes(query) ||
        (t.context && t.context.toLowerCase().includes(query)) ||
        (t.role && t.role.toLowerCase().includes(query))
      );
      if (matches.length > 0) {
        filtered[category] = matches;
      }
    });

    return filtered;
  }, [searchQuery]);

  const toggleCategory = (category) => {
    setExpandedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  };

  const copyTerm = (term) => {
    navigator.clipboard?.writeText(term);
    setCopiedTerm(term);
    setTimeout(() => setCopiedTerm(null), 2000);
  };

  const copyAllTerms = () => {
    const allTerms = Object.entries(DEMO_TERMS)
      .map(([category, terms]) => {
        const config = CATEGORY_CONFIG[category];
        return `${config.label}:\n${terms.map(t => `  - ${t.term}${t.context ? ` (${t.context})` : ''}`).join('\n')}`;
      })
      .join('\n\n');

    navigator.clipboard?.writeText(allTerms);
    setCopiedTerm('all');
    setTimeout(() => setCopiedTerm(null), 2000);
  };

  const totalTerms = Object.values(DEMO_TERMS).reduce((sum, terms) => sum + terms.length, 0);

  return (
    <Card className="legal-terms-panel">
      <div className="legal-terms-header">
        <div className="legal-terms-title">
          <BookOpen size={18} className="legal-terms-icon" />
          <h3 className="text-serif font-medium">Key Terms</h3>
          <span className="legal-terms-count">{totalTerms}</span>
        </div>

        <div className="legal-terms-actions">
          <button
            className="legal-terms-copy-all"
            onClick={copyAllTerms}
            title="Copy all terms"
          >
            {copiedTerm === 'all' ? <Check size={14} /> : <Copy size={14} />}
            <span className="text-xs">{copiedTerm === 'all' ? 'Copied!' : 'Copy All'}</span>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="legal-terms-search">
        <Search size={14} className="legal-terms-search-icon" />
        <input
          type="text"
          placeholder="Search terms..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="legal-terms-search-input"
        />
      </div>

      {/* Categories */}
      <div className="legal-terms-categories">
        {Object.entries(filteredTerms).map(([category, terms]) => {
          const config = CATEGORY_CONFIG[category];
          const isExpanded = expandedCategories.includes(category);

          return (
            <div key={category} className="legal-terms-category">
              <button
                className="legal-terms-category-header"
                onClick={() => toggleCategory(category)}
              >
                <span className="legal-terms-category-icon">{config.icon}</span>
                <span className="legal-terms-category-label">{config.label}</span>
                <span className="legal-terms-category-count">{terms.length}</span>
                {isExpanded ? (
                  <ChevronUp size={14} className="text-muted" />
                ) : (
                  <ChevronDown size={14} className="text-muted" />
                )}
              </button>

              {isExpanded && (
                <div className="legal-terms-list">
                  {terms.map(item => (
                    <div key={item.id} className="legal-term-item">
                      <div className="legal-term-main">
                        <span
                          className="legal-term-value"
                          style={{ '--term-color': config.color }}
                        >
                          {item.term}
                        </span>
                        {item.role && (
                          <span className="legal-term-role">{item.role}</span>
                        )}
                      </div>
                      {item.context && (
                        <p className="legal-term-context text-xs text-muted">{item.context}</p>
                      )}
                      <div className="legal-term-meta">
                        <span className="legal-term-mentions text-xs text-muted">
                          {item.mentions} mention{item.mentions !== 1 ? 's' : ''}
                        </span>
                        <div className="legal-term-actions">
                          <button
                            className="legal-term-action"
                            onClick={() => copyTerm(item.term)}
                            title="Copy term"
                          >
                            {copiedTerm === item.term ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                          <button
                            className="legal-term-action"
                            onClick={() => onJumpToSegment?.(item.firstSeqNo)}
                            title="Jump to first mention"
                          >
                            <ExternalLink size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {Object.keys(filteredTerms).length === 0 && (
          <p className="legal-terms-empty text-sm text-muted">
            No terms match "{searchQuery}"
          </p>
        )}
      </div>
    </Card>
  );
}
