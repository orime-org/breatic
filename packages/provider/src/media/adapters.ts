// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MediaAdapter } from "@provider/media/adapter.js";
import { falAdapter } from "@provider/media/fal/adapter.js";
import { sandbaseAdapter } from "@provider/media/sandbase/adapter.js";
import { wavespeedAdapter } from "@provider/media/wavespeed/adapter.js";

/** Every media upstream kind provider speaks to, by the kind the configuration names. */
const ADAPTERS: Readonly<Record<string, MediaAdapter>> = { wavespeed: wavespeedAdapter, fal: falAdapter, sandbase: sandbaseAdapter };

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
