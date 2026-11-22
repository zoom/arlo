import React, { useState, useMemo } from 'react';
import { FileStack, ChevronDown, ChevronUp, ExternalLink, Plus, Check, X } from 'lucide-react';
import Card from '../../components/ui/Card';
import './ExhibitTracker.css';

/**
 * ExhibitTracker — Tracks document references during depositions.
 *
 * Features:
 * - Auto-detection of exhibit mentions ("Exhibit A", "Document 3", etc.)
 * - Manual exhibit logging with timestamps
 * - Shows when each exhibit was introduced and discussed
 * - Links to transcript moments where exhibits are referenced
 */

// Demo exhibits for testing — Employment discrimination case (Thompson v. Nexus Technologies)
const DEMO_EXHIBITS = [
  {
    id: '1',
    label: 'Exhibit 1',
    description: 'Performance Improvement Plan — dated March 15, 2025',
    status: 'marked', // marked, referenced, pending
    introducedAt: '10:12:18 AM',
    introducedSeqNo: 28,
    references: [
      { timestamp: '10:12:18 AM', seqNo: 28, context: 'Initially marked and shown to witness' },
      { timestamp: '10:25:45 AM', seqNo: 48, context: 'Witness confirms she drafted this PIP' },
      { timestamp: '10:38:22 AM', seqNo: 68, context: 'Discussion of "deliverables" on page 2' },
      { timestamp: '11:05:17 AM', seqNo: 115, context: 'Witness asked about 30-day timeline' },
    ],
  },
  {
    id: '2',
    label: 'Exhibit 2',
    description: 'Annual Performance Review — January 2025 ("Meets Expectations")',
    status: 'marked',
    introducedAt: '10:28:33 AM',
    introducedSeqNo: 52,
    references: [
      { timestamp: '10:28:33 AM', seqNo: 52, context: 'Marked for identification' },
      { timestamp: '10:32:08 AM', seqNo: 58, context: 'Witness confirms "Meets Expectations" rating' },
      { timestamp: '10:48:41 AM', seqNo: 88, context: 'Contrast with PIP issued 8 weeks later' },
    ],
  },
  {
    id: '3',
    label: 'Exhibit 3',
    description: 'EEOC Charge of Discrimination — filed Feb 28, 2025',
    status: 'marked',
    introducedAt: '10:42:55 AM',
    introducedSeqNo: 78,
    references: [
      { timestamp: '10:42:55 AM', seqNo: 78, context: 'Marked and shown to witness' },
      { timestamp: '10:45:12 AM', seqNo: 82, context: 'Witness claims no knowledge before termination' },
      { timestamp: '11:22:33 AM', seqNo: 142, context: 'Witness revises statement — was informed by Legal' },
    ],
  },
  {
    id: '4',
    label: 'Exhibit 4',
    description: 'Email from CEO M. Chen — "Refreshing the team" — March 2, 2025',
    status: 'marked',
    introducedAt: '10:55:08 AM',
    introducedSeqNo: 98,
    references: [
      { timestamp: '10:55:08 AM', seqNo: 98, context: 'Marked and shown to witness' },
      { timestamp: '10:58:22 AM', seqNo: 104, context: 'Witness identifies as recipient' },
      { timestamp: '11:02:45 AM', seqNo: 112, context: 'Discussion of "fresh perspectives" language' },
    ],
  },
  {
    id: '5',
    label: 'Exhibit 5',
    description: 'Termination Letter — dated April 22, 2025',
    status: 'marked',
    introducedAt: '11:08:17 AM',
    introducedSeqNo: 118,
    references: [
      { timestamp: '11:08:17 AM', seqNo: 118, context: 'Marked for identification' },
      { timestamp: '11:12:33 AM', seqNo: 128, context: 'Witness confirms she signed letter' },
    ],
  },
  {
    id: '6',
    label: 'Exhibit 6',
    description: 'Org chart showing recent hires in Engineering (avg age 28)',
    status: 'referenced',
    introducedAt: null,
    introducedSeqNo: null,
    references: [
      { timestamp: '11:18:45 AM', seqNo: 135, context: 'Referenced but not yet marked' },
    ],
  },
];

const STATUS_CONFIG = {
  marked: { label: 'Marked', color: '#059669', bgColor: 'rgba(5, 150, 105, 0.1)' },
  referenced: { label: 'Referenced', color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.1)' },
  pending: { label: 'Pending', color: '#6b7280', bgColor: 'rgba(107, 114, 128, 0.1)' },
};

export default function ExhibitTracker({ segments, onJumpToSegment, showDemoData = true }) {
  const [exhibits, setExhibits] = useState(showDemoData ? DEMO_EXHIBITS : []);
  const [expandedId, setExpandedId] = useState('A');
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newExhibit, setNewExhibit] = useState({ id: '', description: '' });
  const [filter, setFilter] = useState('all'); // all, marked, referenced, pending

  // Filter exhibits
  const filteredExhibits = useMemo(() => {
    if (filter === 'all') return exhibits;
    return exhibits.filter(e => e.status === filter);
  }, [exhibits, filter]);

  // Counts
  const counts = useMemo(() => ({
    all: exhibits.length,
    marked: exhibits.filter(e => e.status === 'marked').length,
    referenced: exhibits.filter(e => e.status === 'referenced').length,
    pending: exhibits.filter(e => e.status === 'pending').length,
  }), [exhibits]);

  const handleAddExhibit = () => {
    if (!newExhibit.id.trim()) return;

    const exhibit = {
      id: newExhibit.id.trim(),
      label: `Exhibit ${newExhibit.id.trim()}`,
      description: newExhibit.description.trim() || 'No description',
      status: 'pending',
      introducedAt: null,
      introducedSeqNo: null,
      references: [],
    };

    setExhibits(prev => [...prev, exhibit]);
    setNewExhibit({ id: '', description: '' });
    setIsAddingNew(false);
  };

  const markExhibit = (exhibitId) => {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    setExhibits(prev => prev.map(e => {
      if (e.id === exhibitId) {
        return {
          ...e,
          status: 'marked',
          introducedAt: e.introducedAt || timestamp,
          introducedSeqNo: e.introducedSeqNo || (segments?.length || 0),
        };
      }
      return e;
    }));
  };

  return (
    <Card className="exhibit-tracker">
      <div className="exhibit-header">
        <div className="exhibit-title">
          <FileStack size={18} className="exhibit-icon" />
          <h3 className="text-serif font-medium">Exhibits</h3>
          <span className="exhibit-count">{exhibits.length}</span>
        </div>

        <button
          className="exhibit-add-btn"
          onClick={() => setIsAddingNew(!isAddingNew)}
          title="Add exhibit"
        >
          {isAddingNew ? <X size={14} /> : <Plus size={14} />}
        </button>
      </div>

      {/* Add new exhibit form */}
      {isAddingNew && (
        <div className="exhibit-add-form">
          <div className="exhibit-add-row">
            <input
              type="text"
              placeholder="ID (e.g., E, 5)"
              value={newExhibit.id}
              onChange={(e) => setNewExhibit(prev => ({ ...prev, id: e.target.value }))}
              className="exhibit-add-input exhibit-add-id"
              maxLength={10}
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={newExhibit.description}
              onChange={(e) => setNewExhibit(prev => ({ ...prev, description: e.target.value }))}
              className="exhibit-add-input exhibit-add-desc"
            />
          </div>
          <button
            className="exhibit-add-submit"
            onClick={handleAddExhibit}
            disabled={!newExhibit.id.trim()}
          >
            <Plus size={14} />
            Add Exhibit
          </button>
        </div>
      )}

      {/* Filter tabs */}
      <div className="exhibit-filters">
        {['all', 'marked', 'referenced', 'pending'].map(f => (
          <button
            key={f}
            className={`exhibit-filter ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {counts[f] > 0 && <span className="filter-count">{counts[f]}</span>}
          </button>
        ))}
      </div>

      {/* Exhibits list */}
      <div className="exhibit-list">
        {filteredExhibits.length === 0 ? (
          <p className="exhibit-empty text-sm text-muted">
            No exhibits {filter !== 'all' ? `with status "${filter}"` : 'logged yet'}.
          </p>
        ) : (
          filteredExhibits.map(exhibit => {
            const isExpanded = expandedId === exhibit.id;
            const statusConfig = STATUS_CONFIG[exhibit.status];

            return (
              <div
                key={exhibit.id}
                className={`exhibit-item ${exhibit.status}`}
              >
                <button
                  className="exhibit-summary"
                  onClick={() => setExpandedId(isExpanded ? null : exhibit.id)}
                >
                  <span className="exhibit-label">{exhibit.label}</span>
                  <span
                    className="exhibit-status"
                    style={{ background: statusConfig.bgColor, color: statusConfig.color }}
                  >
                    {statusConfig.label}
                  </span>
                  <span className="exhibit-desc">{exhibit.description}</span>
                  <span className="exhibit-refs-count text-xs text-muted">
                    {exhibit.references.length} ref{exhibit.references.length !== 1 ? 's' : ''}
                  </span>
                  {isExpanded ? (
                    <ChevronUp size={14} className="text-muted" />
                  ) : (
                    <ChevronDown size={14} className="text-muted" />
                  )}
                </button>

                {isExpanded && (
                  <div className="exhibit-details">
                    {exhibit.status !== 'marked' && (
                      <button
                        className="exhibit-mark-btn"
                        onClick={() => markExhibit(exhibit.id)}
                      >
                        <Check size={14} />
                        Mark as Exhibit
                      </button>
                    )}

                    {exhibit.introducedAt && (
                      <div className="exhibit-introduced">
                        <span className="text-xs text-muted">Introduced:</span>
                        <button
                          className="exhibit-timestamp"
                          onClick={() => onJumpToSegment?.(exhibit.introducedSeqNo)}
                        >
                          {exhibit.introducedAt}
                          <ExternalLink size={10} />
                        </button>
                      </div>
                    )}

                    <div className="exhibit-references">
                      <span className="exhibit-references-label text-xs font-medium">
                        References ({exhibit.references.length})
                      </span>
                      {exhibit.references.map((ref, i) => (
                        <button
                          key={i}
                          className="exhibit-reference"
                          onClick={() => onJumpToSegment?.(ref.seqNo)}
                        >
                          <span className="exhibit-ref-time">{ref.timestamp}</span>
                          <span className="exhibit-ref-context text-sm">{ref.context}</span>
                          <ExternalLink size={12} className="exhibit-ref-link" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
