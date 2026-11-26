// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { t as translate, type SceneImportLimits, type SceneLook, type SceneObject } from '@breatic/shared';
import { peekSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import { toast } from '@web/lib/toast';
import type { SceneFieldDraftOwner } from '@web/spaces/three-d/SceneField';
import { SceneImagePickerDialog } from '@web/spaces/three-d/SceneImagePickerDialog';
import { SceneLookSection, type SceneLookGesture } from '@web/spaces/three-d/SceneLookSection';
import { checkLookWrite } from '@web/spaces/three-d/look-texture-budget';
import { isLookImageType, lookLimitNotice, pageSceneLookUploads, pictureReadFailedNotice, unsupportedPictureNotice, type LookUploadNotice } from '@web/spaces/three-d/scene-look-uploads';
import { takeStepKey } from '@web/spaces/three-d/slider-step-key';
import { pageLookPictureSizes } from '@web/spaces/three-d/look-picture-size';
import type { SceneLookReport } from '@web/spaces/three-d/viewport/scene-look-runtime';
import type { SceneViewImage } from '@web/stores/scene-proposals';

export interface SceneLookPanelProps {
  session: SceneSession;
  objectId: string;
  /** The object's look, the same object while its content is unchanged. */
  look: SceneLook;
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
  /** The properties panel's number-field drafts. */
  fieldDrafts: SceneFieldDraftOwner['fieldDrafts'];
  onFieldDraftChange: SceneFieldDraftOwner['onFieldDraftChange'];
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
 * The object a Project pick writes to, in the Space as it is open now: the tab may have closed, or closed and opened
 * again, and the object may have been deleted while the picture was checked; each case is told (design 6.3).
 * @param name - The Space document name.
 * @param objectId - The object.
 * @returns The object, or undefined when there is none, after telling why.
 */
function openObject(name: string, objectId: string): SceneObject | undefined {
  const open = peekSceneSession(name);
  // A Space opened again whose document has not loaded yet holds no objects; it was closed while the pick ran.
  if (!open || open.getSnapshot().status !== 'ready') {
    notify({ key: 'spaces.threeD.look.pickSpaceClosed', severity: 'warning' });
    return undefined;
  }
  const object = open.getSnapshot().objects.find((item) => item.id === objectId);
  if (!object) notify({ key: 'spaces.threeD.look.pickObjectGone', severity: 'warning' });
  return object;
}

/**
 * The appearance section wired to the session, the picture picker, uploads and the texture limits (inner#1693 design 3).
 * @param props - The object and its look, its parts, the Space and the selected part.
 * @returns The section and its picker.
 */
export const SceneLookPanel = React.memo(function SceneLookPanel(props: SceneLookPanelProps): React.JSX.Element {
  const { session, objectId, look, report, projectId, spaceId, limits, mutable, selectedPart, onSelectPart, showing, fieldDrafts, onFieldDraftChange } = props;
  const showingPictures = React.useMemo(() => new Set(showing), [showing]);
  const queryClient = useQueryClient();
  const uploads = React.useMemo(() => pageSceneLookUploads(queryClient), [queryClient]);
  const sizes = pageLookPictureSizes();
  const uploadVersion = React.useSyncExternalStore(uploads.subscribe, uploads.getVersion);
  const [pickerPart, setPickerPart] = React.useState<string | null>(null);
  const isChecking = React.useCallback(
    (): boolean => selectedPart !== null && latestPicks.has(pickKey(session.name, objectId, selectedPart)), [selectedPart, session.name, objectId]);
  const checking = React.useSyncExternalStore(subscribePicks, isChecking);
  const ready = typeof report === 'object' ? report : null;
  const textureLimits = React.useMemo(() => ({
    maxTextureEdge: Math.min(limits.maxTextureEdge, ready?.deviceMaxEdge ?? limits.maxTextureEdge), maxTextureBytes: limits.maxTextureBytes,
    maxPictureHeaderBytes: limits.maxPictureHeaderBytes,
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
        session.previewGesture([{ id: objectId, look: { [part]: fields } }]);
        return true;
      },
      commit,
      cancel: (press) => { if (press === undefined || press === session.getSnapshot().cancelRevision) session.endGesture(false); },
      stepKey: (event) => { takeStepKey(event, begin, commit); },
    };
  }, [session, objectId]);
  const onCommand = React.useCallback((command: Parameters<SceneSession['execute']>[0]): boolean => session.execute(command).ok, [session]);

  const pick = React.useCallback((image: SceneViewImage): void => {
    const part = pickerPart;
    if (part === null || !ready) return;
    const key = pickKey(session.name, objectId, part);
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
        let size: Awaited<ReturnType<typeof sizes.read>>;
        try {
          size = await sizes.read(image.url, textureLimits.maxPictureHeaderBytes);
        } catch {
          if (isLatest()) notify(pictureReadFailedNotice(name));
          return;
        }
        if (!isLatest()) return;
        if (!size || !isLookImageType(size.type)) {
          notify(unsupportedPictureNotice(name));
          return;
        }
        // Judged against the look as it is now, through the Space as it is now: the size read above may have taken a while.
        const current = openObject(session.name, objectId);
        if (!current) return;
        const issue = await checkLookWrite({ ownBytes: ready.ownBytes, clampBytes: ready.clampBytes, limits: textureLimits,
          look: current.look ?? {}, part, map: image.url, mapSize: size, size: (url) => sizes.size(url, textureLimits.maxPictureHeaderBytes) });
        if (!isLatest()) return;
        if (issue) {
          notify(lookLimitNotice(issue, textureLimits));
          return;
        }
        if (!openObject(session.name, objectId)) return;
        peekSceneSession(session.name)!.execute({ type: 'look', id: objectId, part, set: { map: image.url } });
      } finally {
        if (isLatest()) {
          latestPicks.delete(key);
          picksChanged();
        }
      }
    })();
  }, [pickerPart, ready, sizes, textureLimits, session, objectId]);
  const pickFile = React.useCallback((file: File): void => {
    const part = pickerPart;
    if (part === null || !ready) return;
    void uploads.start({ projectId, spaceId, name: session.name, objectId: objectId, part, file,
      ownBytes: ready.ownBytes, clampBytes: ready.clampBytes, limits: textureLimits });
  }, [pickerPart, ready, uploads, projectId, spaceId, session.name, objectId, textureLimits]);
  const openChange = React.useCallback((open: boolean): void => { if (!open) setPickerPart(null); }, []);

  const uploadPercentOf = React.useMemo(() => {
    // A new lookup per progress step; a look change already redraws the section, whose rows read the lookup again.
    void uploadVersion;
    return (part: string): number | null => uploads.get(spaceId, objectId, part)?.percent ?? null;
  }, [uploads, spaceId, objectId, uploadVersion]);
  return <>
    <SceneLookSection objectId={objectId} parts={ready ? ready.parts : report === 'failed' ? 'failed' : 'loading'} look={look}
      selectedPart={selectedPart} mutable={mutable} onSelectPart={onSelectPart} onCommand={onCommand} onChoosePicture={setPickerPart}
      gesture={gesture} spaceId={spaceId} uploadPercentOf={uploadPercentOf} checking={checking}
      showingPictures={showingPictures} fieldDrafts={fieldDrafts} onFieldDraftChange={onFieldDraftChange} />
    <SceneImagePickerDialog projectId={projectId} open={pickerPart !== null} onOpenChange={openChange} onPick={pick} onPickFile={pickFile} />
  </>;
});
