// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The focus-image rules web reads (#1782): moved to `@breatic/shared` so the canvas and collab's video focus-crop append
 * agree on what counts as an entry (frames-split §5.5 delivery row); re-exported here for web callers.
 */

export { MAX_FOCUS_ENTRIES, MAX_FOCUS_NAME, validFocusImages } from '@breatic/shared';
