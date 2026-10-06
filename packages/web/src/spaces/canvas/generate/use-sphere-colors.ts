// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { SphereColors } from '@web/spaces/canvas/generate/camera-angle-sphere-props';

/** The theme tokens each part of the scene is drawn in. */
const TOKENS: Readonly<Record<keyof SphereColors, string>> = {
  line: '--color-border',
  accent: '--color-foreground',
  card: '--color-card',
};

/**
 * The scene's colours, read off the theme tokens on the root element.
 * @returns One CSS colour string per part.
 */
function readColors(): SphereColors {
  const style = getComputedStyle(document.documentElement);
  return {
    line: style.getPropertyValue(TOKENS.line).trim(),
    accent: style.getPropertyValue(TOKENS.accent).trim(),
    card: style.getPropertyValue(TOKENS.card).trim(),
  };
}

/**
 * The camera-angle sphere's colours, kept in step with the theme.
 *
 * A WebGL scene does not read CSS, so the tokens are read here and read again
 * whenever the root's `data-theme` changes — which is what both the theme
 * switch and the system preference write (`theme-mode.ts`).
 * @returns The colours, a new object only when a token changed.
 */
export function useSphereColors(): SphereColors {
  const [colors, setColors] = React.useState<SphereColors>(readColors);
  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = readColors();
      setColors((was) =>
        was.line === next.line && was.accent === next.accent && was.card === next.card ? was : next,
      );
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return colors;
}
