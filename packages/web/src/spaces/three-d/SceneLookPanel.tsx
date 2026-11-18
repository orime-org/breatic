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
import { isLookImageType, lookLimitNotice, pageSceneLookUploads, unsupportedPictureNotice, type LookUploadNotice } from '@web/spaces/three-d/scene-look-uploads';
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

/**
 * The appearance section wired to the session, the picture picker, uploads and the texture limits (inner#1693 design 3).
 * @param props - The object, its parts, the Space and the selected part.
 * @returns The section and its picker.
 */
export const SceneLookPanel = React.memo(function SceneLookPanel(props: SceneLookPanelProps): React.JSX.Element {
  const { session, object, report, projectId, spaceId, limits, mutable, selectedPart, onSelectPart } = props;
  const queryClient = useQueryClient();
  const uploads = React.useMemo(() => pageSceneLookUploads(queryClient), [queryClient]);
  const textures = React.useMemo(() => pageLookTextureCache(projectId), [projectId]);
  const uploadVersion = React.useSyncExternalStore(uploads.subscribe, uploads.getVersion);
  const [pickerPart, setPickerPart] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState<string | null>(null);
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
    setChecking(part);
    void (async () => {
      try {
        const size = await textures.size(image.assetId);
        if (!size || !isLookImageType(size.type)) {
          notify(unsupportedPictureNotice(image.displayName ?? ''));
          return;
        }
        // Judged against the look as it is now: the size read above may have taken a while.
        const current = session.getSnapshot().objects.find((item) => item.id === object.id);
        if (!current) return;
        const issue = await checkLookWrite({ ownBytes: ready.ownBytes, clampBytes: ready.clampBytes, limits: textureLimits,
          look: current.look ?? {}, part, map: image.assetId, mapSize: size, size: (assetId) => textures.size(assetId) });
        if (issue) {
          notify(lookLimitNotice(issue, size, textureLimits));
          return;
        }
        session.execute({ type: 'look', id: object.id, part, set: { map: image.assetId } });
      } finally {
        setChecking((shown) => (shown === part ? null : shown));
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
      gesture={gesture} spaceId={spaceId} uploadPercentOf={uploadPercentOf} checking={checking !== null && checking === selectedPart} pictureUrl={urlOf} />
    <SceneImagePickerDialog projectId={projectId} open={pickerPart !== null} onOpenChange={openChange} onPick={pick} onPickFile={pickFile} />
  </>;
});
