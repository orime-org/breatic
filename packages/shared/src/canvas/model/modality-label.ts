// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { Modality } from '@shared/canvas/model/node-view.js';

/**
 * Fixed English display label per modality. Used both as the empty-node
 * default `data.name` (the factory) and as the name-header fallback when a
 * node's name is blank. A DATA value, not an i18n UI string (see the 2a
 * design): it stays a fixed English literal so it never freezes a locale.
 */
export const MODALITY_LABEL: Record<Modality, string> = {
  text: 'Text',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  '3d': '3D',
  web: 'Web',
};
