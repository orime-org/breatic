// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { SceneImportLimits, SceneObject } from '@breatic/shared';

/** Plain tuples keep the Project shell outside the lazy Three dependency graph. */
export type SceneVector3 = [number, number, number];
export type SceneQuaternion = [number, number, number, number];
export type SceneTransformMode = 'translate' | 'rotate' | 'scale';
export interface SceneView {
  position: SceneVector3;
  target: SceneVector3;
}
export interface SceneTransformPatch {
  id: string;
  position?: SceneVector3;
  rotation?: SceneQuaternion;
  scale?: SceneVector3;
}
export interface SceneRemotePeer {
  clientId: number;
  userId: string;
  color: string;
  selectedIds: readonly string[];
  gesture: readonly SceneObject[] | null;
}
export type SceneModelState = 'loading' | 'ready' | 'failed';
export interface ResolvedSceneAsset {
  url: string;
  mimeType: string;
  sizeBytes: number;
}
export interface SceneViewportProps {
  /** Optional DOM allocation; its native renderer belongs to this visible view. */
  overviewHost?: HTMLDivElement | null;
  objects: readonly SceneObject[];
  selectedIds: readonly string[];
  mode: SceneTransformMode;
  readOnly: boolean;
  view: SceneView;
  focusRevision: number;
  /** Changes when the session cancels a draft outside the native viewport. */
  cancelRevision: number;
  remotePeers: readonly SceneRemotePeer[];
  scaleSensitivity: number;
  importLimits: SceneImportLimits;
  /** A new value retries failed model loads without changing their identity. */
  modelRetryRevision?: number;
  onSelect: (id: string | null, additive: boolean) => void;
  onGestureStart: () => boolean;
  onGestureChange: (patches: readonly SceneTransformPatch[]) => void;
  /** Native interaction is released before this callback is invoked. */
  onGestureEnd: (commit: boolean) => void;
  onViewChange: (view: SceneView) => void;
  onError: (error: Error) => void;
  onModelStateChange?: (id: string, state: SceneModelState, error?: Error) => void;
  resolveAsset: (assetId: string, signal: AbortSignal) => Promise<ResolvedSceneAsset>;
}
