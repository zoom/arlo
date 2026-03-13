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

// Demo exhibits for testing
const DEMO_EXHIBITS = [
  {
    id: 'A',
    label: 'Exhibit A',
    description: 'Service Agreement dated January 15, 2023',
    status: 'marked', // marked, referenced, pending
    introducedAt: '10:15:22 AM',
    introducedSeqNo: 34,
    references: [
      { timestamp: '10:15:22 AM', seqNo: 34, context: 'Initially marked and shown to witness' },
      { timestamp: '10:23:45 AM', seqNo: 56, context: 'Witness identifies signature on page 3' },
      { timestamp: '10:47:12 AM', seqNo: 89, context: 'Discussion of Section 4.2 terms' },
      { timestamp: '11:02:33 AM', seqNo: 112, context: 'Witness confirms understanding of obligations' },
    ],
  },
  {
    id: 'B',
    label: 'Exhibit B',
    description: 'Amendment No. 1 to Service Agreement',
    status: 'marked',
    introducedAt: '10:31:08 AM',
    introducedSeqNo: 58,
    references: [
      { timestamp: '10:31:08 AM', seqNo: 58, context: 'Marked for identification' },
      { timestamp: '10:35:41 AM', seqNo: 67, context: 'Witness reviews document' },
    ],
  },
  {
    id: 'C',
    label: 'Exhibit C',
    description: 'Email chain dated February 14, 2024',
    status: 'marked',
    introducedAt: '10:52:17 AM',
    introducedSeqNo: 98,
    references: [
      { timestamp: '10:52:17 AM', seqNo: 98, context: 'Marked and shown to witness' },
      { timestamp: '10:55:33 AM', seqNo: 104, context: 'Witness confirms authorship' },
    ],
  },
  {
    id: 'D',
    label: 'Exhibit D',
    description: 'Bank statement - March 2024',
    status: 'referenced',
    introducedAt: null,
    introducedSeqNo: null,
    references: [
      { timestamp: '11:12:45 AM', seqNo: 128, context: 'Referenced but not yet marked' },
    ],
  },
];

const STATUS_CONFIG = {
  marked: { label: 'Marked', color: '#059669', bgColor: 'rgba(5, 150, 105, 0.1)' },
  referenced: { label: 'Referenced', color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.1)' },
  pending: { label: 'Pending', color: '#6b7280', bgColor: 'rgba(107, 114, 128, 0.1)' },
};

export default function ExhibitTracker({ segments, onJumpToSegment }) {
  const [exhibits, setExhibits] = useState(DEMO_EXHIBITS);
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
