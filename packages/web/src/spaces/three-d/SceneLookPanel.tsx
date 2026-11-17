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
import { isLookImageType, lookLimitNotice, pageSceneLookUploads } from '@web/spaces/three-d/scene-look-uploads';
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
 * The appearance section wired to the session, the picture picker, uploads and the texture limits (inner#1693 design 3).
 * @param props - The object, its parts, the Space and the selected part.
 * @returns The section and its picker.
 */
export const SceneLookPanel = React.memo(function SceneLookPanel(props: SceneLookPanelProps): React.JSX.Element {
  const { session, object, report, projectId, spaceId, limits, mutable, selectedPart, onSelectPart } = props;
  const queryClient = useQueryClient();
  const uploads = React.useMemo(() => pageSceneLookUploads(queryClient), [queryClient]);
  const textures = React.useMemo(() => pageLookTextureCache(projectId), [projectId]);
  React.useSyncExternalStore(uploads.subscribe, uploads.getVersion);
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
  })) });
  const urlOf = React.useMemo(() => {
    const known = new Map(pictures.map((assetId, index) => [assetId, urls[index]?.data?.url]));
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
          toast.warning(translate('canvas.upload.unsupportedType', { filename: image.displayName ?? '' }));
          return;
        }
        const issue = await checkLookWrite({ ownBytes: ready.ownBytes, clampBytes: ready.clampBytes, limits: textureLimits,
          look, part, map: image.assetId, mapSize: size, size: (assetId) => textures.size(assetId) });
        if (issue) {
          const notice = lookLimitNotice(issue, size, textureLimits);
          toast[notice.severity](translate(notice.key, notice.params));
          return;
        }
        session.execute({ type: 'look', id: object.id, part, set: { map: image.assetId } });
      } finally {
        setChecking(null);
      }
    })();
  }, [pickerPart, ready, textures, textureLimits, look, session, object.id]);
  const pickFile = React.useCallback((file: File): void => {
    const part = pickerPart;
    if (part === null || !ready) return;
    void uploads.start({ projectId, spaceId, name: session.name, objectId: object.id, part, file,
      ownBytes: ready.ownBytes, clampBytes: ready.clampBytes, limits: textureLimits });
  }, [pickerPart, ready, uploads, projectId, spaceId, session.name, object.id, textureLimits]);
  const openChange = React.useCallback((open: boolean): void => { if (!open) setPickerPart(null); }, []);

  const uploadPercent = selectedPart === null ? null : uploads.get(spaceId, object.id, selectedPart)?.percent ?? null;
  return <>
    <SceneLookSection objectId={object.id} parts={ready ? ready.parts : report === 'failed' ? 'failed' : 'loading'} look={look}
      selectedPart={selectedPart} mutable={mutable} onSelectPart={onSelectPart} onCommand={onCommand} onChoosePicture={setPickerPart}
      gesture={gesture} spaceId={spaceId} uploadPercent={uploadPercent} checking={checking !== null && checking === selectedPart} pictureUrl={urlOf} />
    <SceneImagePickerDialog projectId={projectId} open={pickerPart !== null} onOpenChange={openChange} onPick={pick} onPickFile={pickFile} />
  </>;
});
