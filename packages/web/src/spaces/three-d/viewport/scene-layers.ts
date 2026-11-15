// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

// Every Three.js layer the 3D viewport uses, in one place so two uses never share a number. Layer 0 is the scene and
// the transform gizmo, drawn by every camera and picked by the transform controls' own ray.

/** Layer of the camera and light icons: drawn in the main view and picked by a click. */
export const DISPLAY_PICK_LAYER = 1;
/** Layer of frustum and direction lines and number labels: drawn in the main view, never picked. */
export const DISPLAY_LINE_LAYER = 2;
/** Layer no camera draws and no ray picks: an object moved here is hidden from both. */
export const HIDDEN_LAYER = 31;
