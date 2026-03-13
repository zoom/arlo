import React from 'react';
import {
  FileText,
  Stethoscope,
  Scale,
  TrendingUp,
  Headphones,
} from 'lucide-react';
import { useVertical } from '../contexts/VerticalContext';
import OwlIcon from './OwlIcon';
import './ArloLogo.css';

// Icon mapping for each vertical
const VERTICAL_ICONS = {
  notes: FileText,
  healthcare: Stethoscope,
  legal: Scale,
  sales: TrendingUp,
  support: Headphones,
};

/**
 * Vertical-aware Arlo logo component.
 * Shows the owl icon with a vertical-specific badge icon.
 *
 * @param {Object} props
 * @param {number} props.size - Size of the owl icon (default: 20)
 * @param {boolean} props.showName - Whether to show "Arlo" text (default: true)
 * @param {boolean} props.showVerticalBadge - Whether to show the vertical badge icon (default: true)
 * @param {string} props.className - Additional CSS class
 */
export default function ArloLogo({
  size = 20,
  showName = true,
  showVerticalBadge = true,
  className = '',
}) {
  const { vertical } = useVertical();

  const VerticalIcon = vertical ? VERTICAL_ICONS[vertical.id] : null;

  return (
    <div className={`arlo-logo ${className}`}>
      <div className="arlo-logo-icon-container">
        <OwlIcon size={size} />
        {showVerticalBadge && VerticalIcon && (
          <span
            className="arlo-logo-vertical-badge"
            style={{ '--badge-color': vertical.accentColor }}
          >
            <VerticalIcon size={Math.max(10, size * 0.5)} />
          </span>
        )}
      </div>
      {showName && (
        <span className="arlo-logo-name text-serif font-medium">Arlo</span>
      )}
    </div>
  );
}
