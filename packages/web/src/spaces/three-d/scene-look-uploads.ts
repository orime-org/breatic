// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QueryClient } from '@tanstack/react-query';

import { getLocale, t, type SceneLook } from '@breatic/shared';

import { projectImagesQueryKey } from '@web/data/api/scene';
import { UploadFailedError, uploadMedia } from '@web/data/upload/media-upload';
import type { UploadContext } from '@web/data/upload/ingest-upload';
import { peekSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import { toast } from '@web/lib/toast';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { uploadFailureMessageKey } from '@web/spaces/canvas/upload-failure';
import { checkLookWrite, type LookTextureReason } from '@web/spaces/three-d/look-texture-budget';
import { pageLookTextureCache, readPictureSize } from '@web/spaces/three-d/viewport/look-texture-cache';

/** A picture's header size and type. */
export interface LookImageSize {
  width: number;
  height: number;
  type: string;
}

/** A message for the uploader. */
export interface LookUploadNotice {
  key: string;
  params?: Record<string, string>;
  severity: 'error' | 'warning';
}

export interface SceneLookUploadDeps {
  /**
   * Send the file through the common upload pipeline; `beforeSend` runs once the server opened an upload for content it
   * does not hold yet, and aborting `signal` there stops the upload before any byte is sent.
   */
  upload: (file: File, context: UploadContext, onProgress: (fraction: number) => void, signal: AbortSignal,
    beforeSend: () => Promise<void>) => Promise<{ assetId: string }>;
  notify: (notice: LookUploadNotice) => void;
  /** Hold a Space busy (closing its tab is held back). */
  register: (spaceId: string, operationId: string) => void;
  unregister: (spaceId: string, operationId: string) => void;
  /** Refresh the Project's picture list, which now holds the upload. */
  invalidateImages: (projectId: string) => void;
  /** The local file's header size and type, or null when it cannot be read. */
  readLocalSize: (file: File) => Promise<LookImageSize | null>;
  /** A used picture's header size in a Project, or null when it cannot be read. */
  size: (projectId: string, assetId: string) => Promise<LookImageSize | null>;
  /** The open editing session of a Space document, if any; never creates one. */
  session: (name: string) => SceneSession | undefined;
}

/** A refused look write: which limit, and the bytes the object's textures would take. */
export interface LookLimitIssue {
  reason: LookTextureReason;
  total: number;
}

/** The scene's texture limits, the edge capped by this device. */
export interface LookTextureLimits {
  maxTextureEdge: number;
  maxTextureBytes: number;
}

/** What an upload records when it starts (inner#1693 design 6.3). */
export interface SceneLookUploadStart {
  projectId: string;
  spaceId: string;
  /** The Space document's name. */
  name: string;
  objectId: string;
  part: string;
  file: File;
  /** Upload bytes of the object's own textures. */
  ownBytes: number;
  /** Extra bytes per part that keeps its own picture with its own tiling. */
  clampBytes: Readonly<Record<string, number>>;
  /** The scene's texture limits, the edge already capped by this device's largest texture. */
  limits: LookTextureLimits;
}

/** One running upload, shown on its part row. */
export interface SceneLookUploadEntry {
  spaceId: string;
  objectId: string;
  part: string;
  percent: number;
  /** The upload that owns the entry. */
  operationId: string;
}

export interface SceneLookUploads {
  start: (input: SceneLookUploadStart) => Promise<void>;
  /** The running upload of one part, if any. */
  get: (spaceId: string, objectId: string, part: string) => SceneLookUploadEntry | undefined;
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
}

const LOOK_IMAGE_TYPES = new Set(['png', 'jpeg', 'webp']);
/** The formats a part picture may be, as the unsupported-format notice names them. */
const LOOK_IMAGE_FORMATS = 'PNG, JPEG, WebP';

/**
 * The notice for a file that is not a picture a part may use.
 * @param filename - The file's or the asset's name.
 * @returns The notice.
 */
export function unsupportedPictureNotice(filename: string): LookUploadNotice {
  return { key: 'canvas.upload.unsupportedType', params: { filename, kind: 'image', formats: LOOK_IMAGE_FORMATS }, severity: 'warning' };
}

/**
 * The notice for a picture upload that did not complete, said as Timeline and Document say a failed media upload.
 * @param error - What the upload threw.
 * @param filename - The file's name.
 * @returns The notice.
 */
export function pictureUploadFailedNotice(error: unknown, filename: string): LookUploadNotice {
  const reason = error instanceof UploadFailedError ? error.reason : 'upload';
  if (reason === 'unsupportedType') return unsupportedPictureNotice(filename);
  return { key: uploadFailureMessageKey(reason), params: { filename, kind: 'image', formats: LOOK_IMAGE_FORMATS }, severity: 'error' };
}

/**
 * The notice for a picture whose bytes could not be read: it changed or moved, or the network failed.
 * @param filename - The file's or the asset's name.
 * @returns The notice.
 */
export function pictureReadFailedNotice(filename: string): LookUploadNotice {
  return { key: 'spaces.threeD.look.pictureReadFailed', params: { filename }, severity: 'error' };
}

/**
 * Whether a header's type is a picture a part may use.
 * @param type - The type `image-dimensions` read.
 * @returns True for PNG, JPEG and WebP.
 */
export function isLookImageType(type: string): boolean {
  return LOOK_IMAGE_TYPES.has(type);
}

/**
 * Format bytes as MiB with one decimal, rounded the way that keeps the comparison true.
 * @param bytes - The byte count.
 * @param round - Math.ceil for a measured value, Math.floor for a limit.
 * @returns The formatted number.
 */
function mib(bytes: number, round: (value: number) => number): string {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(round(bytes / 1024 / 1024 * 10) / 10);
}

/**
 * Why a picture cannot go on a part: the object's pictures over the texture budget together (inner#1693 design 7).
 * @param issue - The refusal and the object's texture total.
 * @param limits - The limits it was judged against.
 * @returns The notice.
 */
export function lookLimitNotice(issue: LookLimitIssue, limits: LookTextureLimits): LookUploadNotice {
  return { key: 'spaces.threeD.look.objectTexturesTooLarge',
    params: { actual: mib(issue.total, Math.ceil), allowed: mib(limits.maxTextureBytes, Math.floor) }, severity: 'warning' };
}

/**
 * The look of one object in a session's snapshot.
 * @param session - The session.
 * @param objectId - The object.
 * @returns Its look, or undefined when it is gone.
 */
function lookOf(session: SceneSession, objectId: string): SceneLook | undefined {
  const object = session.getSnapshot().objects.find((item) => item.id === objectId);
  return object ? object.look ?? {} : undefined;
}

/**
 * The page's part-picture uploads: each outlives the panel and the editor, and writes on completion only when the
 * Space, the object, the user's access, the part's picture and the budget still allow (inner#1693 design 6.3).
 * @param deps - The transport, the notices and the Space hold.
 * @returns The holder.
 */
export function createSceneLookUploads(deps: SceneLookUploadDeps): SceneLookUploads {
  const entries = new Map<string, SceneLookUploadEntry>();
  const listeners = new Set<() => void>();
  let version = 0;
  /**
   * The key of one part's upload.
   * @param spaceId - The Space.
   * @param objectId - The object.
   * @param part - The part.
   * @returns The key.
   */
  const keyOf = (spaceId: string, objectId: string, part: string): string => `${spaceId}/${objectId}/${part}`;
  /** Tell subscribers the entries changed. */
  const changed = (): void => {
    version += 1;
    listeners.forEach((listener) => listener());
  };

  /**
   * Why putting this picture on the part would make a picture unusable, read from file headers.
   * @param input - The upload's start record.
   * @param look - The object's current look.
   * @param map - The new picture's id, or a placeholder while it is local.
   * @param mapSize - The new picture's size.
   * @returns The refusal with the object's texture total, or null.
   */
  const overLimit = (input: SceneLookUploadStart, look: SceneLook, map: string, mapSize: LookImageSize): ReturnType<typeof checkLookWrite> =>
    checkLookWrite({ ownBytes: input.ownBytes, clampBytes: input.clampBytes, limits: input.limits, look, part: input.part, map, mapSize,
      size: (assetId) => deps.size(input.projectId, assetId) });

  /**
   * Upload the file and write it on completion when everything still allows (design 6.3).
   * @param input - The upload's start record.
   * @param local - The local file's header size.
   * @param opened - The Space's session when the upload started, if open.
   * @param startLook - The object's look when the upload started.
   * @param key - The part's entry key.
   */
  const upload = async (input: SceneLookUploadStart, local: LookImageSize, opened: SceneSession | undefined,
    startLook: SceneLook | undefined, key: string): Promise<void> => {
    // Another explicit picture set on the part meanwhile blocks the write; a reset that deletes the key does not.
    let partChanged = false;
    let seen = startLook?.[input.part]?.map;
    const unwatch = opened?.subscribe(() => {
      const map = lookOf(opened, input.objectId)?.[input.part]?.map;
      if (map !== undefined && map !== seen) partChanged = true;
      seen = map;
    });
    const controller = new AbortController();
    let refused = false;
    /** A picture the server does not hold yet is a new picture on the object: judge the total before sending it. */
    const beforeSend = async (): Promise<void> => {
      const session = deps.session(input.name);
      const issue = await overLimit(input, (session ? lookOf(session, input.objectId) : undefined) ?? startLook ?? {}, 'local', local);
      if (!issue) return;
      refused = true;
      deps.notify(lookLimitNotice(issue, input.limits));
      controller.abort();
    };
    try {
      const stored = await deps.upload(input.file, { projectId: input.projectId, spaceId: input.spaceId }, (fraction) => {
        const entry = entries.get(key);
        if (entry) entries.set(key, { ...entry, percent: Math.round(fraction * 100) });
        changed();
      }, controller.signal, beforeSend);
      deps.invalidateImages(input.projectId);
      const session = deps.session(input.name);
      const look = session ? lookOf(session, input.objectId) : undefined;
      const object = session?.getSnapshot().objects.find((item) => item.id === input.objectId);
      if (!session) deps.notify({ key: 'spaces.threeD.look.spaceClosed', severity: 'warning' });
      else if (!object || object.locked || look === undefined) deps.notify({ key: 'spaces.threeD.look.objectGone', severity: 'warning' });
      else if (!session.getSnapshot().canEdit) deps.notify({ key: 'spaces.threeD.look.noLongerEditable', severity: 'warning' });
      else if (partChanged) deps.notify({ key: 'spaces.threeD.look.partChanged', severity: 'warning' });
      else if (await overLimit(input, look, stored.assetId, local)) deps.notify({ key: 'spaces.threeD.look.uploadedOverLimit', severity: 'warning' });
      else session.execute({ type: 'look', id: input.objectId, part: input.part, set: { map: stored.assetId } });
    } catch (error) {
      if (refused) return;
      deps.notify(pictureUploadFailedNotice(error, input.file.name));
    } finally {
      unwatch?.();
    }
  };

  return {
    async start(input) {
      const key = keyOf(input.spaceId, input.objectId, input.part);
      // One upload per part: its row shows the progress and offers no picture choice until it ends.
      if (entries.has(key)) return;
      const operationId = crypto.randomUUID();
      // The row shows progress and the Space stays open from the same moment (design 6.3).
      entries.set(key, { spaceId: input.spaceId, objectId: input.objectId, part: input.part, percent: 0, operationId });
      deps.register(input.spaceId, operationId);
      changed();
      try {
        let local: LookImageSize | null;
        try {
          local = await deps.readLocalSize(input.file);
        } catch {
          deps.notify(pictureReadFailedNotice(input.file.name));
          return;
        }
        if (!local || !isLookImageType(local.type)) {
          deps.notify(unsupportedPictureNotice(input.file.name));
          return;
        }
        const opened = deps.session(input.name);
        // The object total is judged once the server says whether it already holds this picture.
        await upload(input, local, opened, opened ? lookOf(opened, input.objectId) : undefined, key);
      } finally {
        if (entries.get(key)?.operationId === operationId) entries.delete(key);
        deps.unregister(input.spaceId, operationId);
        changed();
      }
    },
    get: (spaceId, objectId, part) => entries.get(keyOf(spaceId, objectId, part)),
    subscribe(listener) {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
    getVersion: () => version,
  };
}

let pageUploads: SceneLookUploads | null = null;

/**
 * The page's part-picture uploads, wired to the real network on first use.
 * @param queryClient - The page's query client, whose Project picture lists an upload refreshes.
 * @returns The page-wide holder.
 */
export function pageSceneLookUploads(queryClient: QueryClient): SceneLookUploads {
  pageUploads ??= createSceneLookUploads({
    upload: (file, context, onProgress, signal, beforeSend) => uploadMedia(file, context, onProgress, signal, undefined, beforeSend),
    notify: ({ key, params, severity }) => { toast[severity](t(key, params)); },
    register: (spaceId, operationId) => useSpaceOperationsStore.getState().register(spaceId, operationId),
    unregister: (spaceId, operationId) => useSpaceOperationsStore.getState().unregister(spaceId, operationId),
    invalidateImages: (projectId) => { void queryClient.invalidateQueries({ queryKey: projectImagesQueryKey(projectId) }); },
    readLocalSize: (file) => readPictureSize(file.stream()),
    size: (projectId, assetId) => pageLookTextureCache(projectId).size(assetId),
    session: peekSceneSession,
  });
  return pageUploads;
}
