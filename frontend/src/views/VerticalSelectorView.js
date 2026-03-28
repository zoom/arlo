import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  Stethoscope,
  Scale,
  TrendingUp,
  Headphones,
  ChevronRight
} from 'lucide-react';
import { useVertical, VERTICALS } from '../contexts/VerticalContext';
import OwlIcon from '../components/OwlIcon';
import './VerticalSelectorView.css';

// Icon mapping for each vertical
const VERTICAL_ICONS = {
  notes: FileText,
  healthcare: Stethoscope,
  legal: Scale,
  sales: TrendingUp,
  support: Headphones,
};

// Colors for each vertical (used for icon backgrounds)
const VERTICAL_COLORS = {
  notes: { bg: 'rgba(37, 99, 235, 0.1)', color: '#2563eb' },
  healthcare: { bg: 'rgba(13, 148, 136, 0.1)', color: '#0d9488' },
  legal: { bg: 'rgba(30, 64, 175, 0.1)', color: '#1e40af' },
  sales: { bg: 'rgba(124, 58, 237, 0.1)', color: '#7c3aed' },
  support: { bg: 'rgba(37, 99, 235, 0.1)', color: '#2563eb' },
};

export default function VerticalSelectorView() {
  const navigate = useNavigate();
  const { selectVertical } = useVertical();

  const handleSelectVertical = (verticalId) => {
    selectVertical(verticalId);
    navigate('/home', { replace: true });
  };

  return (
    <div className="vertical-selector-view">
      {/* Header with branding */}
      <div className="vertical-selector-header">
        <div className="vertical-selector-brand">
          <OwlIcon size={48} />
        </div>
        <h1 className="text-serif text-2xl">Welcome to Arlo</h1>
        <p className="text-muted">
          Choose how you'd like to use Arlo. Each experience is tailored to your workflow.
        </p>
      </div>

      {/* Vertical cards grid */}
      <div className="vertical-selector-grid">
        {Object.values(VERTICALS).map((vertical) => {
          const Icon = VERTICAL_ICONS[vertical.id];
          const colors = VERTICAL_COLORS[vertical.id];

          return (
            <button
              key={vertical.id}
              className="vertical-card"
              onClick={() => handleSelectVertical(vertical.id)}
              style={{
                '--vertical-accent': colors.color,
                '--vertical-accent-bg': colors.bg,
              }}
            >
              <div className="vertical-card-icon">
                <Icon size={20} />
              </div>
              <div className="vertical-card-content">
                <h3 className="text-serif">{vertical.name}</h3>
                <p className="text-muted text-sm">{vertical.tagline}</p>
              </div>
              <ChevronRight size={20} className="vertical-card-arrow" />
            </button>
          );
        })}
      </div>

      {/* Footer note */}
      <p className="vertical-selector-footer text-muted text-sm">
        You can change this any time in Settings.
      </p>
    </div>
  );
}
