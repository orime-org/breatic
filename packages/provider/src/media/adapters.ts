// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MediaAdapter } from "@provider/media/adapter.js";
import { wavespeedAdapter } from "@provider/media/wavespeed/adapter.js";

/** Every media upstream kind provider speaks to, by the kind the configuration names. */
const ADAPTERS: Readonly<Record<string, MediaAdapter>> = { wavespeed: wavespeedAdapter };

// Configuration accepts fal and sandbase before their adapters are in ADAPTERS; adapterOf still
// refuses them, so a run bound to one fails instead of speaking another upstream's protocol.
// The entries go when the fal and SandBase adapters land (inner#1775).
const PENDING_KINDS: ReadonlySet<string> = new Set(["fal", "sandbase"]);

/**
 * Whether configuration may bind media models to upstreams of a kind.
 * @param kind - The upstream kind, as the configuration names it.
 * @returns True when one can.
 */
export function hasMediaAdapter(kind: string): boolean {
  return Object.hasOwn(ADAPTERS, kind) || PENDING_KINDS.has(kind);
}

/**
 * The adapter for upstreams of a kind, if provider has one.
 * @param kind - The upstream kind.
 * @returns The adapter, or undefined.
 */
export function mediaAdapter(kind: string): MediaAdapter | undefined {
  return Object.hasOwn(ADAPTERS, kind) ? ADAPTERS[kind] : undefined;
}

/**
 * The adapter that speaks to upstreams of a kind.
 * @param kind - The upstream kind.
 * @returns The adapter.
 * @throws {Error} When provider has no adapter for the kind.
 */
export function adapterOf(kind: string): MediaAdapter {
  const adapter = mediaAdapter(kind);
  if (adapter === undefined) throw new Error(`No media adapter speaks to upstreams of kind "${kind}"`);
  return adapter;
}
