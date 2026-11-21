// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useVideoFrameThumbnails } from '@web/spaces/canvas/mini-tool/video/use-video-frame-thumbnails';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import { Skeleton } from '@web/components/ui/skeleton';
import { Plus, Trash2 } from 'lucide-react';
import { newId } from '@breatic/shared';
import { planVideoFrames, planVideoSplit, type MiniToolAnalysisRecord, type VideoPlanGrid, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { frameIndexOfMediaTime, frameMidpointSeconds, gridDuration, gridFrameCovering, gridSeconds } from '@web/spaces/canvas/video-presentation/frame-grid-time';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { secondsLabel, useShownTime, VideoPlaybackStrip, type VideoPlaybackLiveClock } from '@web/spaces/canvas/mini-tool/video/VideoPlaybackStrip';
import type { SourceRangePlayback } from '@web/spaces/canvas/video-presentation/play-source-range';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { latestMiniToolAnalysis } from '@web/data/api/mini-tool-analyses';
import { useTranslation } from '@web/i18n/use-translation';
import { PARAM_OPTION_CLASS } from '@web/spaces/canvas/generate/ParamOptionGroup';

export interface VideoToolControlsProps<K extends VideoToolId = VideoToolId> {
  toolId: K;
  draft: VideoToolDraftById[K];
  onChange: (draft: VideoToolDraftById[K]) => void;
  analyses: readonly MiniToolAnalysisRecord[];
  previewSource?: VideoPresentationSource | null;
  /** The selected version's grid while the source is usable, otherwise null (frames-split §7.12). */
  grid: VideoPlanGrid | null;
  presentedTime: number | null;
  /** The source player's live clock, which the playback strip follows while the source plays. */
  liveClock?: VideoPlaybackLiveClock;
  disabled: boolean;
  onAnalyse: (kind: 'scene_cuts') => void;
  analysing: boolean;
  analysisCreditText?: string;
  onInvalidChange?: (key: string, invalid: boolean) => void;
  onSeek?: (time: number) => void;
  /** Plays exactly one source range in the node's player (canvas design §4 split row preview). */
  onPlayRange?: (start: number, end: number) => SourceRangePlayback;
  sourceEpoch?: number;
  seekEpoch?: number;
}

interface NumericProps {
  value: number;
  label: string;
  testId: string;
  min: number;
  max?: number;
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
  disabled: boolean;
  onChange: (value: number) => void;
  onInvalidChange?: (key: string, invalid: boolean) => void;
  /** Called when the field loses focus; with it, Enter also leaves the field. */
  onSettle?: () => void;
}

/**
 * Retains partial numeric edits while only committing valid persisted values.
 * @throws {never} Never.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
export function VideoNumericInput(props: NumericProps): React.JSX.Element {
  const { value: persisted, testId, onInvalidChange } = props;
  const [text, setText] = React.useState(String(props.value));
  const written = React.useRef(props.value);
  const onChange = React.useRef(props.onChange);
  onChange.current = props.onChange;
  const shown = text.trim() === '' ? NaN : Number(text);
  const invalid = !Number.isFinite(shown) || shown < props.min || (props.exclusiveMin === true && shown === props.min) || (props.max !== undefined && (shown > props.max || props.exclusiveMax === true && shown === props.max));
  // The one writer: the shown number once it is accepted and not yet written, after a keystroke or after a limit moved
  // under refused text. Declared before the sync below, so in the commit where the stored value changes elsewhere the
  // shown text is not written back over it.
  React.useEffect(() => {
    if (!invalid && shown !== written.current) {
      written.current = shown;
      onChange.current(shown);
    }
  }, [invalid, shown]);
  React.useEffect(() => {
    if (persisted !== written.current) {
      written.current = persisted;
      setText(String(persisted));
    }
  }, [persisted]);
  // Reported under the field's current key whenever the shown text, a limit or the key changes, so a row that moves to
  // another position or a limit that moves under the text still blocks the run.
  React.useEffect(() => {
    onInvalidChange?.(testId, invalid);
    return () => onInvalidChange?.(testId, false);
  }, [onInvalidChange, testId, invalid]);
  const { onSettle } = props;
  return <Input type='text' inputMode='decimal' autoComplete='off' value={text} aria-label={props.label} data-testid={props.testId} aria-invalid={invalid} disabled={props.disabled} className='h-[var(--control-height)] min-w-0 px-2 text-xs tabular-nums md:text-xs' onBlur={onSettle} onKeyDown={(event) => {
    if (event.key === 'Enter' && onSettle !== undefined) event.currentTarget.blur();
  }} onChange={(event) => setText(event.currentTarget.value)} />;
}

/**
 * Renders the approved parameter controls for the selected video tool.
 * @throws {Error} When a supplied grid or draft is malformed.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
export function VideoToolControls(props: VideoToolControlsProps): React.JSX.Element {
  const t = useTranslation();
  const previewFrames = React.useMemo(() => {
    if (props.toolId !== 'video.extract-frames' || props.grid === null) return [];
    const draft = props.draft as VideoToolDraftById['video.extract-frames'];
    if (draft.params.mode === 'current' && props.presentedTime === null) return [];
    const request = draft.params.mode === 'current' && props.presentedTime !== null ? { ...draft.params, frameIndex: frameIndexOfMediaTime(props.presentedTime, props.grid) } : draft.params;
    return planVideoFrames(props.grid, request).map((frame) => frame.frameIndex);
  }, [props.toolId, props.grid, props.draft, props.presentedTime]);
  switch (props.toolId) {
    case 'video.extract-frames': {
      const draft = props.draft as VideoToolDraftById['video.extract-frames'];
      const planned = previewFrames;
      /**
       * Chooses a frame mode; Current takes the presented time and waits for one.
       * @param mode - The mode.
       * @throws {never} Never.
       */
      const choose = (mode: typeof draft.params.mode): void => {
        if (mode === 'current' && (props.presentedTime === null || props.grid === null)) return;
        props.onChange({ ...draft, params: { ...draft.params, mode, ...(mode === 'current' && props.presentedTime !== null && props.grid !== null ? { frameIndex: frameIndexOfMediaTime(props.presentedTime, props.grid) } : {}) } });
      };
      // Canvas design §4 frames row: three equal buttons in one row; while the grid is not usable the panel shows only
      // its ledger line (frames-split §10.6), and the modes stay usable (only Run waits).
      return <><div className='grid grid-cols-3 gap-1.5' data-testid='video-frame-modes'>{(['first', 'last', 'current'] as const).map((mode) => <Button key={mode} variant={null} size={null} data-testid={`video-frame-mode-${mode}`} aria-current={draft.params.mode === mode} disabled={props.disabled || mode === 'current' && props.presentedTime === null} className={PARAM_OPTION_CLASS} onClick={() => choose(mode)}>{t(`canvas.miniTool.videoUI.${mode}`)}</Button>)}</div>{props.grid === null ? null : <>{draft.params.mode === 'current' && props.presentedTime === null ? <p className='text-center text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.currentFrameUnavailable')}</p> : null}<VideoFramePreview source={props.previewSource ?? null} grid={props.grid} frames={planned} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} onSeek={props.onSeek} /></>}</>;
    }
    case 'video.split': {
      // Demo main.tsx split branch: Detect, then the cut editor once the grid is usable (frames-split §10.6: until then
      // only the ledger line the container draws), then a failed detection's row with Retry.
      const failed = latestMiniToolAnalysis(props.analyses.filter((record) => record.kind === 'scene_cuts'))?.status === 'failed';
      return <><Button variant='outline' size='sm' data-testid='video-detect-scenes' loading={props.analysing} disabled={props.disabled || props.analysing} onClick={() => props.onAnalyse('scene_cuts')}>{t(props.analyses.some((record) => record.kind === 'scene_cuts') ? 'canvas.miniTool.videoUI.detectAgain' : 'canvas.miniTool.videoUI.detectScenes')}{props.analysisCreditText === undefined ? null : <span className='text-xs text-muted-foreground'>{props.analysisCreditText}</span>}</Button>
        {props.grid === null ? null : <VideoCutEditor {...props} grid={props.grid} />}
        {failed ? <div data-testid='video-detection-error' className='flex items-center justify-between gap-3 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.detectionError')}</span><Button variant='outline' size='compact' disabled={props.disabled || props.analysing} onClick={() => props.onAnalyse('scene_cuts')}>{t('canvas.task.action.retry')}</Button></div> : null}</>;
    }
  }
}

/**
 * The cuts as stored and shown (canvas design §4 split row): sorted, unique and inside the video, not snapped, so a typed
 * value stays what was typed; only the plan snaps them to frame starts. A cut at 0 or at or past the end is left out
 * rather than refused.
 * @param duration - The presentation's video end.
 * @param cuts - The stored or edited cuts.
 * @returns The normalized cuts.
 * @throws {never} Never.
 */
export function splitCuts(duration: number, cuts: readonly number[]): number[] {
  return [...new Set(cuts.filter((cut) => cut > 0 && cut < duration))].sort((a, b) => a - b);
}

/** One cut row, its id kept while the row lives so the row's input and handle keep their element. */
interface CutRow { id: string; value: number }

/**
 * Gives each value the id of the first unused earlier row with that value, and a new id otherwise, so a row keeps its
 * element when the rows are reordered or merged.
 * @param previous - The rows shown before.
 * @param values - The values to show.
 * @returns The rows.
 * @throws {never} Never.
 */
function withRowIds(previous: readonly CutRow[], values: readonly number[]): CutRow[] {
  const free = [...previous];
  return values.map((value) => {
    const at = free.findIndex((row) => row.value === value);
    return { id: at < 0 ? newId() : free.splice(at, 1)[0]!.id, value };
  });
}

/**
 * A cut's frame start as its row shows it: rounded up to the millisecond, which stays inside that frame at any rate up to
 * 1000 fps, so the shown time typed back covers the same frame; the tolerance keeps an exact millisecond from rounding up.
 * @param seconds - The frame start.
 * @returns The shown seconds.
 * @throws {never} Never.
 */
function cutRowSeconds(seconds: number): number {
  return Math.ceil(seconds * 1000 - 1e-6) / 1000;
}

/**
 * Edits split cuts on the source clock (demo video-controls.tsx CutEditor and PlaybackStrip cuts): numbered handles on the
 * filmstrip that drag (committed once on release), step one frame with the arrow keys and go with Delete; the count with
 * Add at cursor; one row per cut; and one button per segment that plays exactly that range in the node's player.
 * Cuts are stored as grid frame numbers (frames-split §10.7 split row); the editor shows them as the seconds their frames
 * start at, and a typed or dragged time becomes the frame covering it.
 * @param props - The panel props and the usable grid.
 * @returns The cut editor.
 * @throws {z.ZodError} When the grid is malformed.
 */
function VideoCutEditor(props: VideoToolControlsProps & { grid: VideoPlanGrid }): React.JSX.Element {
  const t = useTranslation();
  const { grid } = props;
  const draft = props.draft as VideoToolDraftById['video.split'];
  const duration = gridDuration(grid);
  const cutFrames = React.useMemo(() => splitCuts(grid.frameCount, draft.params.cuts), [grid.frameCount, draft.params.cuts]);
  const cuts = React.useMemo(() => cutFrames.map((frame) => gridSeconds(grid, frame)), [grid, cutFrames]);
  const segments = React.useMemo(() => planVideoSplit(grid, cutFrames), [grid, cutFrames]);
  // Each handle sits on the frame start its cut splits at.
  const snapped = cuts;
  /**
   * The grid frames a list of shown times stand for, each the frame covering it.
   * @param values - Times in seconds.
   * @returns Frame numbers.
   * @throws {never} Never.
   */
  const toFrames = (values: readonly number[]): number[] => values.map((value) => gridFrameCovering(grid, value));
  // The rows while one is typed (`id`): written back in place so the typed text stays on its row (web AGENTS "Inputs send
  // what they show"). Leaving the field writes nothing: every reader normalizes, so the rows then show the ordered cuts.
  const [typing, setTyping] = React.useState<{ rows: CutRow[]; id: string } | null>(null);
  // The rows last shown, or those an edit just wrote, whose ids the next rows take by value so an edited row (a stepped or
  // dragged handle) keeps its element and focus.
  const shown = React.useRef<CutRow[]>([]);
  const rows = React.useMemo(() => typing?.rows ?? withRowIds(shown.current, cuts), [typing, cuts]);
  React.useLayoutEffect(() => { shown.current = rows; }, [rows]);
  const handles = React.useMemo(() => withRowIds(rows, cuts), [rows, cuts]);
  // A bin press keeps the focus where it is (its mousedown is prevented), so leaving a typed row does not reorder the rows
  // under the pointer before the click removes one.
  const [dragging, setDragging] = React.useState<{ index: number; time: number; moved: boolean } | null>(null);
  const gesture = React.useRef<string | null>(null);
  React.useEffect(() => { gesture.current = null; setDragging(null); }, [draft.revision, props.sourceEpoch, props.seekEpoch, props.disabled]);
  const [previewing, setPreviewing] = React.useState<{ start: number; end: number } | null>(null);
  const [playFailed, setPlayFailed] = React.useState(false);
  const playback = React.useRef<SourceRangePlayback | null>(null);
  React.useEffect(() => () => playback.current?.stop(), []);
  /**
   * Commits edited rows, their cuts normalized, keeping each row's id for the rows that follow.
   * @param next - The edited rows.
   * @throws {never} Never.
   */
  const commit = (next: CutRow[]): void => {
    shown.current = next;
    props.onChange({ ...draft, params: { ...draft.params, cuts: splitCuts(grid.frameCount, toFrames(next.map((row) => row.value))) } });
  };
  /**
   * The handles with one cut moved.
   * @param index - The handle.
   * @param value - Its new cut.
   * @returns The rows.
   * @throws {never} Never.
   */
  const moveTo = (index: number, value: number): CutRow[] => handles.map((row, position) => position === index ? { id: row.id, value } : row);
  /**
   * The start of the frame under the pointer on the strip a handle sits on, the cut a drag there makes; a drag past either
   * end keeps one frame on that side, as the demo's drag stays inside the video.
   * @param event - The pointer event on a handle.
   * @returns The frame start in seconds.
   * @throws {never} Never.
   */
  const frameStartAt = (event: React.PointerEvent<HTMLElement>): number => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    const time = box === undefined || box.width <= 0 ? 0 : Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * duration;
    const last = grid.frameCount - 1;
    // A one-frame video has no frame a cut can start, and the release below commits nothing at 0.
    return last < 1 ? 0 : gridSeconds(grid, Math.max(1, Math.min(last, gridFrameCovering(grid, time))));
  };
  /**
   * Writes a typed row in place, unsorted and not merged, so the typed text stays on the row being typed.
   * @param id - The typed row.
   * @param value - The typed number.
   * @throws {never} Never.
   */
  const type = (id: string, value: number): void => {
    const next = rows.map((row) => row.id === id ? { id, value } : row);
    setTyping({ rows: next, id });
    props.onChange({ ...draft, params: { ...draft.params, cuts: toFrames(next.map((row) => row.value)) } });
  };
  /**
   * Ends typing once the field is left; the rows then show the ordered cuts.
   * @throws {never} Never.
   */
  const settle = (): void => { setTyping(null); };
  /**
   * Removes a row; the row being typed, when it is another one, stays typed with its focus.
   * @param id - The removed row.
   * @throws {never} Never.
   */
  const remove = (id: string): void => {
    const next = rows.filter((row) => row.id !== id);
    shown.current = next;
    setTyping(typing !== null && typing.id !== id ? { rows: next, id: typing.id } : null);
    props.onChange({ ...draft, params: { ...draft.params, cuts: toFrames(next.map((row) => row.value)) } });
  };
  /**
   * Moves a cut one frame back or forward from the frame it splits at, keeping it inside the video.
   * @param index - The cut.
   * @param backwards - Whether to step back.
   * @throws {never} Never.
   */
  const step = (index: number, backwards: boolean): void => {
    const neighbour = cutFrames[index]! + (backwards ? -1 : 1);
    if (neighbour >= 1 && neighbour < grid.frameCount) commit(moveTo(index, gridSeconds(grid, neighbour)));
  };
  /**
   * Plays one segment in the node's player and shows it until it ends; a refused play says the media is unavailable.
   * @param start - The segment start.
   * @param end - The segment end.
   * @throws {never} A refused play is shown.
   */
  const preview = (start: number, end: number): void => {
    playback.current?.stop();
    const next = props.onPlayRange?.(start, end);
    if (next === undefined) return;
    playback.current = next;
    setPreviewing({ start, end });
    setPlayFailed(false);
    next.done.then(() => { if (playback.current === next) { playback.current = null; setPreviewing(null); } },
      () => { if (playback.current === next) { playback.current = null; setPreviewing(null); setPlayFailed(true); } });
  };
  const { onChange } = props;
  const add = React.useCallback((time: number): void => {
    const next = [...handles, { id: newId(), value: time }];
    shown.current = next;
    onChange({ ...draft, params: { ...draft.params, cuts: splitCuts(grid.frameCount, next.map((row) => gridFrameCovering(grid, row.value))) } });
  }, [onChange, draft, grid, handles]);
  return <div className='grid gap-2' data-testid='video-cut-editor'>
    <VideoPlaybackStrip src={draft.source.canonicalURL} source={props.previewSource ?? null} duration={duration} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} presentedTime={props.presentedTime} liveClock={props.liveClock} onSeek={props.onSeek}>
      {handles.map(({ id }, index) => <Button key={id} variant={null} size={null} data-testid={`video-cut-handle-${index}`} disabled={props.disabled} className='absolute inset-y-0 z-10 w-6 -translate-x-1/2 rounded-none' style={{ left: `${(dragging?.index === index ? dragging.time : snapped[index]!) * 100 / duration}%` }}
        onPointerDown={(event) => {
          if (event.button !== 0 || props.disabled) return;
          // Prevented so the press neither seeks the strip nor selects; focused by hand, so the keys then act on this handle.
          event.stopPropagation(); event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = draft.revision;
          setDragging({ index, time: snapped[index]!, moved: false });
        }}
        onPointerMove={(event) => { if (dragging?.index !== index) return; event.stopPropagation(); setDragging({ index, time: frameStartAt(event), moved: true }); }}
        onPointerUp={(event) => {
          if (dragging?.index !== index) return;
          event.stopPropagation();
          // A press without a move only focuses the handle for the arrow keys; a drag commits where it was last drawn.
          const { time, moved } = dragging;
          const current = gesture.current === draft.revision && !props.disabled;
          gesture.current = null; setDragging(null);
          if (moved && current && time > 0 && time < duration) commit(moveTo(index, time));
        }}
        onPointerCancel={() => { gesture.current = null; setDragging(null); }}
        onKeyDown={(event) => {
          if (props.disabled) return;
          if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); commit(handles.filter((_, position) => position !== index)); }
          else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); step(index, event.key === 'ArrowLeft' || event.key === 'ArrowDown'); }
        }}><span className='h-full border-l border-status-selected' /><span className='absolute bottom-0 rounded-chrome-sm bg-popover px-1 text-xs text-foreground'>{index + 1}</span></Button>)}
    </VideoPlaybackStrip>
    <div className='flex items-center justify-between gap-2'><span data-testid='video-cut-count' className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.cutSummary', { cuts: segments.length - 1, segments: segments.length })}</span><AddCutButton grid={grid} starts={snapped} presentedTime={props.presentedTime} liveClock={props.liveClock} disabled={props.disabled} onAdd={add} /></div>
    {rows.length === 0 ? <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.noCuts')}</p> : <ScrollArea className='max-h-48' viewportClassName='max-h-48'><div className='grid gap-2'>{rows.map(({ id, value: cut }, index) => <div key={id} className='flex items-center gap-2'><span className='text-xs'>{index + 1}</span><VideoNumericInput value={cutRowSeconds(cut)} label={`${t('canvas.miniTool.videoUI.cutPoint')} ${index + 1}`} testId={`video-cut-${index}`} min={0} exclusiveMin max={duration} exclusiveMax disabled={props.disabled} onInvalidChange={props.onInvalidChange} onChange={(value) => type(id, value)} onSettle={settle} /><span className='text-xs'>s</span><Button variant='ghost' size='compact' disabled={props.disabled} aria-label={t('canvas.miniTool.videoUI.removeCut')} onMouseDown={(event) => event.preventDefault()} onClick={() => remove(id)}><Trash2 className='size-3.5' /></Button></div>)}</div></ScrollArea>}
    <div className='flex min-h-8 overflow-hidden rounded-chrome border border-border'>{segments.map((segment) => <Button key={segment.outputIndex} variant={null} size={null} data-testid={`video-segment-${segment.outputIndex}`} disabled={props.onPlayRange === undefined} className='min-w-0 rounded-none border-r border-border bg-accent px-1 py-2 text-xs last:border-r-0 hover-enabled:bg-accent-strong' style={{ flexGrow: segment.end - segment.start, flexBasis: 0 }} onClick={() => preview(gridSeconds(grid, segment.start), gridSeconds(grid, segment.end))}>{segment.outputIndex + 1}</Button>)}</div>
    {previewing === null ? null : <div data-testid='video-segment-preview' className='flex items-center justify-between gap-2 text-xs text-muted-foreground'><span className='tabular-nums'>{t('canvas.miniTool.videoUI.segmentPreview', { start: secondsLabel(previewing.start), end: secondsLabel(previewing.end) })}</span><Button variant='outline' size='compact' onClick={() => playback.current?.stop()}>{t('canvas.miniTool.videoUI.stopPreview')}</Button></div>}
    {playFailed ? <p className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.mediaError')}</p> : null}
  </div>;
}

interface AddCutButtonProps { grid: VideoPlanGrid; starts: readonly number[]; presentedTime: number | null; liveClock?: VideoPlaybackLiveClock; disabled: boolean; onAdd: (time: number) => void }

/**
 * Add at cursor, available by the time the strip's head shows; a press reads the live clock, so a cut added while the
 * source plays lands where the head is, not at the time the panel last rendered with. A time makes a new cut when the
 * frame start it splits at, by planVideoSplit's snap rule, is after the first frame and not already a cut's; this is
 * read on every animation frame while the source plays, so it is not a whole plan.
 * @param props - The grid, the frame starts the cuts split at, the clock and the add command.
 * @returns The button.
 * @throws {never} Never.
 */
const AddCutButton = React.memo(function AddCutButton(props: AddCutButtonProps): React.JSX.Element {
  const t = useTranslation();
  const { grid, starts } = props;
  const duration = gridDuration(grid);
  /**
   * Whether a cut at this time would make a new segment.
   * @param time - The time, null while no frame is shown.
   * @returns True when it splits a segment.
   * @throws {never} Never.
   */
  const makesCut = (time: number | null): time is number => {
    if (time === null || !(time > 0 && time < duration)) return false;
    // The clock is the presented frame's mediaTime, whose grid frame is round(mediaTime × fps) (frames-split §4.3).
    const frame = frameIndexOfMediaTime(time, grid);
    return frame > 0 && !starts.includes(gridSeconds(grid, frame));
  };
  const shown = useShownTime(props.liveClock, props.presentedTime);
  return <Button variant='outline' size='compact' data-testid='video-add-cut' disabled={props.disabled || !makesCut(shown)} onClick={() => { const time = props.liveClock?.read() ?? props.presentedTime; if (makesCut(time)) props.onAdd(gridSeconds(grid, frameIndexOfMediaTime(time, grid))); }} icon={<Plus className='size-3' />}>{t('canvas.miniTool.videoUI.atCursor')}</Button>;
});

interface FrameCardsProps { source: VideoPresentationSource | null; grid: VideoPlanGrid; frames: readonly number[]; aspect: number; onSeek?: (time: number) => void }

/**
 * Decodes the selected frame into one preview filling the row (canvas design §4 frames row).
 * @param props - The selected source frame and canonical source.
 * @returns Real images, their exact source timestamps, and visible read failures.
 * @throws {never} Decode failures remain visible with a retry action.
 */
function VideoFrameCardRow(props: FrameCardsProps): React.JSX.Element {
  const [retry, setRetry] = React.useState(0);
  const decoded = useVideoFrameThumbnails(props.source, props.frames, retry);
  const t = useTranslation();
  return <div className='grid gap-2'><div className='flex justify-center gap-2'>{props.frames.map((frameIndex) => {
    const image = decoded.frames.find((item) => item.frameIndex === frameIndex);
    const start = gridSeconds(props.grid, frameIndex);
    // A jump to a frame seeks its midpoint (frames-split §4.3).
    return <Button key={frameIndex} variant={null} size={null} className='grid w-full min-w-0 items-stretch justify-stretch overflow-hidden rounded-chrome border border-border text-left' onClick={() => props.onSeek?.(frameMidpointSeconds(frameIndex, props.grid.fps))}><span className='relative block w-full bg-muted' style={{ aspectRatio: props.aspect }}>{image === undefined ? <Skeleton className='absolute inset-0 size-full' /> : <img src={image.url} alt='' data-frame-time={start} className='absolute inset-0 size-full object-contain object-center' />}</span><span className='px-2 py-1 text-xs tabular-nums'>{start.toFixed(3)} s</span></Button>;
  })}</div>{decoded.status === 'failed' ? <div className='flex items-center justify-center gap-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.mediaError')}</span><Button variant='outline' size='compact' onClick={() => setRetry((value) => value + 1)}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : null}</div>;
}

/**
 * The one preview of the selected frame, below the mode row.
 * @param props - The selected frame and its source geometry.
 * @returns The preview root.
 * @throws {never} Never.
 */
function VideoFramePreview(props: FrameCardsProps): React.JSX.Element {
  return <div data-testid='video-frame-previews'><VideoFrameCardRow {...props} /></div>;
}
