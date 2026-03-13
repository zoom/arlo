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

// Demo extracted terms for testing
const DEMO_TERMS = {
  parties: [
    { id: 1, term: 'John Smith', role: 'Witness/Deponent', mentions: 24, firstSeqNo: 1 },
    { id: 2, term: 'Davis Corporation', role: 'Defendant', mentions: 12, firstSeqNo: 15 },
    { id: 3, term: 'Sarah Mitchell', role: 'Additional Witness', mentions: 8, firstSeqNo: 42 },
    { id: 4, term: 'Robert Chen', role: 'Plaintiff\'s Counsel', mentions: 6, firstSeqNo: 3 },
  ],
  dates: [
    { id: 1, term: 'March 15, 2024', context: 'Alleged meeting date', mentions: 3, firstSeqNo: 28 },
    { id: 2, term: 'January 2023', context: 'Contract execution', mentions: 2, firstSeqNo: 45 },
    { id: 3, term: 'April 1, 2024', context: 'Alternative meeting date mentioned', mentions: 2, firstSeqNo: 89 },
    { id: 4, term: 'December 2022', context: 'Initial negotiations began', mentions: 1, firstSeqNo: 67 },
  ],
  amounts: [
    { id: 1, term: '$50,000', context: 'Initial contract value stated', mentions: 2, firstSeqNo: 28 },
    { id: 2, term: '$75,000', context: 'Final agreed amount (conflicting)', mentions: 1, firstSeqNo: 98 },
    { id: 3, term: '$15,000', context: 'Down payment referenced', mentions: 1, firstSeqNo: 112 },
  ],
  locations: [
    { id: 1, term: 'Downtown office, Main Street', context: 'Primary meeting location', mentions: 4, firstSeqNo: 22 },
    { id: 2, term: 'Conference center near airport', context: 'Alternative location mentioned', mentions: 1, firstSeqNo: 128 },
  ],
  documents: [
    { id: 1, term: 'Service Agreement', context: 'Primary contract at issue', mentions: 8, firstSeqNo: 34 },
    { id: 2, term: 'Amendment No. 1', context: 'Modification to original agreement', mentions: 3, firstSeqNo: 56 },
    { id: 3, term: 'Email dated 2/14/24', context: 'Communication re: terms', mentions: 2, firstSeqNo: 78 },
  ],
  citations: [
    { id: 1, term: 'Cal. Civ. Code § 1542', context: 'General release provision', mentions: 1, firstSeqNo: 145 },
    { id: 2, term: 'Smith v. Jones (2019)', context: 'Referenced by counsel', mentions: 1, firstSeqNo: 156 },
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
