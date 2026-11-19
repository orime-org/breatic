// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The animation runtime every web-animation source package is built with (inner#1711 design §3.6). Kept apart from
 * the zod schemas because the web-animation container bundles it and loads nothing but Node and our own code.
 */
export const WEB_ANIMATION_RUNTIME = { id: "hyperframes", version: "0.8.186" } as const;
