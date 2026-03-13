import React, { useState } from 'react';
import { Shield, Clock, AlertTriangle, Lock, FileWarning } from 'lucide-react';
import Card from '../../components/ui/Card';
import './PrivilegeMarkers.css';

/**
 * PrivilegeMarkers — Marks confidential/privileged sections in testimony.
 *
 * Features:
 * - Mark sections as Attorney-Client Privilege, Work Product, or Confidential
 * - Track objections on the record
 * - Visual indicators in transcript
 * - Export privilege log
 */

// Demo privilege markers for testing
const DEMO_MARKERS = [
  {
    id: 1,
    type: 'attorney-client',
    startTime: '10:23:45 AM',
    endTime: '10:25:12 AM',
    startSeqNo: 42,
    endSeqNo: 48,
    description: 'Discussion of communications with prior counsel',
    asserted_by: 'Defendant\'s Counsel',
    status: 'asserted', // asserted, challenged, resolved
  },
  {
    id: 2,
    type: 'work-product',
    startTime: '10:47:22 AM',
    endTime: '10:48:55 AM',
    startSeqNo: 89,
    endSeqNo: 94,
    description: 'Questions about litigation strategy documents',
    asserted_by: 'Plaintiff\'s Counsel',
    status: 'challenged',
    challenge_note: 'Opposing counsel disputes applicability',
  },
  {
    id: 3,
    type: 'confidential',
    startTime: '11:02:33 AM',
    endTime: '11:04:18 AM',
    startSeqNo: 112,
    endSeqNo: 118,
    description: 'Proprietary business information - trade secrets',
    asserted_by: 'Defendant\'s Counsel',
    status: 'asserted',
  },
];

// Demo objections for testing
const DEMO_OBJECTIONS = [
  {
    id: 1,
    timestamp: '10:15:33 AM',
    seqNo: 28,
    type: 'form',
    speaker: 'Defendant\'s Counsel',
    basis: 'Leading',
    ruling: null,
  },
  {
    id: 2,
    timestamp: '10:31:45 AM',
    seqNo: 58,
    type: 'form',
    speaker: 'Plaintiff\'s Counsel',
    basis: 'Compound question',
    ruling: null,
  },
  {
    id: 3,
    timestamp: '10:52:22 AM',
    seqNo: 98,
    type: 'relevance',
    speaker: 'Defendant\'s Counsel',
    basis: 'Outside scope of discovery',
    ruling: 'overruled',
  },
  {
    id: 4,
    timestamp: '11:08:17 AM',
    seqNo: 124,
    type: 'form',
    speaker: 'Plaintiff\'s Counsel',
    basis: 'Assumes facts not in evidence',
    ruling: null,
  },
];

const PRIVILEGE_TYPES = {
  'attorney-client': { label: 'Attorney-Client', icon: Shield, color: '#dc2626' },
  'work-product': { label: 'Work Product', icon: FileWarning, color: '#f59e0b' },
  'confidential': { label: 'Confidential', icon: Lock, color: '#6366f1' },
};

const STATUS_CONFIG = {
  asserted: { label: 'Asserted', color: '#059669' },
  challenged: { label: 'Challenged', color: '#f59e0b' },
  resolved: { label: 'Resolved', color: '#6b7280' },
};

export default function PrivilegeMarkers({ segments, onJumpToSegment }) {
  const [markers, setMarkers] = useState(DEMO_MARKERS);
  const [objections, setObjections] = useState(DEMO_OBJECTIONS);
  const [activeTab, setActiveTab] = useState('privilege'); // privilege, objections

  // Counts
  const privilegeCount = markers.length;
  const objectionCount = objections.length;
  const challengedCount = markers.filter(m => m.status === 'challenged').length;

  const addMarker = (type) => {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const newMarker = {
      id: Date.now(),
      type,
      startTime: timestamp,
      endTime: null,
      startSeqNo: segments?.length || 0,
      endSeqNo: null,
      description: '',
      asserted_by: 'Your Counsel',
      status: 'asserted',
    };

    setMarkers(prev => [...prev, newMarker]);
  };

  const addObjection = (type, basis) => {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const newObjection = {
      id: Date.now(),
      timestamp,
      seqNo: segments?.length || 0,
      type,
      speaker: 'Your Counsel',
      basis,
      ruling: null,
    };

    setObjections(prev => [...prev, newObjection]);
  };

  return (
    <Card className="privilege-markers">
      <div className="privilege-header">
        <div className="privilege-title">
          <Shield size={18} className="privilege-icon" />
          <h3 className="text-serif font-medium">Privilege & Objections</h3>
          {challengedCount > 0 && (
            <span className="privilege-alert-badge">
              <AlertTriangle size={12} />
              {challengedCount}
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="privilege-tabs">
        <button
          className={`privilege-tab ${activeTab === 'privilege' ? 'active' : ''}`}
          onClick={() => setActiveTab('privilege')}
        >
          Privilege Log
          <span className="privilege-tab-count">{privilegeCount}</span>
        </button>
        <button
          className={`privilege-tab ${activeTab === 'objections' ? 'active' : ''}`}
          onClick={() => setActiveTab('objections')}
        >
          Objections
          <span className="privilege-tab-count">{objectionCount}</span>
        </button>
      </div>

      {/* Privilege tab content */}
      {activeTab === 'privilege' && (
        <div className="privilege-content">
          {/* Quick add buttons */}
          <div className="privilege-quick-add">
            {Object.entries(PRIVILEGE_TYPES).map(([type, config]) => {
              const Icon = config.icon;
              return (
                <button
                  key={type}
                  className="privilege-quick-btn"
                  onClick={() => addMarker(type)}
                  style={{ '--type-color': config.color }}
                >
                  <Icon size={14} />
                  <span>Mark {config.label}</span>
                </button>
              );
            })}
          </div>

          {/* Markers list */}
          <div className="privilege-list">
            {markers.length === 0 ? (
              <p className="privilege-empty text-sm text-muted">
                No privilege assertions logged yet.
              </p>
            ) : (
              markers.map(marker => {
                const typeConfig = PRIVILEGE_TYPES[marker.type];
                const statusConfig = STATUS_CONFIG[marker.status];
                const Icon = typeConfig.icon;

                return (
                  <div
                    key={marker.id}
                    className={`privilege-item ${marker.status}`}
                    style={{ '--type-color': typeConfig.color }}
                  >
                    <div className="privilege-item-header">
                      <span
                        className="privilege-type-badge"
                        style={{ background: `${typeConfig.color}15`, color: typeConfig.color }}
                      >
                        <Icon size={12} />
                        {typeConfig.label}
                      </span>
                      <span
                        className="privilege-status-badge"
                        style={{ color: statusConfig.color }}
                      >
                        {statusConfig.label}
                      </span>
                    </div>

                    <div className="privilege-item-times">
                      <button
                        className="privilege-time-btn"
                        onClick={() => onJumpToSegment?.(marker.startSeqNo)}
                      >
                        <Clock size={12} />
                        {marker.startTime}
                      </button>
                      {marker.endTime && (
                        <>
                          <span className="privilege-time-sep">→</span>
                          <button
                            className="privilege-time-btn"
                            onClick={() => onJumpToSegment?.(marker.endSeqNo)}
                          >
                            {marker.endTime}
                          </button>
                        </>
                      )}
                    </div>

                    {marker.description && (
                      <p className="privilege-item-desc text-sm">{marker.description}</p>
                    )}

                    <div className="privilege-item-meta text-xs text-muted">
                      Asserted by: {marker.asserted_by}
                    </div>

                    {marker.challenge_note && (
                      <div className="privilege-challenge-note">
                        <AlertTriangle size={12} />
                        <span className="text-xs">{marker.challenge_note}</span>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Objections tab content */}
      {activeTab === 'objections' && (
        <div className="privilege-content">
          {/* Quick objection buttons */}
          <div className="objection-quick-add">
            <button
              className="objection-quick-btn"
              onClick={() => addObjection('form', 'Leading')}
            >
              Form: Leading
            </button>
            <button
              className="objection-quick-btn"
              onClick={() => addObjection('form', 'Compound')}
            >
              Form: Compound
            </button>
            <button
              className="objection-quick-btn"
              onClick={() => addObjection('relevance', 'Relevance')}
            >
              Relevance
            </button>
            <button
              className="objection-quick-btn"
              onClick={() => addObjection('form', 'Assumes facts')}
            >
              Assumes Facts
            </button>
          </div>

          {/* Objections list */}
          <div className="objection-list">
            {objections.length === 0 ? (
              <p className="privilege-empty text-sm text-muted">
                No objections logged yet.
              </p>
            ) : (
              objections.map(obj => (
                <button
                  key={obj.id}
                  className="objection-item"
                  onClick={() => onJumpToSegment?.(obj.seqNo)}
                >
                  <span className="objection-time">{obj.timestamp}</span>
                  <span className="objection-type">{obj.type}</span>
                  <span className="objection-basis">{obj.basis}</span>
                  <span className="objection-speaker text-xs text-muted">{obj.speaker}</span>
                  {obj.ruling && (
                    <span className={`objection-ruling ${obj.ruling}`}>
                      {obj.ruling}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
