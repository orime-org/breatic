// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { BodyJsonObject, BodyJsonValue, BodyRegistration } from '@breatic/shared';
import type { Node as PMNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';

import type { BodyInlineUnit } from '@web/spaces/document/document-body-provenance';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';

/** The codec frame compared at both registration and final publication. */
export interface BodyPlanProjection {
  readonly doc: PMNode;
  readonly units: readonly BodyInlineUnit[];
}

/** A permanent zero-width boundary anchored in the current native source. */
export interface BodyPlannedCut {
  readonly source: string;
  readonly cut: string;
  readonly at: Y.RelativePosition;
}

/** An exact observed native-unit deletion or independent mark change. */
export type BodyNativeWrite =
  | { readonly kind: 'delete'; readonly ids: readonly string[] }
  | { readonly kind: 'format'; readonly ids: readonly string[]; readonly attributes: BodyJsonObject };

/** A final fresh run written only into its newly registered empty source. */
export interface BodyFreshRun {
  readonly source: string;
  readonly units: readonly {
    readonly token: string;
    readonly value: BodyJsonValue;
    readonly attributes: BodyJsonObject;
  }[];
}

/** Explicit mutations emitted by the complete accepted-journal compiler. */
export interface BodyBatchPlan {
  readonly id: string;
  readonly registration: BodyRegistration;
  readonly cuts: readonly BodyPlannedCut[];
  readonly native: readonly BodyNativeWrite[];
  readonly fresh: readonly BodyFreshRun[];
  readonly enable: readonly string[];
  readonly expected: BodyPlanProjection;
}

/** The exact handle and source used throughout synchronous preflight and commit. */
export interface BodyBatchEnvironment {
  readonly doc: Y.Doc;
  readonly runtime: DocumentBodyRuntime;
  readonly userOrigin: object;
  readonly canWrite: () => boolean;
  readonly project: (doc: Y.Doc) => BodyPlanProjection;
}

/** A successful commit's final codec frame and fresh-to-native aliases. */
export interface BodyBatchResult {
  readonly projection: BodyPlanProjection;
  readonly aliases: ReadonlyMap<string, string>;
}
