// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Selection } from '@tiptap/pm/state';
import type * as Y from 'yjs';

import type { BodyEdge } from '@web/spaces/document/document-body-edge-pos';
import type { DocumentBodyRuntimeStatus } from '@web/spaces/document/document-body-runtime-types';

/** Affinity on either side of a native unit or container gap. */
export type BodyAssociation = -1 | 1;

/** A caller's target in one final index. */
export type BodyPointTarget =
  | { readonly kind: 'text'; readonly pos: number; readonly assoc: BodyAssociation }
  | { readonly kind: 'node'; readonly node: string; readonly side: 'before' | 'after' | 'inside' }
  | { readonly kind: 'gap'; readonly parent: string; readonly left: string | null; readonly right: string | null; readonly assoc: BodyAssociation }
  | { readonly kind: 'bodyEdge'; readonly edge: BodyEdge };

/** Document ownership is preserved when names cross persistence boundaries. */
export interface BodyNameIdentity {
  readonly version: 1;
  readonly document: string;
}

/** A text point retains a native identity independently of its character's life. */
export interface BodyTextPointName extends BodyNameIdentity {
  readonly kind: 'text';
  readonly source: string;
  readonly relative: Y.RelativePosition;
  readonly token: string | null;
  readonly assoc: BodyAssociation;
  /** Other-source neighbors preserve a gap when this entire independent source becomes empty. */
  readonly fallback?: { readonly left: BodyTextPointName | null; readonly right: BodyTextPointName | null };
}

/** An accepted local character has a batch name until the actual USER allocates its native ID. */
export interface BodyStagedTextPointName extends BodyNameIdentity {
  readonly kind: 'stagedText';
  readonly batch: string;
  readonly token: string;
  readonly offset: number;
  readonly assoc: BodyAssociation;
}

/** Stable point names contain no stale PM coordinate. */
export type BodyPointName =
  | BodyTextPointName
  | BodyStagedTextPointName
  | (BodyNameIdentity & { readonly kind: 'node'; readonly node: string; readonly side: 'before' | 'after' | 'inside' })
  | (BodyNameIdentity & { readonly kind: 'gap'; readonly parent: string; readonly left: string | null; readonly right: string | null; readonly assoc: BodyAssociation })
  | (BodyNameIdentity & { readonly kind: 'bodyEdge'; readonly edge: BodyEdge });

/** Runtime admission accompanies a last-good index without changing its identity. */
export interface BodyPositionOptions {
  readonly runtime?: DocumentBodyRuntimeStatus;
  readonly missing?: readonly string[];
}

/** Outcomes that must not be collapsed into target deletion. */
export type BodyPositionUnavailable =
  | { readonly status: 'pendingDependency'; readonly missing: readonly string[] }
  | { readonly status: 'bindingUnavailable'; readonly runtime: Exclude<DocumentBodyRuntimeStatus, 'active'> }
  | { readonly status: 'hidden' }
  | { readonly status: 'gone' }
  | { readonly status: 'otherDocument' };

/** A point resolved in the exact final epoch used by every consumer. */
export type BodyPointResolution = BodyPositionUnavailable | {
  readonly status: 'resolved';
  readonly pos: number;
  readonly epoch: number;
};

/** Selection names retain their original semantic selection kind. */
export type BodySelectionName = BodyNameIdentity & (
  | { readonly kind: 'text' | 'cell' | 'bodyEdge'; readonly anchor: BodyPointName; readonly head: BodyPointName }
  | { readonly kind: 'node'; readonly node: string; readonly part?: 'content' }
  | { readonly kind: 'all' }
);

/** Restored selections always belong to the supplied final PM document. */
export type BodySelectionResolution = BodyPositionUnavailable | {
  readonly status: 'resolved';
  readonly selection: Selection;
  readonly epoch: number;
};
