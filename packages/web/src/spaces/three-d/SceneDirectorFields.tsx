// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { HexColorPicker } from 'react-colorful';

import {
  SCENE_FOCAL_LENGTH_MAX, SCENE_FOCAL_LENGTH_MIN, SCENE_LIGHT_INTENSITY, SCENE_SPOT_ANGLE_DEFAULT, SCENE_SPOT_ANGLE_MAX,
  SCENE_SPOT_ANGLE_MIN, VIEWFINDER_RATIOS, isSceneCamera, isSceneLight, type SceneObject,
} from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Slider } from '@web/components/ui/slider';
import { Switch } from '@web/components/ui/switch';
import type { ScenePatch } from '@web/data/yjs/scene-document';
import type { SceneSession } from '@web/data/yjs/scene-session';
import { useTranslation } from '@web/i18n/use-translation';
import { whenBlurLeaves } from '@web/lib/blur-left';
import type { SceneField, SceneFieldDraftOwner } from '@web/spaces/three-d/SceneField';
import { keepOnSpaceTab } from '@web/spaces/three-d/SceneRightPanel';
import { takeStepKey } from '@web/spaces/three-d/slider-step-key';

/** Lens presets in millimetres (inner#1694 design 3.2). */
const FOCAL_PRESETS = [14, 24, 35, 50, 70, 100, 200] as const;
const CUSTOM = 'custom';

/**
 * One labelled row.
 * @param root0 - Props.
 * @param root0.label - The row's name.
 * @param root0.labelId - The id the control is labelled by.
 * @param root0.children - The control.
 * @returns The row.
 */
function Row({ label, labelId, children }: { label: string; labelId: string; children: React.ReactNode }): React.JSX.Element {
  return <div className='flex min-h-[var(--btn-inline)] items-center justify-between gap-3'>
    <span id={labelId} className='shrink-0 text-xs text-muted-foreground'>{label}</span>
    <div className='flex min-w-0 items-center justify-end gap-2'>{children}</div>
  </div>;
}

/**
 * A drag that previews and is written once on release, as one undo step (design 3.8).
 * @param session - The command owner.
 * @param id - The object being changed.
 * @returns The begin, preview, commit and cancel callbacks, and a Slider's key handler.
 */
function useContinuousPatch(session: SceneSession, id: string): { begin: () => number; preview: (patch: Omit<ScenePatch, 'id'>) => boolean; commit: () => void; cancel: (press?: number) => void; stepKey: (event: React.KeyboardEvent) => void } {
  // The session owns the press: beginGesture ends whatever an earlier press left, and Escape, a lock, an undo or a loss
  // of focus end its drag, after which its changes preview nothing and its release writes nothing.
  return React.useMemo(() => {
    /**
     * Start a press, refused without edit access or on a locked object.
     * @returns The press, or -1 for a refused one, whose cancel then ends no later press.
     */
    // A gesture keeps one cancelRevision from its start to its end, so it names the press; cancelRevision starts at 0.
    const begin = (): number => (session.beginGesture() ? session.getSnapshot().cancelRevision : -1);
    /** End the press and write what it previewed. */
    const commit = (): void => { session.endGesture(true); };
    return {
      begin,
      preview: (patch: Omit<ScenePatch, 'id'>): boolean => {
        if (!session.getSnapshot().gestureActive) return false;
        session.previewGesture([{ ...patch, id }]);
        return true;
      },
      commit,
      cancel: (press?: number): void => { if (press === undefined || press === session.getSnapshot().cancelRevision) session.endGesture(false); },
      stepKey: (event: React.KeyboardEvent): void => { takeStepKey(event, begin, commit); },
    };
  }, [session, id]);
}

const HEX_TEXT = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
// The picker's width: react-colorful's 200px picker, the popover's p-3 and its border.
const PICKER_WIDTH = 226;
// The popover's gap from the surface it opens from, as PopoverContent's own sideOffset.
const PICKER_GAP = 8;

/**
 * A colour chosen in a react-colorful picker inside a Popover (design 3.8). Each press of the picker, by the mouse or an
 * arrow key, previews and is written once on release; text typed into the hex box is written once, as shown, as a command of its own on Enter or
 * when the box or the popover is left, the way `SceneField` commits; Escape drops both.
 * @param root0 - Props.
 * @param root0.value - The current colour.
 * @param root0.disabled - Whether it can be changed.
 * @param root0.labelId - What names it.
 * @param root0.spaceId - The Space the field belongs to.
 * @param root0.onPressStart - Opens a picker press when the mouse or an arrow key first goes down, and names it.
 * @param root0.onPreview - Shows a colour while picking; false when the press it belongs to has ended.
 * @param root0.onCommit - Writes the previewed colour and ends the press.
 * @param root0.onCancel - Ends the press without writing it; no release of it follows. Given a press, only while that press is
 *   still the open one.
 * @param root0.onWrite - Writes a typed colour.
 * @returns The swatch and its picker.
 */
export const SceneColorField = React.memo(function SceneColorField({ value, disabled, labelId, spaceId, onPressStart, onPreview, onCommit, onCancel, onWrite }: {
  value: string; disabled: boolean; labelId: string; spaceId: string; onPressStart: () => number; onPreview: (hex: string) => boolean;
  onCommit: () => void; onCancel: (press?: number) => void; onWrite: (hex: string) => void;
}): React.JSX.Element {
  // Only this opening of the popover feeds the scene: its exit animation still shows the picker after Escape.
  const live = React.useRef(false);
  const picker = React.useRef<HTMLDivElement>(null);
  // What the box shows while the user is typing; null shows the current colour.
  const [typed, setTyped] = React.useState<string | null>(null);
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const swatch = React.useRef<HTMLButtonElement>(null);
  const [sideOffset, setSideOffset] = React.useState(PICKER_GAP);
  const released = React.useRef(false);
  const [releases, setReleases] = React.useState(0);
  // react-colorful follows its own pointer and shows `value` again only when `value` changes: a change refused because
  // its press has ended remounts the picker, which ends its drag and shows the stored colour.
  const [resyncs, setResyncs] = React.useState(0);
  // The arrow keys held on the picker: one press lasts from the first going down to the last coming up.
  const arrows = React.useRef(new Set<string>());
  // The press the held arrow keys opened; another control's press may have replaced it since.
  const arrowPress = React.useRef<number | undefined>(undefined);
  // react-colorful reports a move from an effect, and a release that follows at once arrives first: the commit runs
  // as a transition, which React renders after flushing the move and its effects.
  React.useEffect(() => { if (released.current) { released.current = false; onCommit(); } }, [releases, onCommit]);
  const pick = React.useCallback((hex: string): void => {
    if (!live.current || onPreview(hex)) return;
    // The remount takes focus off the picker, and with it the held keys' release.
    arrows.current.clear();
    setResyncs((count) => count + 1);
  }, [onPreview]);
  const release = React.useCallback((): void => {
    if (!live.current) return;
    released.current = true;
    React.startTransition(() => setReleases((count) => count + 1));
  }, []);
  // react-colorful ends a press only after a change it has already reported, which a press starting on the current
  // colour and let go right after its first move never has: a mouse press ends at the mouse release itself.
  const onPress = React.useCallback((): void => {
    if (!live.current) return;
    onPressStart();
    window.addEventListener('mouseup', release, { once: true });
  }, [onPressStart, release]);
  // Arrow keys on the picker are a press of their own, ended on the release of the last one held (auto-repeats and a
  // second key belong to it): react-colorful reports no end for a step that changed nothing. The picker holds focus
  // through a mouse press and an arrow press alike, so it takes Escape itself: a hover tooltip shown meanwhile is the
  // top layer and keeps Escape from the popover.
  const onPickerKey = React.useCallback((event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') { arrows.current.clear(); onCancel(); return; }
    if (!live.current || !event.key.startsWith('Arrow')) return;
    if (arrows.current.size === 0) arrowPress.current = onPressStart();
    arrows.current.add(event.key);
  }, [onPressStart, onCancel]);
  const onPickerKeyUp = React.useCallback((event: React.KeyboardEvent): void => {
    if (arrows.current.delete(event.key) && arrows.current.size === 0) release();
  }, [release]);
  // react-colorful also ends a change on each arrow key's release, before this field sees which keys are still held.
  const endChange = React.useCallback((): void => { if (arrows.current.size === 0) release(); }, [release]);
  /** End an arrow press whose keys' release can no longer reach the picker, without writing it. */
  const dropArrows = React.useCallback((): void => {
    if (arrows.current.size === 0) return;
    arrows.current.clear();
    onCancel(arrowPress.current);
  }, [onCancel]);
  // Focus leaving the picker, for the rest of the page or another window, takes the held keys' release with it.
  const onPickerBlur = React.useCallback((event: React.FocusEvent): void => {
    if (!(event.relatedTarget instanceof Node && picker.current?.contains(event.relatedTarget))) dropArrows();
  }, [dropArrows]);
  const settle = React.useCallback((): void => {
    setTyped(null);
    const digits = typed === null ? undefined : HEX_TEXT.exec(typed)?.[1]?.toLowerCase();
    if (!digits) return;
    const hex = `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits}`;
    if (hex !== value) onWrite(hex);
  }, [typed, value, onWrite]);
  const onOpenChange = React.useCallback((open: boolean): void => {
    if (open) {
      live.current = true;
      // In its Space, the popover hides with the Space and a Space tab press keeps the caret in the box.
      const outlet = document.querySelector<HTMLElement>(`[data-space-outlet="${CSS.escape(spaceId)}"]`);
      setContainer(outlet);
      // Beside the right panel, the picker opens outside it so the fields it belongs to stay readable; with no room
      // there it opens next to the swatch.
      const trigger = swatch.current;
      const panel = trigger?.closest<HTMLElement>('[data-testid="scene-right-panel"]') ?? null;
      const inset = trigger && panel ? trigger.getBoundingClientRect().left - panel.getBoundingClientRect().left : 0;
      const room = panel && outlet ? panel.getBoundingClientRect().left - outlet.getBoundingClientRect().left : 0;
      setSideOffset(room >= PICKER_WIDTH + PICKER_GAP ? inset + PICKER_GAP : PICKER_GAP);
      return;
    }
    settle();
    dropArrows();
    live.current = false;
  }, [spaceId, settle, dropArrows]);
  const onEscapeKeyDown = React.useCallback((): void => { setTyped(null); onCancel(); }, [onCancel]);
  const onType = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    setTyped(`#${event.currentTarget.value.replace(/[^0-9a-f]/gi, '').slice(0, 6)}`);
  }, []);
  const onBlur = React.useCallback((event: React.FocusEvent<HTMLInputElement>): void => {
    // A press on the picker decides the colour: the box drops its text and shows the colour again.
    if (event.relatedTarget instanceof Node && picker.current?.contains(event.relatedTarget)) setTyped(null);
    else whenBlurLeaves(spaceId, settle);
  }, [spaceId, settle]);
  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>): void => { if (event.key === 'Enter') settle(); }, [settle]);
  return <Popover onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <Button ref={swatch} variant={null} size={null} aria-labelledby={labelId} disabled={disabled}
        className='size-6 rounded-full border border-swatch-border transition hover-enabled:border-active-border hover-enabled:opacity-70 disabled:cursor-not-allowed disabled:opacity-50'
        style={{ backgroundColor: value }} />
    </PopoverTrigger>
    <PopoverContent container={container} side='left' align='start' sideOffset={sideOffset} className='w-auto space-y-2 p-3'
      onEscapeKeyDown={onEscapeKeyDown} onInteractOutside={keepOnSpaceTab}>
      {/* react-colorful injects its own unlayered corners (8px); an important utility outranks them, as the canvas picker does. */}
      <div ref={picker} onBlur={onPickerBlur} className='[&_.react-colorful__last-control]:!rounded-b-overlay [&_.react-colorful__saturation]:!rounded-t-overlay'><HexColorPicker key={resyncs} color={value} onChange={pick} onChangeEnd={endChange} onMouseDown={onPress} onKeyDown={onPickerKey} onKeyUp={onPickerKeyUp} /></div>
      <Input value={typed ?? value} onChange={onType} onBlur={onBlur} onKeyDown={onKeyDown} spellCheck={false} autoComplete='off'
        className='h-[var(--btn-inline)] rounded-content-sm bg-background px-2 text-xs uppercase tabular-nums md:text-xs' />
    </PopoverContent>
  </Popover>;
});

export interface SceneDirectorFieldsProps extends SceneFieldDraftOwner {
  object: SceneObject;
  session: SceneSession;
  canEdit: boolean;
  spaceId: string;
  Field: typeof SceneField;
  /** Show the name and the lock as well, as inside the director console. */
  compact: boolean;
}

/**
 * A camera's lens and frame or a light's colour, intensity, shadow and angle (design 3.2), shared by the director
 * console and the properties panel.
 * @param props - See {@link SceneDirectorFieldsProps}.
 * @returns The fields, or nothing for another kind of object.
 */
export const SceneDirectorFields = React.memo(function SceneDirectorFields(props: SceneDirectorFieldsProps): React.JSX.Element | null {
  const { object, session, canEdit, spaceId, Field, compact, fieldDrafts, onFieldDraftChange } = props;
  const t = useTranslation();
  const ids = React.useId();
  const disabled = !canEdit || object.locked;
  const continuous = useContinuousPatch(session, object.id);
  const { preview } = continuous;
  const previewColor = React.useCallback((color: string): boolean => preview({ color }), [preview]);
  /**
   * Write one field change.
   * @param patch - The fields.
   */
  const patch = React.useCallback((fields: Omit<ScenePatch, 'id'>): void => {
    session.execute({ type: 'patch', patches: [{ ...fields, id: object.id }] });
  }, [session, object.id]);
  const writeColor = React.useCallback((color: string): void => patch({ color }), [patch]);
  const commitName = React.useCallback((text: string): boolean => {
    const next = text.trim();
    return next === '' || session.execute({ type: 'patch', patches: [{ id: object.id, name: next }] }).ok;
  }, [session, object.id]);
  const commitFocal = React.useCallback((text: string): boolean => {
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) return false;
    return session.execute({ type: 'patch', patches: [{ id: object.id, focalLength: Math.min(SCENE_FOCAL_LENGTH_MAX, Math.max(SCENE_FOCAL_LENGTH_MIN, value)) }] }).ok;
  }, [session, object.id]);
  const toggleLock = React.useCallback((locked: boolean): void => { session.execute({ type: 'lock', ids: [object.id], locked }); }, [session, object.id]);

  const head = compact ? <>
    <Field key={`${object.id}:name`} label={t('spaces.threeD.name')} value={object.name} disabled={disabled} spaceId={spaceId}
      draftKey={`${object.id}:name`} draft={fieldDrafts.get(`${object.id}:name`)} onFieldDraftChange={onFieldDraftChange} onCommit={commitName} />
  </> : null;
  const lock = compact ? <Row label={t('spaces.threeD.lock')} labelId={`${ids}-lock`}>
    <Switch aria-labelledby={`${ids}-lock`} checked={object.locked} disabled={!canEdit} onCheckedChange={toggleLock} />
  </Row> : null;

  if (isSceneCamera(object)) {
    const preset = FOCAL_PRESETS.find((value) => value === object.focalLength);
    return <div className='space-y-2' data-testid={`scene-director-fields-${object.id}`}>
      {head}
      <Row label={t('spaces.threeD.focalLength')} labelId={`${ids}-focal`}>
        <Select value={preset === undefined ? CUSTOM : String(preset)} disabled={disabled}
          onValueChange={(next) => { if (next !== CUSTOM) patch({ focalLength: Number(next) }); }}>
          <SelectTrigger aria-labelledby={`${ids}-focal`} className='h-[var(--btn-inline)] w-auto min-w-20 gap-2 px-2 text-xs'><SelectValue /></SelectTrigger>
          <SelectContent>
            {FOCAL_PRESETS.map((value) => <SelectItem key={value} value={String(value)}>{`${value} mm`}</SelectItem>)}
            <SelectItem value={CUSTOM}>{t('spaces.threeD.director.customFocal')}</SelectItem>
          </SelectContent>
        </Select>
        <div className='w-16'>
          <Field key={`${object.id}:focal`} label='mm' numeric value={String(Number(object.focalLength.toFixed(1)))} disabled={disabled} spaceId={spaceId}
            draftKey={`${object.id}:focal`} draft={fieldDrafts.get(`${object.id}:focal`)} onFieldDraftChange={onFieldDraftChange} onCommit={commitFocal} />
        </div>
      </Row>
      <Row label={t('spaces.threeD.frame')} labelId={`${ids}-frame`}>
        <Select value={object.frame} disabled={disabled} onValueChange={(next) => {
          const frame = VIEWFINDER_RATIOS.find((key) => key === next);
          if (frame) patch({ frame });
        }}>
          <SelectTrigger aria-labelledby={`${ids}-frame`} className='h-[var(--btn-inline)] w-auto min-w-16 gap-2 px-2 text-xs'><SelectValue /></SelectTrigger>
          <SelectContent>{VIEWFINDER_RATIOS.map((key) => <SelectItem key={key} value={key}>{key}</SelectItem>)}</SelectContent>
        </Select>
      </Row>
      {lock}
    </div>;
  }
  if (!isSceneLight(object)) return null;
  const { max } = SCENE_LIGHT_INTENSITY[object.model.type];
  const step = object.model.type === 'directional' ? 0.1 : 1;
  return <div className='space-y-2' data-testid={`scene-director-fields-${object.id}`}>
    {head}
    <Row label={t('spaces.threeD.color')} labelId={`${ids}-color`}>
      <SceneColorField value={object.color} disabled={disabled} labelId={`${ids}-color`} spaceId={spaceId}
        onPressStart={continuous.begin} onPreview={previewColor} onCommit={continuous.commit} onCancel={continuous.cancel} onWrite={writeColor} />
    </Row>
    <Row label={t('spaces.threeD.intensity')} labelId={`${ids}-intensity`}>
      <Slider aria-labelledby={`${ids}-intensity`} className='w-28' min={0} max={max} step={step} value={[object.intensity]} disabled={disabled}
        onValueChange={([value]) => { if (value !== undefined) continuous.preview({ intensity: value }); }} onPointerDown={continuous.begin} onKeyDown={continuous.stepKey} onPointerUp={continuous.commit} />
      <span className='w-10 text-right text-xs tabular-nums text-muted-foreground'>{Number(object.intensity.toFixed(1))}</span>
    </Row>
    {/* The director's light row carries the shadow switch itself. */}
    {compact ? null : <Row label={t('spaces.threeD.castShadow')} labelId={`${ids}-shadow`}>
      <Switch aria-labelledby={`${ids}-shadow`} checked={object.castShadow} disabled={disabled} onCheckedChange={(castShadow) => patch({ castShadow })} />
    </Row>}
    {object.model.type === 'spot' ? <Row label={t('spaces.threeD.angle')} labelId={`${ids}-angle`}>
      <Slider aria-labelledby={`${ids}-angle`} className='w-28' min={SCENE_SPOT_ANGLE_MIN} max={SCENE_SPOT_ANGLE_MAX} step={1} value={[object.angle ?? SCENE_SPOT_ANGLE_DEFAULT]}
        disabled={disabled} onValueChange={([value]) => { if (value !== undefined) continuous.preview({ angle: value }); }} onPointerDown={continuous.begin} onKeyDown={continuous.stepKey} onPointerUp={continuous.commit} />
      <span className='w-10 text-right text-xs tabular-nums text-muted-foreground'>{`${Math.round(object.angle ?? SCENE_SPOT_ANGLE_DEFAULT)}°`}</span>
    </Row> : null}
    {lock}
  </div>;
});
