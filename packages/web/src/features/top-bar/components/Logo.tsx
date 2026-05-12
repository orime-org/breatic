/**
 * Logo — breatic v4 (sky-500 + cyber-lime + warm coral) per spec
 * `design/06-2026-05-09-logo.md`. The mark stays color-fixed across
 * light/dark (sibling decision: `2026-05-11-logo-light-dark-same.md`),
 * so the SVG uses hardcoded brand hexes rather than theme tokens.
 *
 * Sized 28x28 to match mock 05 @1086.
 */
import { memo } from 'react';

const Logo: React.FC<{ className?: string }> = memo(function Logo({ className }) {
  return (
    <svg
      width="28"
      height="28"
      viewBox="-50 -50 100 100"
      className={className ?? 'flex-shrink-0'}
      aria-label="Breatic"
    >
      <g transform="scale(1, -1)">
        <circle cx="25.98" cy="-15" r="10" fill="#BC4B36" />
        <path
          d="M 25.98 -15 A 30 30 0 0 0 -25.98 -15"
          stroke="#BC4B36"
          strokeWidth="8"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="-30" cy="0" r="7" fill="#0EA5E9" />
        <path
          d="M -30 0 A 30 30 0 0 0 -7.76 28.98"
          stroke="#0EA5E9"
          strokeWidth="6"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="7.76" cy="28.98" r="7" fill="#15D45A" />
        <path
          d="M 7.76 28.98 A 30 30 0 0 0 30 0"
          stroke="#15D45A"
          strokeWidth="6"
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </svg>
  );
});

export default Logo;
