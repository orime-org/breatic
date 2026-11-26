// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { SceneDirectorConfig, SceneImportLimits, SceneModelFile, SceneObject, ScenePose } from '@breatic/shared';
import type { SceneEnvironmentValues } from '@web/data/yjs/scene-document';
import type { LightsPlan } from '@web/spaces/three-d/viewport/director-lights';
import type { MeasuredSceneModelLease } from '@web/spaces/three-d/viewport/model-resources';
import type { LookPictureAccess } from '@web/spaces/three-d/look-picture-size';
import type { LookTextureCache } from '@web/spaces/three-d/viewport/look-texture-cache';
import type { SceneLookPictures, SceneLookReport } from '@web/spaces/three-d/viewport/scene-look-runtime';

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
  /** The whole pose a joint drag shows: the drag-start pose with the dragged bone's value. */
  pose?: ScenePose;
}
export interface SceneRemotePeer {
  clientId: number;
  userId: string;
  color: string;
  selectedIds: readonly string[];
  gesture: readonly SceneObject[] | null;
}
export type SceneModelState = 'loading' | 'ready' | 'failed';
/** What a loaded model's skeleton allows: nothing, presets and joints, or joints only. */
export type SceneSkeletonState = 'none' | 'humanoid' | 'other';
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
  /** Joint mode: the single selected character shows its joints instead of the object controls. */
  jointMode: boolean;
  /** The pose key of the joint carrying the rotation rings, or null. */
  selectedJoint: string | null;
  onJointSelect: (key: string | null) => void;
  /** Told once per loaded model what its skeleton allows. */
  onSkeletonState: (id: string, state: SceneSkeletonState) => void;
  /** The single selected object's highlighted part, or null (inner#1693 design 5.5). */
  selectedPart?: string | null;
  /** A plain click on the only selected object picked this part (design 5.6). */
  onSelectPart?: (part: string) => void;
  /** The page's way to this Project's part pictures; the lazy viewport keeps their textures. */
  lookPictures?: LookPictureAccess | null;
  /** Told each model's parts when it loads, or that it is loading or failed. */
  onLookReport?: (id: string, report: SceneLookReport | 'loading' | 'failed') => void;
  /** Told which part pictures of an object are shown, and why the others are not. */
  onLookPictures?: (id: string, pictures: SceneLookPictures | null) => void;
  onSelect: (id: string | null, additive: boolean) => void;
  onGestureStart: () => boolean;
  onGestureChange: (patches: readonly SceneTransformPatch[]) => void;
  /** Native interaction is released before this callback is invoked. */
  onGestureEnd: (commit: boolean) => void;
  /** The user's own view moved, or was first shown; `fov` is the camera's vertical field of view in degrees, which the editor publishes with it (#920). */
  onViewChange: (view: SceneView, fov: number) => void;
  /** The user's own input moved the camera: an Orbit drag or wheel, or an overview navigation. */
  onUserCameraMove?: () => void;
  onError: (error: Error) => void;
  onModelStateChange?: (id: string, state: SceneModelState, error?: Error) => void;
  resolveAsset: (assetId: string, signal: AbortSignal) => Promise<ResolvedSceneAsset>;
  /**
   * Told this view's model holder while it lives, and null before it releases
   * every hold, so a placement reuses the template the view will draw.
   */
  onResources?: (acquire: SceneModelAcquire | null) => void;
  /** Told this view's capture while it lives, and null before it is disposed. */
  onCapture?: (capture: SceneFrameCapture | null) => void;
  /** Stops orbiting and zooming while a capture is on screen. */
  viewLocked?: boolean;
  /** What the main view shows: null for the user's own view (inner#1694 design 3.4.3). */
  cameraView?: SceneCameraView | null;
  /** The viewfinder frame in viewport pixels while a camera view lasts. */
  viewFrame?: SceneViewportRect | null;
  /** The scene's ambient light. */
  environment?: SceneEnvironmentValues;
  /** The director console's parameters, once loaded. */
  director?: SceneDirectorConfig;
  /** A pilot draft of the camera being looked through. */
  onPilotPreview?: (id: string, position: SceneVector3, rotation: SceneQuaternion) => void;
  /** The pilot draft ends: written when `commit`, dropped otherwise. */
  onPilotEnd?: (commit: boolean) => void;
  /** A drag on a locked camera crossed the drag threshold. */
  onPilotLocked?: () => void;
  /** Hands the editor what it calls before undo and on Escape, or null when the view goes away. */
  onPilotControl?: (control: ScenePilotControl | null) => void;
  /** Which lights shine and cast, whenever that changes. */
  onLightPlan?: (plan: LightsPlan) => void;
  /** The monitor card canvases by camera id. */
  monitors?: ReadonlyMap<string, HTMLCanvasElement>;
}

/** What the runtime gets: the component's props plus the part pictures the component makes from `lookPictures`. */
export interface SceneViewportRuntimeProps extends SceneViewportProps {
  /** Part pictures for this Project. */
  lookTextures?: LookTextureCache | null;
}

/** What the editor asks of the pilot. */
export interface ScenePilotControl {
  /** Write a pending wheel step and drop a drag, before undo, redo or a viewfinder change. */
  flush: () => void;
  /** Drop a press in progress; true when there was one, so Escape stops there. */
  escape: () => boolean;
  /**
   * Where a new light goes from the camera on screen, live or as a still: the pivot it aims at and the viewer whose
   * direction it is offset toward; null outside a camera view.
   */
  lightAnchor: () => { centre: SceneVector3; viewer: SceneVector3 } | null;
}

/** The main view at the moment a camera still was taken. */
export interface SceneFrozenPose {
  position: SceneVector3;
  quaternion: SceneQuaternion;
  fov: number;
  aspect: number;
}

/** What the main view shows: through a camera, or a still taken through one (the camera's id, null once it is deleted). */
export type SceneCameraView =
  | { kind: 'live'; id: string; canPilot: boolean }
  | ({ kind: 'frozen'; id: string | null } & SceneFrozenPose);

/** A rectangle in viewport pixels. */
export interface SceneViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** RGBA bytes read back from a capture, rows bottom-up as WebGL reads them. */
export interface CapturedPixels {
  width: number;
  height: number;
  pixels: Uint8Array;
  /** The camera pose the still was taken with, when it was taken through a camera. */
  pose?: SceneFrozenPose;
}

/** Render one viewport rectangle at a given size, without the editing helpers. */
export type SceneFrameCapture = (frame: SceneViewportRect, size: { width: number; height: number }) => Promise<CapturedPixels>;

/** Hold one model through the viewport's own cache, measured for placing it. */
export type SceneModelAcquire = (source: SceneModelFile) => MeasuredSceneModelLease;
