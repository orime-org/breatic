// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QueryClient } from '@tanstack/react-query';

import {
  getLocale, isSceneLookImageMediaType, judgeSceneLookPicture, SCENE_LOOK_MAX_PARTS, t, uploadableFormatList, type SceneLook,
  type SceneLookPictureOutcome, type SceneLookPictureRefusal, type SceneLookPictureSettlement,
} from '@breatic/shared';

import { projectImagesQueryKey } from '@web/data/api/scene';
import { UploadFailedError, uploadMedia } from '@web/data/upload/media-upload';
import type { UploadContext } from '@web/data/upload/ingest-upload';
import { planSceneCommand } from '@web/data/yjs/scene-document';
import { peekSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import { toast } from '@web/lib/toast';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { uploadFailureMessageKey } from '@web/spaces/canvas/upload-failure';
import { checkLookWrite, type LookTextureLimits, type LookTextureReason } from '@web/spaces/three-d/look-texture-budget';
import { pageLookTextureCache, readPictureSize, type LookPictureSize } from '@web/spaces/three-d/viewport/look-texture-cache';

/** A message for the uploader. */
export interface LookUploadNotice {
  key: string;
  params?: Record<string, string>;
  severity: 'error' | 'warning';
}

export interface SceneLookUploadDeps {
  /** Send the file through the common upload pipeline; the server and collab put it on the part (design 6.3). */
  upload: (file: File, context: UploadContext, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<{ assetId: string }>;
  notify: (notice: LookUploadNotice) => void;
  /** Hold a Space busy (closing its tab is held back). */
  register: (spaceId: string, operationId: string) => void;
  unregister: (spaceId: string, operationId: string) => void;
  /** Refresh the Project's picture list, which now holds the upload. */
  invalidateImages: (projectId: string) => void;
  /** The local file's header size and type within `maxBytes`, or null when it cannot be read. */
  readLocalSize: (file: File, maxBytes: number) => Promise<LookPictureSize | null>;
  /** A used picture's header size in a Project within `maxBytes`, or null when it cannot be read. */
  size: (projectId: string, assetId: string, maxBytes: number) => Promise<LookPictureSize | null>;
  /** The open editing session of a Space document, if any; never creates one. */
  session: (name: string) => SceneSession | undefined;
}

/** A refused look write: which limit, and the bytes the object's textures would take. */
export interface LookLimitIssue {
  reason: LookTextureReason;
  total: number;
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

/** One upload, shown on its part row from the start until its picture is on the part or collab said why not. */
export interface SceneLookUploadEntry {
  spaceId: string;
  objectId: string;
  part: string;
  percent: number;
  /** The upload that owns the entry. */
  operationId: string;
  /** The Space document's name. */
  name: string;
  /** The part's picture when the upload started, or null for none. */
  startMap: string | null;
  /** The stored picture, once the server has it; collab then writes it. */
  picture?: string;
}

/** Collab's word on how it settled an uploaded picture: put on its part, or why not. */
export interface SceneLookSettlement {
  spaceId: string;
  objectId: string;
  part: string;
  picture: string;
  outcome: SceneLookPictureSettlement;
}

export interface SceneLookUploads {
  start: (input: SceneLookUploadStart) => Promise<void>;
  /** The upload of one part still in progress, if any. */
  get: (spaceId: string, objectId: string, part: string) => SceneLookUploadEntry | undefined;
  /** Collab settled a picture: end its upload, and tell the uploader why when it was not put on. */
  settled: (settlement: SceneLookSettlement) => void;
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
}

/**
 * The notice for a file that is not a picture a part may use.
 * @param filename - The file's or the asset's name.
 * @returns The notice.
 */
export function unsupportedPictureNotice(filename: string): LookUploadNotice {
  return { key: 'canvas.upload.unsupportedType', params: { filename, kind: 'image', formats: uploadableFormatList('image') }, severity: 'warning' };
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
  return { key: uploadFailureMessageKey(reason), params: { filename, kind: 'image', formats: uploadableFormatList('image') }, severity: 'error' };
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
 * @param type - The type readPictureSize read (jpeg, png or webp).
 * @returns True for a type the server lets a part use (PNG, JPEG, WebP).
 */
export function isLookImageType(type: string): boolean {
  return isSceneLookImageMediaType(`image/${type}`);
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
 * Why collab did not write a picture, told to its uploader.
 * @param reason - Collab's reason.
 * @returns The notice.
 */
function refusalNotice(reason: SceneLookPictureRefusal): LookUploadNotice {
  if (reason === 'objectGone') return { key: 'spaces.threeD.look.objectGone', severity: 'warning' };
  if (reason === 'partChanged') return { key: 'spaces.threeD.look.partChanged', severity: 'warning' };
  return { key: 'spaces.threeD.look.uploadedPartLimit', params: { max: String(SCENE_LOOK_MAX_PARTS) }, severity: 'warning' };
}

/**
 * The page's part-picture uploads: each outlives the panel and the editor. The browser checks the file and the object's
 * limits, sends the bytes, and leaves the write to the server and collab (inner#1693 design 6.3).
 * @param deps - The transport, the notices and the Space hold.
 * @returns The holder.
 */
export function createSceneLookUploads(deps: SceneLookUploadDeps): SceneLookUploads {
  const entries = new Map<string, SceneLookUploadEntry>();
  /** A settlement heard before its upload's answer named the stored picture, per part. */
  const early = new Map<string, { picture: string; outcome: SceneLookPictureSettlement }>();
  /**
   * Uploads whose row the open Space already freed (it shows collab will not write), keyed by part and picture: collab's
   * settlement still tells the uploader why.
   */
  const ended = new Set<string>();
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
   * What the open Space shows for a stored picture now, judged by the rule collab writes with; unknown while the bytes
   * still go or the Space is not open and ready.
   * @param entry - The entry.
   * @returns The outcome, or 'unknown'.
   */
  const shown = (entry: SceneLookUploadEntry): SceneLookPictureOutcome | 'unknown' => {
    if (entry.picture === undefined) return 'unknown';
    const session = deps.session(entry.name);
    if (!session || session.getSnapshot().status !== 'ready') return 'unknown';
    const object = session.getSnapshot().objects.find((item) => item.id === entry.objectId);
    return judgeSceneLookPicture({ object, part: entry.part, startMap: entry.startMap, picture: entry.picture });
  };

  /**
   * Whether an entry's row still shows the upload: bytes still going, or a stored picture collab would still write.
   * @param entry - The entry.
   * @returns True while the part row shows the upload.
   */
  const waiting = (entry: SceneLookUploadEntry): boolean => {
    const outcome = shown(entry);
    return outcome === 'unknown' || outcome === 'write';
  };

  /**
   * Free a stored picture's row once the open Space shows its outcome. When the picture is not on the part, collab's
   * settlement is still awaited for the reason.
   * @param key - The part's entry key.
   * @param entry - The entry.
   */
  const release = (key: string, entry: SceneLookUploadEntry): void => {
    entries.delete(key);
    if (entry.picture !== undefined && shown(entry) !== 'done') ended.add(`${key}\n${entry.picture}`);
  };

  /**
   * Tell the uploader how collab settled their picture: nothing when it was written, the reason otherwise.
   * @param outcome - Collab's outcome.
   */
  const tell = (outcome: SceneLookPictureSettlement): void => {
    if (outcome !== 'written') deps.notify(refusalNotice(outcome));
  };

  /**
   * End a stored picture's wait as soon as the open Space shows its outcome: the picture on the part, or the part changed
   * so collab will not write. A Space opened later is judged when its row is next read.
   * @param key - The part's entry key.
   * @param entry - The waiting entry.
   */
  const watch = (key: string, entry: SceneLookUploadEntry): void => {
    const session = deps.session(entry.name);
    if (!session) return;
    const stop = session.subscribe(() => {
      if (entries.get(key) !== entry) stop();
      else if (!waiting(entry)) {
        stop();
        release(key, entry);
        changed();
      }
    });
  };

  /**
   * Why putting this picture on the part would make a picture unusable, read from file headers.
   * @param input - The upload's start record.
   * @param look - The object's current look.
   * @param mapSize - The new picture's size.
   * @returns The refusal with the object's texture total, or null.
   */
  const overLimit = (input: SceneLookUploadStart, look: SceneLook, mapSize: LookPictureSize): ReturnType<typeof checkLookWrite> =>
    checkLookWrite({ ownBytes: input.ownBytes, clampBytes: input.clampBytes, limits: input.limits, look, part: input.part, map: 'local', mapSize,
      size: (assetId) => deps.size(input.projectId, assetId, input.limits.maxPictureHeaderBytes) });

  /**
   * Whether putting a picture on the part would give the object one part more than it can hold, judged by the same plan
   * the editor's write runs.
   * @param session - The Space's open session.
   * @param input - The upload's start record.
   * @returns True when the write would be refused for the part limit.
   */
  const pastPartLimit = (session: SceneSession, input: SceneLookUploadStart): boolean => {
    const plan = planSceneCommand(session.doc, session.name, { type: 'look', id: input.objectId, part: input.part, set: { map: crypto.randomUUID() } },
      session.getSnapshot().canEdit);
    return !plan.ok && plan.reason === 'lookPartLimit';
  };

  /**
   * Check the file and the object's limits, then send the bytes (design 6.3).
   * @param input - The upload's start record.
   * @param entry - The part's entry.
   * @param key - The part's entry key.
   * @returns The stored picture, or null when nothing was stored.
   */
  const send = async (input: SceneLookUploadStart, entry: SceneLookUploadEntry, key: string): Promise<string | null> => {
    let local: LookPictureSize | null;
    try {
      local = await deps.readLocalSize(input.file, input.limits.maxPictureHeaderBytes);
    } catch {
      deps.notify(pictureReadFailedNotice(input.file.name));
      return null;
    }
    if (!local || !isLookImageType(local.type)) {
      deps.notify(unsupportedPictureNotice(input.file.name));
      return null;
    }
    const session = deps.session(input.name);
    if (session && pastPartLimit(session, input)) {
      deps.notify({ key: 'spaces.threeD.look.partLimit', params: { max: String(SCENE_LOOK_MAX_PARTS) }, severity: 'warning' });
      return null;
    }
    // A picture the studio already holds is counted by its local size too: the ticket is what tells them apart.
    const issue = await overLimit(input, (session ? lookOf(session, input.objectId) : undefined) ?? {}, local);
    if (issue) {
      deps.notify(lookLimitNotice(issue, input.limits));
      return null;
    }
    try {
      const stored = await deps.upload(input.file, {
        projectId: input.projectId, spaceId: input.spaceId, purpose: 'scene_look', objectId: input.objectId, part: input.part,
        startMap: entry.startMap,
      }, (fraction) => {
        const now = entries.get(key);
        if (now) entries.set(key, { ...now, percent: Math.round(fraction * 100) });
        changed();
      }, new AbortController().signal);
      deps.invalidateImages(input.projectId);
      return stored.assetId;
    } catch (error) {
      deps.notify(pictureUploadFailedNotice(error, input.file.name));
      return null;
    }
  };

  return {
    async start(input) {
      const key = keyOf(input.spaceId, input.objectId, input.part);
      // One upload per part: its row shows the progress and offers no picture choice until it ends.
      const held = entries.get(key);
      if (held && waiting(held)) return;
      const operationId = crypto.randomUUID();
      // The part's picture as the user saw it when starting; collab writes only while the part still holds it or none.
      const starting = deps.session(input.name);
      const startMap = (starting ? lookOf(starting, input.objectId) : undefined)?.[input.part]?.map ?? null;
      const entry: SceneLookUploadEntry = { spaceId: input.spaceId, objectId: input.objectId, part: input.part, percent: 0, operationId,
        name: input.name, startMap };
      // The row shows progress and the Space stays open from the same moment (design 6.3).
      entries.set(key, entry);
      deps.register(input.spaceId, operationId);
      changed();
      let picture: string | null = null;
      try {
        picture = await send(input, entry, key);
      } finally {
        deps.unregister(input.spaceId, operationId);
        const heard = early.get(key);
        early.delete(key);
        const outcome = heard !== undefined && heard.picture === picture ? heard.outcome : undefined;
        if (entries.get(key)?.operationId === operationId) {
          if (picture === null || outcome !== undefined) entries.delete(key);
          else {
            const stored = { ...entry, percent: 100, picture };
            entries.set(key, stored);
            if (waiting(stored)) watch(key, stored);
            else release(key, stored);
          }
          if (outcome !== undefined) tell(outcome);
        }
        changed();
      }
    },
    get(spaceId, objectId, part) {
      const key = keyOf(spaceId, objectId, part);
      const entry = entries.get(key);
      if (!entry || waiting(entry)) return entry;
      // An upload whose outcome a Space opened later already shows is over.
      release(key, entry);
      return undefined;
    },
    settled(settlement) {
      const key = keyOf(settlement.spaceId, settlement.objectId, settlement.part);
      // An earlier upload whose row is already freed claims its picture first, even while a later one on the part sends.
      if (ended.delete(`${key}\n${settlement.picture}`)) {
        tell(settlement.outcome);
        return;
      }
      const entry = entries.get(key);
      if (entry !== undefined && entry.picture === undefined) {
        // A picture the studio already held is announced while its ticket is still being answered.
        early.set(key, { picture: settlement.picture, outcome: settlement.outcome });
        return;
      }
      if (entry?.picture === settlement.picture) {
        entries.delete(key);
        tell(settlement.outcome);
        changed();
      }
    },
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
    upload: (file, context, onProgress, signal) => uploadMedia(file, context, onProgress, signal),
    notify: ({ key, params, severity }) => { toast[severity](t(key, params)); },
    register: (spaceId, operationId) => useSpaceOperationsStore.getState().register(spaceId, operationId),
    unregister: (spaceId, operationId) => useSpaceOperationsStore.getState().unregister(spaceId, operationId),
    invalidateImages: (projectId) => { void queryClient.invalidateQueries({ queryKey: projectImagesQueryKey(projectId) }); },
    readLocalSize: (file, maxBytes) => readPictureSize(file.stream(), maxBytes),
    size: (projectId, assetId, maxBytes) => pageLookTextureCache(projectId).size(assetId, maxBytes),
    session: peekSceneSession,
  });
  return pageUploads;
}
