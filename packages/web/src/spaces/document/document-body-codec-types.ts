// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node as PMNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';

import type { BodyJsonObject, BodyRecord, BodyTreeUnit, BodyTreeView } from '@breatic/shared';

import type { BodyInlineUnit } from '@web/spaces/document/document-body-provenance';

/** The product-owned native encoding of one inline leaf. */
export interface BodyInlineValue {
  readonly bodyInline: {
    readonly type: string;
    readonly attrs: BodyJsonObject;
  };
}

/** A final projection's document ownership and publication epoch. */
export interface BodyProjectionOptions {
  readonly document: string;
  readonly epoch: number;
}

/** One native unit and its occurrence in the current legal PM document. */
export interface BodyIndexedUnit extends BodyInlineUnit {
  readonly source: string;
  readonly index: number;
  readonly owner: string;
  readonly native: BodyTreeUnit;
}

/** A registered node's outer and inner PM boundaries. */
export interface BodyNodePosition {
  readonly id: string;
  readonly type: string;
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
}

/** The immutable source payload hidden behind one visible stand-in. */
export interface BodyOpaquePayload {
  readonly record: BodyRecord;
  readonly descendants: readonly BodyRecord[];
  readonly units: readonly BodyTreeUnit[];
}

/** The common final frame used by planning, selections and target consumers. */
export interface BodyProjectionIndex extends BodyProjectionOptions {
  readonly sourceDoc: Y.Doc;
  readonly doc: PMNode;
  readonly view: BodyTreeView;
  readonly units: readonly BodyIndexedUnit[];
  readonly nodes: ReadonlyMap<string, BodyNodePosition>;
  readonly owners: ReadonlyMap<string, BodyNodePosition>;
  readonly opaque: ReadonlyMap<string, BodyOpaquePayload>;
}

/** A read-only legal PM document paired with exact native occurrence names. */
export interface BodyProjection {
  readonly doc: PMNode;
  readonly units: readonly BodyInlineUnit[];
  readonly view: BodyTreeView;
  readonly index: BodyProjectionIndex;
  readonly epoch: number;
  readonly synthetic: boolean;
}

/** Missing dependencies leave the caller's last published frame untouched. */
export type BodyProjectionRead =
  | { readonly status: 'uninitialized' }
  | { readonly status: 'pending'; readonly missing: readonly string[] }
  | { readonly status: 'ready'; readonly projection: BodyProjection };
