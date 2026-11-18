// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';

import { t as translate, type SceneImportLimits, type SceneObject } from '@breatic/shared';
import { resolveSceneAsset } from '@web/data/api/scene';
import type { SceneSession } from '@web/data/yjs/scene-session';
import { toast } from '@web/lib/toast';
import { SceneImagePickerDialog } from '@web/spaces/three-d/SceneImagePickerDialog';
import { SceneLookSection, type SceneLookGesture } from '@web/spaces/three-d/SceneLookSection';
import { checkLookWrite } from '@web/spaces/three-d/look-texture-budget';
import { isLookImageType, lookLimitNotice, pageSceneLookUploads, pictureReadFailedNotice, unsupportedPictureNotice, type LookUploadNotice } from '@web/spaces/three-d/scene-look-uploads';
import { takeStepKey } from '@web/spaces/three-d/slider-step-key';
import { pageLookTextureCache } from '@web/spaces/three-d/viewport/look-texture-cache';
import type { SceneLookReport } from '@web/spaces/three-d/viewport/scene-look-runtime';
import type { SceneViewImage } from '@web/stores/scene-proposals';

export interface SceneLookPanelProps {
  session: SceneSession;
  object: SceneObject;
  /** The model's parts as the viewport reported them. */
  report: SceneLookReport | 'loading' | 'failed';
  projectId: string;
  spaceId: string;
  limits: SceneImportLimits;
  mutable: boolean;
  selectedPart: string | null;
  onSelectPart: (part: string | null) => void;
  /** The user pictures the scene shows for this object now. */
  showing: readonly string[];
}

/**
 * The resolved URLs of the pictures, in order; a stable array while they are unchanged.
 * @param results - The picture queries' results.
 * @returns Each picture's URL, when resolved.
 */
function urlsOnly(results: ReadonlyArray<{ data?: { url: string } }>): Array<string | undefined> {
  return results.map((result) => result.data?.url);
}

/**
 * Show a picture notice as a toast.
 * @param notice - The notice.
 */
function notify(notice: LookUploadNotice): void {
  toast[notice.severity](translate(notice.key, notice.params));
}

/** Numbers every pick on the page, so a number is never given twice. */
let picks = 0;

/**
 * The latest Project picture pick still being checked, per Space, object and part. It lives outside the panel, which is
 * mounted again for each selected object while an earlier pick may still be checking; a part is shown as checking
 * while it has an entry.
 */
const latestPicks = new Map<string, number>();
const pickListeners = new Set<() => void>();

/**
 * Tell mounted panels the checking picks changed.
 */
function picksChanged(): void {
  pickListeners.forEach((listener) => listener());
}

/**
 * Follow the checking picks.
 * @param listener - Called after each change.
 * @returns The unsubscribe.
 */
function subscribePicks(listener: () => void): () => void {
  pickListeners.add(listener);
  return () => { pickListeners.delete(listener); };
}

/**
 * The key a part's picks are kept under.
 * @param name - The Space document name.
 * @param objectId - The object.
 * @param part - The part.
 * @returns The key.
 */
const pickKey = (name: string, objectId: string, part: string): string => `${name}\n${objectId}\n${part}`;

/**
 * The appearance section wired to the session, the picture picker, uploads and the texture limits (inner#1693 design 3).
 * @param props - The object, its parts, the Space and the selected part.
 * @returns The section and its picker.
 */
export const SceneLookPanel = React.memo(function SceneLookPanel(props: SceneLookPanelProps): React.JSX.Element {
  const { session, object, report, projectId, spaceId, limits, mutable, selectedPart, onSelectPart, showing } = props;
  const showingPictures = React.useMemo(() => new Set(showing), [showing]);
  const queryClient = useQueryClient();
  const uploads = React.useMemo(() => pageSceneLookUploads(queryClient), [queryClient]);
  const textures = React.useMemo(() => pageLookTextureCache(projectId), [projectId]);
  const uploadVersion = React.useSyncExternalStore(uploads.subscribe, uploads.getVersion);
  const [pickerPart, setPickerPart] = React.useState<string | null>(null);
  const isChecking = React.useCallback(
    (): boolean => selectedPart !== null && latestPicks.has(pickKey(session.name, object.id, selectedPart)), [selectedPart, session.name, object.id]);
  const checking = React.useSyncExternalStore(subscribePicks, isChecking);
  const look = React.useMemo(() => object.look ?? {}, [object.look]);
  const ready = typeof report === 'object' ? report : null;
  const textureLimits = React.useMemo(() => ({
    maxTextureEdge: Math.min(limits.maxTextureEdge, ready?.deviceMaxEdge ?? limits.maxTextureEdge), maxTextureBytes: limits.maxTextureBytes,
  }), [limits, ready?.deviceMaxEdge]);

  const gesture = React.useMemo<SceneLookGesture>(() => {
    // The session owns the press, as the director's sliders do: a lock, an undo or Escape ends it.
    /**
     * Start a press, refused without edit access or on a locked object.
     * @returns The press, or -1 for a refused one.
     */
    const begin = (): number => (session.beginGesture() ? session.getSnapshot().cancelRevision : -1);
    /** End the press and write what it previewed. */
    const commit = (): void => { session.endGesture(true); };
    return {
      begin,
      preview: (part, fields) => {
        if (!session.getSnapshot().gestureActive) return false;
        session.previewGesture([{ id: object.id, look: { [part]: fields } }]);
        return true;
      },
      commit,
      cancel: (press) => { if (press === undefined || press === session.getSnapshot().cancelRevision) session.endGesture(false); },
      stepKey: (event) => { takeStepKey(event, begin, commit); },
    };
  }, [session, object.id]);
  const onCommand = React.useCallback((command: Parameters<SceneSession['execute']>[0]): void => { session.execute(command); }, [session]);

  const pictures = React.useMemo(() => [...new Set(Object.values(look).flatMap((fields) => (fields.map && fields.map !== 'none' ? [fields.map] : [])))], [look]);
  const urls = useQueries({ queries: pictures.map((assetId) => ({
    queryKey: ['scene-asset', projectId, assetId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => resolveSceneAsset(projectId, assetId, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })), combine: urlsOnly });
  const urlOf = React.useMemo(() => {
    const known = new Map(pictures.map((assetId, index) => [assetId, urls[index]]));
    return (assetId: string): string | undefined => known.get(assetId);
  }, [pictures, urls]);

  const pick = React.useCallback((image: SceneViewImage): void => {
    const part = pickerPart;
    if (part === null || !ready) return;
    const key = pickKey(session.name, object.id, part);
    const pickNumber = ++picks;
    latestPicks.set(key, pickNumber);
    picksChanged();
    /**
     * Whether no later pick for the part has started since this one.
     * @returns True while this is the part's latest pick.
     */
    const isLatest = (): boolean => latestPicks.get(key) === pickNumber;
    const name = image.displayName || translate('spaces.threeD.picker.unnamed');
    void (async () => {
      try {
        let size: Awaited<ReturnType<typeof textures.read>>;
        try {
          size = await textures.read(image.assetId);
        } catch {
          if (isLatest()) notify(pictureReadFailedNotice(name));
          return;
        }
        if (!isLatest()) return;
        if (!size || !isLookImageType(size.type)) {
          notify(unsupportedPictureNotice(name));
          return;
        }
        // Judged against the look as it is now: the size read above may have taken a while.
        const current = session.getSnapshot().objects.find((item) => item.id === object.id);
        if (!current) return;
        const issue = await checkLookWrite({ ownBytes: ready.ownBytes, clampBytes: ready.clampBytes, limits: textureLimits,
          look: current.look ?? {}, part, map: image.assetId, mapSize: size, size: (assetId) => textures.size(assetId) });
        if (!isLatest()) return;
        if (issue) {
          notify(lookLimitNotice(issue, textureLimits));
          return;
        }
        session.execute({ type: 'look', id: object.id, part, set: { map: image.assetId } });
      } finally {
        if (isLatest()) {
          latestPicks.delete(key);
          picksChanged();
        }
      }
    })();
  }, [pickerPart, ready, textures, textureLimits, session, object.id]);
  const pickFile = React.useCallback((file: File): void => {
    const part = pickerPart;
    if (part === null || !ready) return;
    void uploads.start({ projectId, spaceId, name: session.name, objectId: object.id, part, file,
      ownBytes: ready.ownBytes, clampBytes: ready.clampBytes, limits: textureLimits });
  }, [pickerPart, ready, uploads, projectId, spaceId, session.name, object.id, textureLimits]);
  const openChange = React.useCallback((open: boolean): void => { if (!open) setPickerPart(null); }, []);

  const uploadPercentOf = React.useMemo(() => {
    // A new lookup per progress step, so the memoized section draws it.
    void uploadVersion;
    return (part: string): number | null => uploads.get(spaceId, object.id, part)?.percent ?? null;
  }, [uploads, spaceId, object.id, uploadVersion]);
  return <>
    <SceneLookSection objectId={object.id} parts={ready ? ready.parts : report === 'failed' ? 'failed' : 'loading'} look={look}
      selectedPart={selectedPart} mutable={mutable} onSelectPart={onSelectPart} onCommand={onCommand} onChoosePicture={setPickerPart}
      gesture={gesture} spaceId={spaceId} uploadPercentOf={uploadPercentOf} checking={checking} pictureUrl={urlOf}
      showingPictures={showingPictures} />
    <SceneImagePickerDialog projectId={projectId} open={pickerPart !== null} onOpenChange={openChange} onPick={pick} onPickFile={pickFile} />
  </>;
});
