// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type * as Y from 'yjs';
import { Film, Pause, Play, Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { resolveTimelineArrangement, type TimelineDocumentV1, type TimelineVideoClip } from '@breatic/shared';
import { applyTimelineEdit } from '@breatic/shared/space-content';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Slider } from '@web/components/ui/slider';
import { timelineApi } from '@web/data/api/timeline';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import type { SpaceBodyProps } from '@web/spaces';
import { TimelineMaterialDialog } from '@web/spaces/timeline/TimelineMaterialDialog';
import { getTimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
import { useTimelineDocument } from '@web/spaces/timeline/use-timeline-document';
import { useTimelinePlayback } from '@web/spaces/timeline/use-timeline-playback';

/** The existing content document and its supported native projection. */
interface TimelineEditorProps extends SpaceBodyProps { doc: Y.Doc; document: TimelineDocumentV1 }

/** One selectable placement displayed on its shared track. */
interface TimelineClipButtonProps {
  projectId: string;
  clip: TimelineVideoClip;
  assetId: string;
  selected: boolean;
  conflict: boolean;
  list?: boolean;
  extent: number;
  onSelect: (clipId: string) => void;
}

/**
 * Show one registered source using its current Project-authorized metadata.
 * @param props - The shared placement and its local selection.
 * @param props.projectId - The Project authorizing this source.
 * @param props.clip - The shared integer-frame placement.
 * @param props.assetId - The fixed registered source identity.
 * @param props.selected - Whether the properties panel selects this placement.
 * @param props.conflict - Whether the merged arrangement reports a conflict.
 * @param props.extent - The visible track extent in frames.
 * @param props.onSelect - The local placement-selection action.
 * @param props.list - Whether this is a row in the conflict list.
 * @returns The keyboard-reachable track placement.
 * @throws {never} Never.
 */
function TimelineClipButton({ projectId, clip, assetId, selected, conflict, extent, onSelect, list = false }: TimelineClipButtonProps): React.JSX.Element {
  const t = useTranslation();
  const queryKey = React.useMemo(() => ['timeline-asset', projectId, assetId], [projectId, assetId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.resolveAsset(projectId, assetId, signal), [projectId, assetId]);
  const asset = useQuery({ queryKey, queryFn, enabled: assetId !== '' });
  const select = React.useCallback((): void => onSelect(clip.id), [onSelect, clip.id]);
  const style = React.useMemo(() => ({ left: `${clip.startFrame / extent * 100}%`, width: `${clip.durationFrames / extent * 100}%` }), [clip.startFrame, clip.durationFrames, extent]);
  return <Button data-testid={`timeline-${list ? 'conflict' : 'clip'}-${clip.id}`} type='button' variant={null} size={null}
    aria-pressed={selected} onClick={select} style={list ? undefined : style}
    className={cn('flex min-w-0 justify-start gap-2 overflow-hidden rounded-chrome border border-border bg-muted px-2 text-xs hover-enabled:bg-accent', list ? 'w-full py-2' : 'absolute top-2 h-12', conflict && 'border-status-error-border bg-status-error-bg', selected && 'border-active-border')}>
    <Film className='size-4 shrink-0' />
    <span className='min-w-0 truncate leading-normal'>{asset.data?.displayName || t('timeline.video')}</span>
    {conflict && <span className='shrink-0 text-status-error-foreground'>{t('timeline.conflict')}</span>}
    {list && <span className='shrink-0 text-muted-foreground'>{t('timeline.clipFrames', { start: clip.startFrame, duration: clip.durationFrames })}</span>}
  </Button>;
}

/**
 * Arrange registered videos and preview the shared integer-frame sequence.
 * @param props - The open Timeline's supported content and current role.
 * @param props.projectId - The owning Project.
 * @param props.spaceId - The open Space tab's identity.
 * @param props.readOnly - The existing Project role's editing restriction.
 * @param props.doc - The content document held by the existing Space connection.
 * @param props.document - Its validated native Timeline projection.
 * @returns The preview, track controls, shared placements and selected properties.
 * @throws {never} Never.
 */
function TimelineEditor({ projectId, spaceId, readOnly = false, doc, document }: TimelineEditorProps): React.JSX.Element {
  const t = useTranslation();
  const [frame, setFrame] = React.useState(0);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const queryClient = useQueryClient();
  const material = React.useMemo(() => getTimelineMediaDraft(doc, docName.timelineSpace(projectId, spaceId), { projectId, spaceId, queryClient }), [doc, projectId, spaceId, queryClient]);
  const materialState = React.useSyncExternalStore(material.subscribe, material.getSnapshot);
  const [materialOpen, setMaterialOpen] = useExclusiveOverlay(`timeline-material:${projectId}:${spaceId}`);
  // Activity suspends effects while hidden; uploads read the current rendered role.
  material.setCanWrite(!readOnly);
  React.useEffect(() => {
    if (!materialState.open && materialOpen) setMaterialOpen(false);
    if (materialState.open && !materialOpen) material.close();
  }, [materialState.open, materialOpen, setMaterialOpen, material]);
  const [editStart, setEditStart] = React.useState<string | null>(null);
  const [editError, setEditError] = React.useState(false);
  const [media, setMedia] = React.useState<HTMLVideoElement | null>(null);
  const clips = React.useMemo(() => Object.values(document.clips).sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id)), [document.clips]);
  const arrangement = React.useMemo(() => resolveTimelineArrangement({ tracks: Object.values(document.tracks), clips }), [document.tracks, clips]);
  const readyIds = React.useMemo(() => new Set(arrangement.readyClipIds), [arrangement.readyClipIds]);
  const selected = selectedId === null ? undefined : document.clips[selectedId];
  const selectedAssetId = selected === undefined ? '' : document.sources[selected.sourceId]?.assetId ?? '';
  const selectedResourceKey = React.useMemo(() => ['timeline-asset', projectId, selectedAssetId], [projectId, selectedAssetId]);
  const selectedResourceFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.resolveAsset(projectId, selectedAssetId, signal), [projectId, selectedAssetId]);
  const selectedResource = useQuery({ queryKey: selectedResourceKey, queryFn: selectedResourceFn, enabled: selectedAssetId !== '' });
  const active = clips.find((clip) => readyIds.has(clip.id) && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames) ?? null;
  const source = active === null ? null : document.sources[active.sourceId] ?? null;
  const assetId = source?.assetId ?? '';
  const resourceKey = React.useMemo(() => ['timeline-asset', projectId, assetId], [projectId, assetId]);
  const resourceFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.resolveAsset(projectId, assetId, signal), [projectId, assetId]);
  const resource = useQuery({ queryKey: resourceKey, queryFn: resourceFn, enabled: source !== null });
  const resourceState = source === null ? 'ready' : resource.isError ? 'failed' : resource.isPending ? 'loading' : 'ready';
  const playback = useTimelinePlayback({ document, frame, onFrame: setFrame, clip: active, source, media, enabled: true, resourceState });
  const { seek, retry: retryPlayback } = playback;
  const { refetch: refetchResource } = resource;
  const duration = Math.max(0, ...clips.map((clip) => clip.startFrame + clip.durationFrames));
  const extent = Math.max(duration, Math.ceil(document.settings.fps.num / document.settings.fps.den * 12));
  const seekValue = React.useMemo(() => [Math.min(frame, Math.max(0, duration - 1))], [frame, duration]);
  const onSeek = React.useCallback((value: number[]): void => seek(value[0] ?? 0), [seek]);
  const selectClip = React.useCallback((clipId: string): void => {
    setSelectedId(clipId);
    setEditStart(null);
    setEditError(false);
  }, []);
  const openMaterial = React.useCallback((): void => { if (!readOnly) { material.open(duration); setMaterialOpen(true); } }, [readOnly, duration, material, setMaterialOpen]);
  const closeMaterial = React.useCallback((): void => { material.close(); setMaterialOpen(false); }, [material, setMaterialOpen]);
  const beginEdit = React.useCallback((): void => {
    if (selected !== undefined && !readOnly) { setEditStart(String(selected.startFrame)); setEditError(false); }
  }, [selected, readOnly]);
  const changeStart = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => setEditStart(event.target.value), []);
  const applyStart = React.useCallback((event: React.FormEvent): void => {
    event.preventDefault();
    if (readOnly || selected === undefined || editStart === null) return;
    const value = Number(editStart);
    if (editStart.trim() === '' || !Number.isSafeInteger(value) || value < 0) { setEditError(true); return; }
    try {
      if (applyTimelineEdit(doc, { operation: 'set_start', parameters: { clipId: selected.id, startFrame: value } })) { setEditStart(null); setEditError(false); }
      else setEditError(true);
    } catch { setEditError(true); }
  }, [readOnly, selected, editStart, doc]);
  const retryPreview = React.useCallback((): void => { void refetchResource(); retryPlayback(); }, [refetchResource, retryPlayback]);
  const previewStyle = React.useMemo(() => ({ aspectRatio: `${document.settings.width} / ${document.settings.height}` }), [document.settings.width, document.settings.height]);
  const playheadStyle = React.useMemo(() => ({ left: `${frame / extent * 100}%` }), [frame, extent]);
  const inConflict = clips.some((clip) => !readyIds.has(clip.id) && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames);
  return <div data-testid='timeline-space' data-project-id={projectId} data-space-id={spaceId} className='flex h-full min-h-0 min-w-0 flex-col bg-background'>
    <div className='flex min-h-0 flex-1 items-center justify-center bg-muted/40 p-6'>
      <div data-testid='timeline-preview' className='relative flex max-h-full w-full max-w-4xl items-center justify-center overflow-hidden rounded-content-sm border border-border bg-background' style={previewStyle}>
        {source !== null && resource.data !== undefined && !resource.isError && (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded asset; no caption track until caption authoring lands.
          <video key={`${source.id}:${assetId}:${resource.data.fileUrl}`} ref={setMedia} src={resource.data.fileUrl} poster={resource.data.coverUrl ?? undefined} preload='auto' playsInline className='absolute inset-0 h-full w-full object-contain' />
        )}
        {clips.length === 0 && <div data-testid='timeline-space-empty' className='flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground'><Film className='size-8' /><p>{t('timeline.empty')}</p></div>}
        {inConflict && <p className='p-6 text-center text-sm text-status-error-foreground'>{t('timeline.conflictHelp')}</p>}
        {source !== null && resource.isPending && <p className='p-6 text-sm text-muted-foreground'>{t('timeline.loadingMedia')}</p>}
        {(resource.isError || playback.state === 'failed') && source !== null && <div className='relative flex flex-col items-center gap-3 p-6 text-sm'><p>{t('timeline.mediaUnavailable')}</p><Button variant='outline' onClick={retryPreview}>{t('timeline.retry')}</Button></div>}
      </div>
    </div>
    <div className='flex shrink-0 items-center gap-3 border-t border-border px-4 py-2'>
      <Button data-testid='timeline-play' variant='outline' size='sm' disabled={duration === 0} onClick={playback.toggle} icon={playback.intent === 'play' ? <Pause className='size-4' /> : <Play className='size-4' />}>{playback.intent === 'play' ? t('timeline.pause') : t('timeline.play')}</Button>
      <span className='shrink-0 text-xs tabular-nums'>{t('timeline.framePosition', { frame, total: duration })}</span>
      <Slider aria-label={t('timeline.seek')} value={seekValue} onValueChange={onSeek} min={0} max={Math.max(1, duration - 1)} step={1} disabled={duration === 0} className='min-w-0 flex-1' />
      <span className='shrink-0 text-xs text-muted-foreground'>{t(`timeline.transport.${playback.state}`)}</span>
    </div>
    <div className='flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2'>
      <span className='text-sm font-medium'>{t('timeline.tracks')}</span>
      {!readOnly && <Button data-testid='timeline-add-media' variant='outline' size='sm' onClick={openMaterial} icon={<Plus className='size-4' />}>{t('timeline.addMedia')}</Button>}
    </div>
    <ScrollArea scrollbars='both' className='h-40 shrink-0 border-t border-border'>
      <div className='flex min-w-full'>
        <div className='w-28 shrink-0 border-r border-border px-4 py-6 text-xs text-muted-foreground'>{t('timeline.visualTrack')}</div>
        <div data-testid='timeline-track-visual-1' className='relative h-28 min-w-0 flex-1'>
          <div data-testid='timeline-ruler' className='flex h-6 justify-between border-b border-border px-2 text-2xs tabular-nums text-muted-foreground'><span>0</span><span>{extent}</span></div>
          <div className='relative h-20'>{clips.map((clip) => <TimelineClipButton key={clip.id} projectId={projectId} clip={clip} assetId={document.sources[clip.sourceId]?.assetId ?? ''} selected={selectedId === clip.id} conflict={!readyIds.has(clip.id)} extent={extent} onSelect={selectClip} />)}<div className='pointer-events-none absolute inset-y-0 border-l border-active-border' style={playheadStyle} /></div>
        </div>
      </div>
    </ScrollArea>
    {arrangement.hasConflicts && <ScrollArea className='h-28 shrink-0 border-t border-border' viewportClassName='flex flex-col gap-2 p-3'>
      <p className='text-xs text-status-error-foreground'>{t('timeline.conflictHelp')}</p>
      {clips.filter((clip) => !readyIds.has(clip.id)).map((clip) => <TimelineClipButton key={clip.id} list projectId={projectId} clip={clip} assetId={document.sources[clip.sourceId]?.assetId ?? ''} selected={selectedId === clip.id} conflict extent={extent} onSelect={selectClip} />)}
    </ScrollArea>}
    <div className='flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-t border-border px-4 py-3 text-xs'>
      {selected === undefined ? <p className='text-muted-foreground'>{t('timeline.selectClip')}</p> : <><span className='max-w-64 truncate font-medium leading-normal'>{selectedResource.data?.displayName || t(selectedResource.isError ? 'timeline.mediaUnavailable' : 'timeline.video')}</span><span>{t('timeline.clipFrames', { start: selected.startFrame, duration: selected.durationFrames })}</span>{!readyIds.has(selected.id) && <span className='text-status-error-foreground'>{t('timeline.conflict')}</span>}{!readOnly && editStart === null && <Button data-testid='timeline-edit-start' variant='outline' size='sm' onClick={beginEdit}>{t('timeline.editStart')}</Button>}{editStart !== null && <form noValidate onSubmit={applyStart} className='flex flex-wrap items-center gap-2'><Label htmlFor={`timeline-edit-${spaceId}`}>{t('timeline.startFrame')}</Label><Input id={`timeline-edit-${spaceId}`} data-testid='timeline-start-frame' type='number' autoComplete='off' min={0} step={1} value={editStart} onChange={changeStart} className='w-28' /><Button data-testid='timeline-apply-start' type='submit' variant='outline' size='sm' disabled={readOnly}>{t('timeline.apply')}</Button>{editError && <span className='text-status-error-foreground'>{t('timeline.errors.invalid_range')}</span>}</form>}</>}
    </div>
    {materialState.open && materialOpen && <TimelineMaterialDialog key={`${projectId}:${spaceId}`} projectId={projectId} spaceId={spaceId} draft={material} canWrite={!readOnly} onClose={closeMaterial} />}
  </div>;
}

/**
 * Bind Timeline to the document and connection already held by its Space tab.
 * @param props - The current Project, Space and role.
 * @returns The existing content state or the supported Timeline editor.
 * @throws {never} Never.
 */
export function TimelineSpace(props: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const connection = useSpaceConnection();
  const doc = getDoc(docName.timelineSpace(props.projectId, props.spaceId));
  const state = useTimelineDocument(doc, connection.hasEverSynced);
  if (!connection.hasEverSynced) return <div data-testid={connection.status === 'authFailed' ? 'timeline-space-unavailable' : 'timeline-space-loading'} className='flex h-full items-center justify-center p-6 text-sm text-muted-foreground'>{t(connection.status === 'authFailed' ? 'timeline.unavailable' : 'timeline.loading')}</div>;
  if (state.document === null) return <div data-testid='timeline-space-error' className='flex h-full items-center justify-center p-6 text-sm text-muted-foreground'>{t('timeline.incompatible')}</div>;
  return <TimelineEditor {...props} doc={doc} document={state.document} />;
}
