// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SpaceType } from '@breatic/shared';

/**
 * Whether a Space of this type has content the Agent can be sent. A timeline's
 * cannot be read: only its name and type go.
 * @param type - The Space's type.
 * @returns True when its content is read.
 */
export function spaceContentReadable(type: SpaceType): boolean {
  return type === 'canvas' || type === 'document';
}
