import React from 'react';
import './IconShowcaseView.css';

const faceColor = '#0B0B0C';
const detailColor = '#FFFFFF';

// Current icon (for reference)
function CurrentOwl({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" fill={faceColor} />
      <circle cx="9" cy="11" r="2.5" fill={detailColor} />
      <circle cx="15" cy="11" r="2.5" fill={detailColor} />
      <circle cx="9" cy="11" r="1" fill={faceColor} />
      <circle cx="15" cy="11" r="1" fill={faceColor} />
      <path d="M 10 15 Q 12 16 14 15" stroke={detailColor} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M 4 8 L 6 10 L 5 11 Z" fill={faceColor} />
      <path d="M 20 8 L 18 10 L 19 11 Z" fill={faceColor} />
    </svg>
  );
}

// 1. Tufts Up + Beak - tufts moved to top of head, smile becomes beak
function TuftsUpOwl({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" fill={faceColor} />
      <circle cx="9" cy="11" r="2.5" fill={detailColor} />
      <circle cx="15" cy="11" r="2.5" fill={detailColor} />
      <circle cx="9" cy="11" r="1" fill={faceColor} />
      <circle cx="15" cy="11" r="1" fill={faceColor} />
      {/* Beak instead of smile */}
      <path d="M 12 14 L 10.5 15.5 L 12 15 L 13.5 15.5 Z" fill={detailColor} />
      {/* Ear tufts pointing UP from top of head */}
      <path d="M 7 5 L 8 8 L 6 7 Z" fill={faceColor} />
      <path d="M 17 5 L 16 8 L 18 7 Z" fill={faceColor} />
    </svg>
  );
}

// 2. Wide Stare - eyes nearly touching, slim upright tufts
function WideStareOwl({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" fill={faceColor} />
      {/* Larger, closer eyes */}
      <circle cx="9.5" cy="11" r="3" fill={detailColor} />
      <circle cx="14.5" cy="11" r="3" fill={detailColor} />
      <circle cx="9.5" cy="11" r="1.2" fill={faceColor} />
      <circle cx="14.5" cy="11" r="1.2" fill={faceColor} />
      {/* Small beak */}
      <path d="M 12 15 L 11 16 L 12 15.5 L 13 16 Z" fill={detailColor} />
      {/* Slim upright tufts */}
      <path d="M 7.5 4 L 8 7.5 L 7 7 Z" fill={faceColor} />
      <path d="M 16.5 4 L 16 7.5 L 17 7 Z" fill={faceColor} />
    </svg>
  );
}

// 3. Tall Tufts - great horned owl drama, taller narrower tufts
function TallTuftsOwl({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" fill={faceColor} />
      <circle cx="9" cy="11" r="2.5" fill={detailColor} />
      <circle cx="15" cy="11" r="2.5" fill={detailColor} />
      <circle cx="9" cy="11" r="1" fill={faceColor} />
      <circle cx="15" cy="11" r="1" fill={faceColor} />
      <path d="M 12 14.5 L 11 15.5 L 12 15 L 13 15.5 Z" fill={detailColor} />
      {/* Tall dramatic tufts */}
      <path d="M 7 2 L 8 7 L 6 6 Z" fill={faceColor} />
      <path d="M 17 2 L 16 7 L 18 6 Z" fill={faceColor} />
    </svg>
  );
}

// 4. No Ears - Barn owl with thick orbital rings + prominent beak
function BarnOwl({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" fill={faceColor} />
      {/* Thick orbital rings (barn owl facial disc) */}
      <circle cx="9" cy="10.5" r="3.5" fill={detailColor} />
      <circle cx="15" cy="10.5" r="3.5" fill={detailColor} />
      <circle cx="9" cy="10.5" r="2" fill={faceColor} />
      <circle cx="15" cy="10.5" r="2" fill={faceColor} />
      <circle cx="9" cy="10.5" r="0.8" fill={detailColor} />
      <circle cx="15" cy="10.5" r="0.8" fill={detailColor} />
      {/* Larger beak */}
      <path d="M 12 14 L 10 16.5 L 12 15.5 L 14 16.5 Z" fill={detailColor} />
    </svg>
  );
}

// 5. Integrated Silhouette - ears as part of head outline
function SilhouetteOwl({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Single path with ears integrated into head shape */}
      <path
        d="M 7 4 L 8 8 Q 4 10 4 12 Q 4 17 12 20 Q 20 17 20 12 Q 20 10 16 8 L 17 4 L 15 7 Q 12 5 9 7 Z"
        fill={faceColor}
      />
      <circle cx="9" cy="11" r="2.5" fill={detailColor} />
      <circle cx="15" cy="11" r="2.5" fill={detailColor} />
      <circle cx="9" cy="11" r="1" fill={faceColor} />
      <circle cx="15" cy="11" r="1" fill={faceColor} />
      <path d="M 12 15 L 11 16 L 12 15.5 L 13 16 Z" fill={detailColor} />
    </svg>
  );
}

// 6. Angled Brows - no tufts, angled brow ridges for intensity
function AngledBrowsOwl({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" fill={faceColor} />
      {/* Angled brow ridges */}
      <path d="M 5.5 8 L 10.5 9.5 L 10.5 8.5 Z" fill={detailColor} />
      <path d="M 18.5 8 L 13.5 9.5 L 13.5 8.5 Z" fill={detailColor} />
      <circle cx="9" cy="11.5" r="2.5" fill={detailColor} />
      <circle cx="15" cy="11.5" r="2.5" fill={detailColor} />
      <circle cx="9" cy="11.5" r="1" fill={faceColor} />
      <circle cx="15" cy="11.5" r="1" fill={faceColor} />
      <path d="M 12 15 L 11 16 L 12 15.5 L 13 16 Z" fill={detailColor} />
    </svg>
  );
}

const variants = [
  { name: 'Current', description: 'Current icon (side tufts = devil horns)', Component: CurrentOwl },
  { name: '1. Tufts Up + Beak', description: 'Tufts moved to top of head, smile replaced with beak', Component: TuftsUpOwl },
  { name: '2. Wide Stare', description: 'Eyes nearly touching, slim upright tufts', Component: WideStareOwl },
  { name: '3. Tall Tufts', description: 'Great horned owl drama - taller narrower tufts', Component: TallTuftsOwl },
  { name: '4. Barn Owl', description: 'No tufts, thick orbital rings + prominent beak', Component: BarnOwl },
  { name: '5. Silhouette', description: 'Ears integrated into head outline as single path', Component: SilhouetteOwl },
  { name: '6. Angled Brows', description: 'No tufts, angled brow ridges above eyes', Component: AngledBrowsOwl },
];

export default function IconShowcaseView() {
  return (
    <div className="icon-showcase">
      <div className="icon-showcase-header">
        <h1 className="text-serif text-2xl">Owl Icon Showcase</h1>
        <p className="text-sans text-muted">
          Compare variations at 16px, 32px, and 64px on light and dark backgrounds.
        </p>
      </div>

      <div className="icon-showcase-grid">
        {variants.map(({ name, description, Component }) => (
          <div key={name} className="icon-variant-card">
            <h3 className="text-sans font-medium">{name}</h3>
            <p className="text-sans text-sm text-muted">{description}</p>

            <div className="icon-sizes-row">
              {/* Light background */}
              <div className="icon-bg icon-bg-light">
                <Component size={16} />
                <Component size={32} />
                <Component size={64} />
              </div>

              {/* Dark background */}
              <div className="icon-bg icon-bg-dark">
                <Component size={16} />
                <Component size={32} />
                <Component size={64} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
