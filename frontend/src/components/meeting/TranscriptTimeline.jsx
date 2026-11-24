import React, { useMemo } from 'react';
import { ScrollArea } from '@base-ui/react';
import { LogIn, LogOut, Mic, MicOff, Pause, Play, Sparkles } from 'lucide-react';
import { endedActions, recordLine } from '../../lib/arloDid';

function formatTimestamp(ms) {
  const date = new Date(ms);
  if (isNaN(date.getTime()) || ms === 0) return '--:--';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const EVENT_ICONS = {
  joined: LogIn,
  left: LogOut,
  transcription_started: Mic,
  transcription_stopped: MicOff,
  transcription_paused: Pause,
  transcription_resumed: Play,
};

function eventLabel(eventType, name) {
  switch (eventType) {
    case 'joined': return `${name} joined the meeting`;
    case 'left': return `${name} left the meeting`;
    case 'transcription_started': return 'Transcription started';
    case 'transcription_stopped': return 'Transcription stopped';
    case 'transcription_paused': return 'Transcription paused';
    case 'transcription_resumed': return 'Transcription resumed';
    default: return `${name} — ${eventType}`;
  }
}

/**
 * Speech and join/leave events merged into one chronological list.
 * `initial_roster` events are the stream reporting who was already there, not
 * real joins, so they are left out. Exported for the view's "has content" check.
 * `actions`: what Arlo was asked and did (ArloContext `actions`); the ones
 * that ended are placed by their time.
 */
export function buildTimeline(segments, participantEvents, actions = null) {
  const items = [
    ...segments.map((segment, i) => ({ type: 'transcript', ...segment, _ts: segment.tStartMs, _key: `seg-${i}` })),
    ...participantEvents
      .filter((event) => event.eventType !== 'initial_roster')
      .map((event, i) => ({ type: 'participant-event', ...event, _ts: event.timestamp, _key: `evt-${i}` })),
    ...endedActions(actions).map((action) => ({ type: 'arlo-action', action, _ts: action.at, _key: `act-${action.id}` })),
  ];
  return items.sort((a, b) => a._ts - b._ts);
}

/**
 * The scrolling live transcript. `renderText` lets a vertical decorate the
 * spoken text (healthcare highlights medical terms).
 */
export default function TranscriptTimeline({ segments, participantEvents, viewportRef, onScroll, renderText, actions = null }) {
  const items = useMemo(() => buildTimeline(segments, participantEvents, actions), [segments, participantEvents, actions]);

  return (
    <ScrollArea.Root className="transcript-scroll-root">
      <ScrollArea.Viewport
        ref={viewportRef}
        className="transcript-viewport"
        onScroll={onScroll}
        role="log"
        aria-label="Live transcript"
        aria-live="polite"
      >
        {items.map((item) => {
          if (item.type === 'arlo-action') {
            // Styled like Arlo's other events; the label and the name are text
            return (
              <div key={item._key} className="transcript-participant-event timeline-event-animate" data-status={item.action.status}>
                <Sparkles size={14} className="transcript-event-icon" aria-hidden="true" />
                <span className="transcript-event-text text-sans text-sm">{recordLine(item.action)}</span>
                <span className="transcript-event-time text-mono text-xs">{formatTimestamp(item.action.at)}</span>
              </div>
            );
          }

          if (item.type === 'participant-event') {
            const Icon = EVENT_ICONS[item.eventType] || Mic;
            return (
              <div key={item._key} className="transcript-participant-event timeline-event-animate">
                <Icon size={14} className="transcript-event-icon" aria-hidden="true" />
                <span className="transcript-event-text text-sans text-sm">
                  {eventLabel(item.eventType, item.participantName)}
                </span>
                <span className="transcript-event-time text-mono text-xs">
                  {formatTimestamp(item.timestamp)}
                </span>
              </div>
            );
          }

          return (
            <div key={item._key} className="transcript-entry" data-seq={item.seqNo}>
              <div className="transcript-entry-header">
                <span className="transcript-timestamp text-mono text-xs text-muted">
                  {formatTimestamp(item.tStartMs)}
                </span>
                <span className="transcript-speaker text-sans text-sm font-medium">
                  {item.speakerLabel}
                </span>
              </div>
              <p className="transcript-text text-serif text-sm">
                {renderText ? renderText(item.text) : item.text}
              </p>
            </div>
          );
        })}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="vertical" className="scroll-area-scrollbar">
        <ScrollArea.Thumb className="scroll-area-scrollbar-thumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
