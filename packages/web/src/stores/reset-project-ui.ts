// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useCanvasStore } from '@web/stores/canvas';
import { useChatStore } from '@web/stores/chat';
import { useInpaintStore } from '@web/stores/inpaint';
import { useMiniToolStore } from '@web/stores/mini-tool';
import { useUIStore } from '@web/stores/ui';

/**
 * Reset every project-scoped UI store to a fresh state — call when the user
 * LEAVES or SWITCHES a project so the next entry starts clean (#1771: e.g. the
 * Generate panel left open must not reopen on re-entry). These stores are module
 * singletons that survive React unmount, so nothing resets them without this
 * explicit teardown; a `key={projectId}` remount would NOT help (it only resets
 * component-local `useState`, not module singletons).
 *
 * Each store resets only its per-project SESSION state. Deliberately preserved:
 *   - layout preferences (`useUIStore` sidebar / chat-panel collapse),
 *   - canvas viewport preferences (`useCanvasStore` minimap / snap / zoom),
 *   - brush preferences (`useInpaintStore` size / color / opacity / tool).
 * Deliberately UNTOUCHED: `useSpaceOperationsStore` — it refcounts real in-flight
 * upload work, not UI panel state; clearing it could mask a lost local write-back.
 */
export function resetProjectUiStores(): void {
  useCanvasStore.getState().reset();
  useUIStore.getState().reset();
  useChatStore.getState().reset();
  useInpaintStore.getState().reset();
  // The brush-stroke undo history (zundo `temporal`) lives outside store state,
  // so clear it too — otherwise a fresh entry could undo back into old strokes.
  useInpaintStore.temporal.getState().clear();
  useMiniToolStore.getState().reset();
}
