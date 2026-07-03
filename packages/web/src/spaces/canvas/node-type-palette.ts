// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * MiniMap node-type identity colors (#1549; consumed by the MiniMap feature,
 * #1548). Every node type maps to a palette IDENTITY token so the map reads
 * by type at a glance — all colors are fixed to the 7-color palette
 * (user-ratified 2026-07-03: no off-palette colors on the MiniMap; the
 * annotation sticky note takes the orange slot rather than its own note
 * yellow, and audio takes pink).
 *
 * Groups are not listed: a tinted group shows its own background tint and an
 * untinted one stays neutral. Red (reads as an alarm) and teal are reserved
 * for future node types.
 */
export const NODE_TYPE_PALETTE: Readonly<Record<string, string>> = {
  text: '--color-palette-blue',
  image: '--color-palette-green',
  audio: '--color-palette-pink',
  video: '--color-palette-violet',
  annotation: '--color-palette-orange',
};
