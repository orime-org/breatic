// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Where a canvas subtree is, and who is looking at it.
 *
 * Sibling of `canvas-actions`, and the split between them is deliberate:
 * actions are what a component can DO but cannot perform itself (it knows the
 * new name, not the node id); this is what a component has to KNOW about its
 * surroundings before it can bind anything (which document, whether this user
 * may write, whose caret to publish).
 *
 * It exists because a collaborative editor cannot be handed a finished value
 * the way a rename can. It has to bind to the live shared fragment, which means
 * reaching the document, which means knowing the project and space — and a node
 * body deliberately knows neither (`canvas-actions` opens with that same
 * observation). Passing five props down through the ReactFlow wrapper to every
 * node body, for the one modality that needs them, would be worse.
 */

import * as React from 'react';

import type { HocuspocusProvider } from '@hocuspocus/provider';

import type { CaretUserIdentity } from '@web/features/collab-editor/use-caret-user';

/** The canvas subtree's document coordinates, permissions, and caret identity. */
export interface CanvasContextValue {
  /** Project the canvas space belongs to. */
  projectId: string;
  /** The canvas space being rendered. */
  spaceId: string;
  /**
   * Whether this user may write to the document.
   *
   * Every write path has to consult this. It used to be enforced in one place
   * — the container's `setNodeContent` wrapper — which worked while every edit
   * was a finished string handed upwards. A collaborative editor writes
   * directly to the shared fragment instead, so the gate has to travel to
   * wherever that binding happens.
   */
  readOnly: boolean;
  /**
   * Provider whose awareness carries collaborator carets, or `null` before the
   * shared socket's first connect. The caret extension throws on a null
   * provider, so editors mount carets only once this is present.
   */
  caretProvider: Pick<HocuspocusProvider, 'awareness'> | null;
  /** This user's caret identity, published to other clients. */
  caretUser: CaretUserIdentity | null;
}

/**
 * Defaults for a subtree rendered outside a provider — isolated component
 * tests, and any future reuse of a node body off-canvas.
 *
 * Read-only by default, and no document to bind to. Both are the safe answer:
 * a component that failed to find its provider must not write, and an editor
 * with no fragment does not mount rather than mounting unbound.
 */
const NO_CANVAS: CanvasContextValue = {
  projectId: '',
  spaceId: '',
  readOnly: true,
  caretProvider: null,
  caretUser: null,
};

export const CanvasContext = React.createContext<CanvasContextValue>(NO_CANVAS);

/**
 * Read the surrounding canvas subtree's context.
 * @returns The project and space ids, the read-only flag, and caret identity.
 */
export function useCanvasContext(): CanvasContextValue {
  return React.useContext(CanvasContext);
}
