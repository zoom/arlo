import React, { useState, useMemo, useCallback } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Flag, Check, Clock, MessageSquare, Download, Copy, Gavel, FileText, Bell } from 'lucide-react';
import Card from '../../components/ui/Card';
import { useFeatureLayout } from '../../hooks/useFeatureLayout';
import './ContradictionDetector.css';

/**
 * ContradictionDetector — Real-time flagging of conflicting statements during depositions and trials.
 *
 * Demonstrates RTMS real-time capabilities for legal proceedings:
 * - Live detection of contradictory statements as testimony unfolds
 * - Side-by-side comparison with timestamps for transcript reference
 * - Impeachment preparation with formatted outlines
 * - Export functionality for case preparation and trial notebooks
 * - Severity classification for prioritization
 *
 * Primary Use Cases:
 * - Depositions: Flag inconsistencies for follow-up questioning
 * - Trial Testimony: Real-time impeachment preparation
 * - Witness Preparation: Identify potential vulnerabilities
 * - Case Review: Post-proceeding analysis for appeals or motions
 *
 * Note: This is a reference implementation using demo data.
 * Real implementations would integrate with AI analysis of transcript segments.
 */

// Demo contradictions for testing — Employment discrimination case
const DEMO_CONTRADICTIONS = [
  {
    id: 1,
    severity: 'high',
    category: 'Timeline',
    description: 'Conflicting statements about when performance issues were first raised',
    statements: [
      {
        speaker: 'Witness (HR Director)',
        text: 'We first discussed performance concerns with Mr. Thompson in January, during his annual review.',
        timestamp: '10:18:22 AM',
        seqNo: 35,
      },
      {
        speaker: 'Witness (HR Director)',
        text: 'The performance improvement plan was actually the first formal conversation we had about any issues, that was in March.',
        timestamp: '10:52:17 AM',
        seqNo: 94,
      },
    ],
    status: 'flagged', // flagged, noted, dismissed
  },
  {
    id: 2,
    severity: 'high',
    category: 'Key Fact',
    description: 'Inconsistent account of who made the termination decision',
    statements: [
      {
        speaker: 'Witness (HR Director)',
        text: 'The decision to terminate was made by the executive team. I was just implementing their decision.',
        timestamp: '10:31:45 AM',
        seqNo: 58,
      },
      {
        speaker: 'Witness (HR Director)',
        text: 'I recommended termination based on my assessment of the situation.',
        timestamp: '11:08:33 AM',
        seqNo: 118,
      },
    ],
    status: 'flagged',
  },
  {
    id: 3,
    severity: 'high',
    category: 'Key Fact',
    description: 'Conflicting statements about awareness of protected status',
    statements: [
      {
        speaker: 'Witness (HR Director)',
        text: 'I had no idea Mr. Thompson had filed an EEOC complaint until after he was terminated.',
        timestamp: '10:42:08 AM',
        seqNo: 78,
      },
      {
        speaker: 'Witness (HR Director)',
        text: 'Legal had informed HR about the complaint, but that didn\'t factor into our decision at all.',
        timestamp: '11:22:41 AM',
        seqNo: 142,
      },
    ],
    status: 'flagged',
  },
  {
    id: 4,
    severity: 'medium',
    category: 'Documentation',
    description: 'Different accounts of when PIP documentation was created',
    statements: [
      {
        speaker: 'Witness (HR Director)',
        text: 'The PIP was drafted in late February after several verbal warnings.',
        timestamp: '10:25:12 AM',
        seqNo: 48,
      },
      {
        speaker: 'Witness (HR Director)',
        text: 'We created the formal documentation in March, right before presenting it to him.',
        timestamp: '11:15:20 AM',
        seqNo: 132,
      },
    ],
    status: 'noted',
  },
];

const SEVERITY_CONFIG = {
  high: { color: '#dc2626', label: 'High', bgColor: 'rgba(220, 38, 38, 0.1)' },
  medium: { color: '#f59e0b', label: 'Medium', bgColor: 'rgba(245, 158, 11, 0.1)' },
  low: { color: '#6b7280', label: 'Low', bgColor: 'rgba(107, 114, 128, 0.1)' },
};

export default function ContradictionDetector({ segments, onJumpToSegment, showDemoData = true }) {
  const { isCollapsed, toggleCollapsed } = useFeatureLayout();
  const collapsed = isCollapsed('contradiction-detector');
  const [contradictions, setContradictions] = useState(showDemoData ? DEMO_CONTRADICTIONS : []);
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState('all'); // all, flagged, noted, dismissed
  const [copiedId, setCopiedId] = useState(null);
  const [liveAlerts, setLiveAlerts] = useState(true);

  // Filter contradictions
  const filteredContradictions = useMemo(() => {
    if (filter === 'all') return contradictions;
    return contradictions.filter(c => c.status === filter);
  }, [contradictions, filter]);

  // Count by status
  const counts = useMemo(() => ({
    all: contradictions.length,
    flagged: contradictions.filter(c => c.status === 'flagged').length,
    noted: contradictions.filter(c => c.status === 'noted').length,
    dismissed: contradictions.filter(c => c.status === 'dismissed').length,
  }), [contradictions]);

  const updateStatus = (id, newStatus) => {
    setContradictions(prev =>
      prev.map(c => c.id === id ? { ...c, status: newStatus } : c)
    );
  };

  // Generate impeachment outline for a contradiction
  const generateImpeachmentOutline = useCallback((contradiction) => {
    const lines = [
      `IMPEACHMENT OUTLINE`,
      `${'='.repeat(50)}`,
      ``,
      `Category: ${contradiction.category}`,
      `Severity: ${contradiction.severity.toUpperCase()}`,
      ``,
      `Issue: ${contradiction.description}`,
      ``,
      `PRIOR STATEMENT:`,
      `  Speaker: ${contradiction.statements[0].speaker}`,
      `  Time: ${contradiction.statements[0].timestamp}`,
      `  Quote: "${contradiction.statements[0].text}"`,
      ``,
      `CONTRADICTORY STATEMENT:`,
      `  Speaker: ${contradiction.statements[1].speaker}`,
      `  Time: ${contradiction.statements[1].timestamp}`,
      `  Quote: "${contradiction.statements[1].text}"`,
      ``,
      `SUGGESTED FOLLOW-UP QUESTIONS:`,
      `  1. "Earlier today at ${contradiction.statements[0].timestamp}, you stated [read prior statement]. Is that correct?"`,
      `  2. "And just now at ${contradiction.statements[1].timestamp}, you testified [read current statement]. Is that also your testimony?"`,
      `  3. "Can you explain the discrepancy between these two statements?"`,
      ``,
      `${'='.repeat(50)}`,
    ];
    return lines.join('\n');
  }, []);

  // Copy impeachment outline to clipboard
  const copyImpeachmentOutline = useCallback((contradiction) => {
    const outline = generateImpeachmentOutline(contradiction);
    navigator.clipboard?.writeText(outline);
    setCopiedId(contradiction.id);
    setTimeout(() => setCopiedId(null), 2000);
  }, [generateImpeachmentOutline]);

  // Export all flagged contradictions
  const exportFlaggedContradictions = useCallback(() => {
    const flagged = contradictions.filter(c => c.status === 'flagged');
    if (flagged.length === 0) {
      alert('No flagged contradictions to export.');
      return;
    }

    const content = [
      `CONTRADICTION ANALYSIS REPORT`,
      `Generated: ${new Date().toLocaleString()}`,
      `Total Flagged: ${flagged.length}`,
      ``,
      `${'='.repeat(60)}`,
      ``,
      ...flagged.map((c, i) => generateImpeachmentOutline(c)),
    ].join('\n');

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contradiction-report-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [contradictions, generateImpeachmentOutline]);

  return (
    <Card className={`contradiction-detector ${collapsed ? 'feature-collapsed' : ''}`}>
      <button
        className="contradiction-header feature-collapse-header"
        onClick={() => toggleCollapsed('contradiction-detector')}
        aria-expanded={!collapsed}
      >
        <div className="contradiction-title">
          <AlertTriangle size={18} className="contradiction-icon" />
          <h3 className="text-serif font-medium">Contradictions</h3>
          <span className="feature-live-badge">Live</span>
          {counts.flagged > 0 && (
            <span className="contradiction-badge flagged">{counts.flagged}</span>
          )}
        </div>

        <div className="feature-header-right">
          {collapsed ? (
            <ChevronDown size={16} className="feature-chevron" />
          ) : (
            <ChevronUp size={16} className="feature-chevron" />
          )}
        </div>
      </button>

      {!collapsed && (
      <>
      {/* Actions */}
      <div className="contradiction-header-actions">
        <button
          className={`contradiction-alert-toggle ${liveAlerts ? 'active' : ''}`}
          onClick={() => setLiveAlerts(!liveAlerts)}
          title={liveAlerts ? 'Live alerts on' : 'Live alerts off'}
        >
          <Bell size={14} />
        </button>
        <button
          className="contradiction-export"
          onClick={exportFlaggedContradictions}
          title="Export flagged contradictions"
        >
          <Download size={14} />
          <span className="text-xs">Export</span>
        </button>
      </div>

      {/* Live Alert Banner */}
      {liveAlerts && counts.flagged > 0 && (
        <div className="contradiction-live-banner">
          <span className="contradiction-live-dot" />
          <span className="text-xs">Real-time detection active — {counts.flagged} contradiction{counts.flagged !== 1 ? 's' : ''} flagged</span>
        </div>
      )}

      {/* Filter tabs */}
      <div className="contradiction-filters">
        {['all', 'flagged', 'noted', 'dismissed'].map(f => (
          <button
            key={f}
            className={`contradiction-filter ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {counts[f] > 0 && <span className="filter-count">{counts[f]}</span>}
          </button>
        ))}
      </div>

      <div className="contradiction-list">
        {filteredContradictions.length === 0 ? (
          <p className="contradiction-empty text-sm text-muted">
            No contradictions {filter !== 'all' ? `marked as ${filter}` : 'detected yet'}.
          </p>
        ) : (
          filteredContradictions.map(contradiction => {
            const isExpanded = expandedId === contradiction.id;
            const severityConfig = SEVERITY_CONFIG[contradiction.severity];

            return (
              <Card
                key={contradiction.id}
                className={`contradiction-item ${contradiction.status}`}
                style={{ '--severity-color': severityConfig.color }}
              >
                <button
                  className="contradiction-summary"
                  onClick={() => setExpandedId(isExpanded ? null : contradiction.id)}
                >
                  <span
                    className="contradiction-severity"
                    style={{ background: severityConfig.bgColor, color: severityConfig.color }}
                  >
                    {severityConfig.label}
                  </span>
                  <span className="contradiction-category">{contradiction.category}</span>
                  <span className="contradiction-desc">{contradiction.description}</span>
                  {isExpanded ? (
                    <ChevronUp size={16} className="text-muted" />
                  ) : (
                    <ChevronDown size={16} className="text-muted" />
                  )}
                </button>

                {isExpanded && (
                  <div className="contradiction-details">
                    <div className="contradiction-statements">
                      {contradiction.statements.map((stmt, i) => (
                        <div key={i} className="contradiction-statement">
                          <div className="statement-header">
                            <span className="statement-speaker text-sm font-medium">
                              {stmt.speaker}
                            </span>
                            <button
                              className="statement-timestamp"
                              onClick={() => onJumpToSegment?.(stmt.seqNo)}
                              title="Jump to this statement"
                            >
                              <Clock size={12} />
                              {stmt.timestamp}
                            </button>
                          </div>
                          <p className="statement-text">
                            <MessageSquare size={14} className="statement-quote-icon" />
                            "{stmt.text}"
                          </p>
                        </div>
                      ))}
                    </div>

                    <div className="contradiction-actions">
                      <button
                        className={`contradiction-action ${contradiction.status === 'flagged' ? 'active' : ''}`}
                        onClick={() => updateStatus(contradiction.id, 'flagged')}
                      >
                        <Flag size={14} />
                        Flag
                      </button>
                      <button
                        className="contradiction-action impeachment"
                        onClick={() => copyImpeachmentOutline(contradiction)}
                        title="Copy impeachment outline to clipboard"
                      >
                        {copiedId === contradiction.id ? (
                          <>
                            <Check size={14} />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Gavel size={14} />
                            Impeachment
                          </>
                        )}
                      </button>
                      <button
                        className={`contradiction-action ${contradiction.status === 'noted' ? 'active' : ''}`}
                        onClick={() => updateStatus(contradiction.id, 'noted')}
                      >
                        <Check size={14} />
                        Noted
                      </button>
                      <button
                        className={`contradiction-action dismiss ${contradiction.status === 'dismissed' ? 'active' : ''}`}
                        onClick={() => updateStatus(contradiction.id, 'dismissed')}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>
      </>
      )}
    </Card>
  );
}
