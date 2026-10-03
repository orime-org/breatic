// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useDebounce } from '@web/lib/use-debounce';
import {
  validateItemSlug,
  type SlugCheck,
} from '@web/pages/studio/container/dialogs/slug-util';

/** Pause after the last keystroke before judging, the same as the studio check. */
const SETTLE_MS = 300;

/**
 * Live check for a project or collection slug.
 *
 * These slugs are not unique (an id tells two items apart), so the check is
 * the local shape rule alone. It waits for typing to pause, as the studio
 * availability check does, so a slug is not called too short on its first
 * letter.
 * @param raw - The slug as typed.
 * @returns The hint-line state for the trimmed value, which is also what the
 *   create dialog submits.
 */
export function useItemSlugCheck(raw: string): SlugCheck {
  const trimmed = raw.trim();
  const settled = useDebounce(trimmed, SETTLE_MS);
  if (trimmed.length === 0) return { state: 'empty' };
  if (settled !== trimmed) return { state: 'checking' };
  const reason = validateItemSlug(trimmed);
  return reason === null ? { state: 'valid' } : { state: 'invalid', reason };
}
