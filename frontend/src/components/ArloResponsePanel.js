/**
 * ArloResponsePanel - Shows voice command responses and AI answers
 */

import React from 'react';
import { MessageCircle, X, Volume2, Loader2 } from 'lucide-react';
import Card from './ui/Card';
import './ArloResponsePanel.css';

export default function ArloResponsePanel({
  responses = [],
  isProcessing = false,
  onClear,
  onClose,
  inline = false,
}) {
  if (responses.length === 0 && !isProcessing) {
    return null;
  }

  return (
    <Card className={`arlo-response-panel ${inline ? 'arlo-response-panel-inline' : ''}`}>
      <div className="arlo-response-header">
        <div className="arlo-response-title">
          <Volume2 size={16} />
          <span className="text-sans text-sm font-medium">Arlo Voice</span>
        </div>
        <div className="arlo-response-actions">
          {responses.length > 0 && (
            <button className="arlo-response-clear" onClick={onClear}>
              Clear
            </button>
          )}
          <button className="arlo-response-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="arlo-response-content">
        {responses.map((response, index) => (
          <div key={index} className={`arlo-response-item ${response.type}`}>
            {response.type === 'user' ? (
              <div className="arlo-response-user">
                <MessageCircle size={14} />
                <span className="text-sans text-sm">"{response.text}"</span>
              </div>
            ) : (
              <div className="arlo-response-assistant">
                <div className="arlo-response-assistant-header">
                  <Volume2 size={14} />
                  <span className="text-sans text-xs text-muted">{response.action || 'Response'}</span>
                </div>
                <p className="text-serif text-sm">{response.text}</p>
              </div>
            )}
          </div>
        ))}

        {isProcessing && (
          <div className="arlo-response-item assistant">
            <div className="arlo-response-assistant">
              <div className="arlo-response-loading">
                <Loader2 size={14} className="spin" />
                <span className="text-sans text-sm text-muted">Thinking...</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
