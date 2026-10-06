// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the camera-angle sphere is handed (inner#830).
 *
 * The sphere is its own lazy chunk, so it imports three.js, React, `@breatic/shared`
 * and the geometry only it uses; colours and the picture's address arrive here
 * as props. A chunk that imported a module of the project page would make that
 * page's chunk named by a second file, which `verify-chunks` refuses.
 */

import type { CameraAngle } from '@breatic/shared';

/** The colours the scene is drawn in, as CSS colour strings off the theme tokens. */
export interface SphereColors {
  /** The ring and its ticks. */
  line: string;
  /** The camera, its ray and the arc of the current azimuth. */
  accent: string;
  /** The card's face when there is no picture on it. */
  card: string;
}

/** The sphere's props. */
export interface CameraAngleSphereProps {
  /** The pose to draw; any azimuth, elevation and distance, on the grid or off it. */
  pose: CameraAngle;
  /** The picture on the card, already in CORS form; absent for a plain card. */
  subjectUrl: string | undefined;
  colors: SphereColors;
  /** Whether a move to a new pose is animated (off under prefers-reduced-motion). */
  animate: boolean;
  /** Called when the pointer is pressed on the sphere. */
  onDragStart: () => void;
  /** Called with the pose under the pointer as it moves. */
  onDrag: (pose: CameraAngle) => void;
  /** Called when the pointer is released or capture is lost. */
  onDragEnd: () => void;
  /** Called once when the browser cannot draw WebGL. */
  onUnavailable: () => void;
}
