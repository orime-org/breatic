// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Call back whenever the canvas viewport pans or zooms.
 *
 * ReactFlow applies pan and zoom as an inline `transform` inside the `style`
 * attribute of `.react-flow__viewport`, so watching that one attribute catches
 * every viewport move — a div has no standalone `transform` attribute, that
 * exists only on SVG.
 *
 * This stays outside React on purpose. The React-side alternative,
 * `useStore((s) => s.transform)`, re-renders whichever component calls it, and
 * `transform` is a fresh array on every pan frame — moving that call into a
 * custom hook does not change who re-renders.
 *
 * Coalescing is the caller's to decide: this fires once per mutation record.
 * @param onChange - Run on every viewport move.
 * @returns The teardown; a no-op when there is no canvas on the page.
 */
export function observeViewportTransform(onChange: () => void): () => void {
  const viewport = document.querySelector('.react-flow__viewport');
  if (!viewport) return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(viewport, { attributes: true, attributeFilter: ['style'] });
  return (): void => observer.disconnect();
}
