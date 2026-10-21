// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowUp, FlipHorizontal2, FlipVertical2, Film, ImageIcon, Music, RotateCcw, RotateCw, Star } from 'lucide-react';
import * as React from 'react';

import {
  ADJUST_RANGES,
  defaultAdjustValue,
  parseAdjustValue,
  type AdjustValue,
  type DynamicsValue,
  type EqValue,
  type ModelEntry,
} from '@breatic/shared';
import {
  gridShapeOf,
  isModelTool,
  localParamLabelKey,
  pickedCellsOf,
  UPRIGHT,
  type LocalToolSpec,
  type MiniToolMedium,
  type MiniToolParam,
  type MiniToolSlotValue,
  type MiniToolSpec,
  type NumberParam,
} from '@breatic/shared/mini-tools';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Slider } from '@web/components/ui/slider';
import { Switch } from '@web/components/ui/switch';
import { Textarea } from '@web/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { getCachedWaveformLimits } from '@web/data/api/canvas';
import { useTranslation } from '@web/i18n/use-translation';
import { corsUrl } from '@web/lib/cors-url';
import { CanvasPanel } from '@web/spaces/canvas/_shared/CanvasPanel';
import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { SlotTool, type SlotPick } from '@web/spaces/canvas/generate/generate-tools';
import { controlParams, type ModelControl } from '@web/spaces/canvas/generate/model-controls';
import { ModelParamControls } from '@web/spaces/canvas/generate/ModelParamControls';
import { PARAM_OPTION_CLASS, ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';
import { AudioDynamicsControl } from '@web/spaces/canvas/mini-tool/AudioDynamicsControl';
import { AudioEqControl } from '@web/spaces/canvas/mini-tool/AudioEqControl';
import { AudioWaveform } from '@web/spaces/canvas/mini-tool/AudioWaveform';
import { waveformDrawable } from '@web/spaces/canvas/mini-tool/audio-waveform';
import { DrawingControls } from '@web/spaces/canvas/mini-tool/DrawingControls';
import { MarkControls } from '@web/spaces/canvas/mini-tool/MarkControls';
import { EXPAND_RATIOS, type ExpandRatio } from '@web/spaces/canvas/mini-tool/expand-frame';
import { FilmStrip } from '@web/spaces/canvas/mini-tool/FilmStrip';
import {
  BLOCKING_REFUSALS,
  aspectRatioOf,
  rectForAspect,
  setRectSide,
  hiddenParams,
  slotOptional,
  type CropRect,
  type MiniToolRefusal,
  type MiniToolSourceInfo,
  type SizeTierChoice,
} from '@web/spaces/canvas/mini-tool/mini-tool-view';

/** What a slot holds in the draft. */
type HeldSlot = MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined;

export interface MiniToolPanelProps {
  spec: MiniToolSpec;
  /** A model tool's controls, read from its pinned model. */
  modelControls: readonly ModelControl[] | undefined;
  /** The pinned model's catalog entry, for a model tool. */
  modelEntry: ModelEntry | undefined;
  /** The params the run would be sent. */
  params: Readonly<Record<string, unknown>>;
  /** Called with the changed params only. */
  onParams: (partial: Record<string, unknown>) => void;
  source: MiniToolSourceInfo;
  /** A model tool's params chosen as output sizes, as they fall on the source. */
  sizeTiers: readonly SizeTierChoice[];
  slots: Readonly<Record<string, HeldSlot>>;
  /** How many items each list slot holds at most. */
  slotCaps: Readonly<Record<string, number | undefined>>;
  /** The slot whose pick is running, if any. */
  pickingSlot: string | null;
  onPickSlot: (slotKey: string) => void;
  onClearSlot: (slotKey: string, url?: string) => void;
  prompt: string;
  onPrompt: (prompt: string) => void;
  /** The cost line beside Run. */
  creditText: string;
  refusal: MiniToolRefusal;
  onRun: () => void;
  onClose: () => void;
  /** An expand tool's ratio presets: the one in use, which fit under the model's cap, and the setter. */
  expand?: {
    ratio: ExpandRatio;
    fits: (ratio: ExpandRatio) => boolean;
    onRatio: (ratio: ExpandRatio) => void;
  };
}

/**
 * An expand tool's ratio presets. A ratio whose frame would pass the model's
 * cap reads as unavailable and says why on hover; it stays a hoverable
 * control, since a natively disabled button takes no pointer and could not
 * say so.
 * @param props - Component props.
 * @param props.expand - The presets.
 * @returns The group.
 */
const ExpandRatioGroup = React.memo(function ExpandRatioGroup({
  expand,
}: {
  expand: NonNullable<MiniToolPanelProps['expand']>;
}): React.JSX.Element {
  const t = useTranslation();
  // The draft's own export, as the frame and the drawing controls read it.
  const exporting = useCanvasSession((s) => s.miniTool?.exporting ?? false);
  return (
    <div>
      <p className='mb-1.5 text-xs font-medium text-muted-foreground'>{t('canvas.miniTool.param.aspect.label')}</p>
      {/* Free and seven fixed ratios in two even rows of four, each portrait and landscape pair side by side. */}
      <div className='grid grid-cols-4 gap-1.5'>
        {EXPAND_RATIOS.map((ratio) => {
          const fits = expand.fits(ratio);
          // Value names stay English in every language, as the crop's do.
          const button = (
            <Button
              key={ratio}
              type='button'
              variant={null}
              size={null}
              data-testid={`mini-tool-expand-ratio-${ratio}`}
              aria-current={expand.ratio === ratio}
              aria-disabled={!fits || exporting}
              onClick={() => {
                if (fits && !exporting) expand.onRatio(ratio);
              }}
              className={`${PARAM_OPTION_CLASS} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
            >
              {ratio === 'free' ? 'Free' : ratio}
            </Button>
          );
          return fits ? (
            button
          ) : (
            <Tooltip key={ratio}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side='top'>{t('canvas.miniTool.panel.ratioTooLarge')}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
});

/** The icon an empty slot shows: what it wants. */
const SLOT_ICONS = { image: ImageIcon, audio: Music, video: Film } as const;

/** The adjust's channels in titled groups (light, color, detail, effects), in the order the panel lists them; each slider runs over its `ADJUST_RANGES` range. */
const ADJUST_GROUPS: readonly { id: 'light' | 'color' | 'detail' | 'effects'; fields: readonly (keyof AdjustValue)[] }[] = [
  { id: 'light', fields: ['exposure', 'highlights', 'shadows', 'contrast'] },
  { id: 'color', fields: ['saturation', 'vibrance', 'temperature', 'tint', 'hue'] },
  { id: 'detail', fields: ['sharpness', 'noiseReduction', 'clarity'] },
  { id: 'effects', fields: ['vignette', 'grain', 'fade'] },
];

/**
 * A slot's picks as a list.
 * @param held - What the slot holds.
 * @returns Zero or more picks.
 */
function picksOf(held: HeldSlot): readonly MiniToolSlotValue[] {
  if (held === undefined) return [];
  return Array.isArray(held) ? (held as readonly MiniToolSlotValue[]) : [held as MiniToolSlotValue];
}

/**
 * What a slot button paints for one pick.
 * @param accepts - The slot's medium.
 * @param value - The pick.
 * @returns The pick as the slot button takes it.
 */
function slotPick(accepts: MiniToolMedium, value: MiniToolSlotValue): SlotPick {
  const thumbnail = accepts === 'image' ? value.url : value.cover;
  return { kind: accepts, url: value.url, ...(thumbnail !== undefined && { thumbnail }) };
}

/** One size tier: its name over the pixel size it comes to, in the option chrome. */
const SIZE_TIER_CLASS =
  'flex min-w-0 flex-col items-center gap-0.5 rounded-overlay border border-border px-2 py-1.5 text-xs text-foreground ' +
  'transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
  'aria-[current=true]:border-active-border aria-[current=true]:bg-accent-strong aria-[current=true]:hover:bg-accent-strong ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

/**
 * A megapixel param as output sizes: each tier names its size on the source.
 * @param props - Component props.
 * @param props.choice - The tiers on the source and the one in use.
 * @param props.label - The control's name.
 * @param props.onParams - Called with the picked tier's label.
 * @returns The group.
 */
const SizeTierGroup = React.memo(function SizeTierGroup({
  choice,
  label,
  onParams,
}: {
  choice: SizeTierChoice;
  label: string;
  onParams: (partial: Record<string, unknown>) => void;
}): React.JSX.Element {
  return (
    <div>
      <p className='mb-1.5 text-xs font-medium text-muted-foreground'>{label}</p>
      <div className='grid grid-cols-3 gap-1.5'>
        {choice.options.map((option) => (
          <Button
            key={option.label}
            type='button'
            variant={null}
            size={null}
            data-testid={`mini-tool-size-${choice.key}-${option.label}`}
            aria-current={option.label === choice.selected}
            disabled={!option.usable}
            onClick={() => onParams({ [choice.key]: option.label })}
            className={SIZE_TIER_CLASS}
          >
            <span>{option.label}</span>
            <span className='text-2xs tabular-nums text-muted-foreground'>
              {/* The model settles the exact size on its own rounding. */}
              ≈{option.width}×{option.height}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
});

/**
 * A picked picture shown large in place of the controls it decides, with a
 * line saying so (inner#1304). It is removed from its slot's thumbnail; the
 * picture fills the column's height, whole.
 * @param root0 - Props.
 * @param root0.url - The picture.
 * @param root0.note - The line under it.
 * @param root0.title - The heading the column keeps in both states.
 * @param root0.source - Where the light now comes from, beside the heading.
 * @returns The preview.
 */
function ReferencePreview({
  url,
  note,
  title,
  source,
}: {
  url: string;
  note: string;
  title: string;
  source: string;
}): React.JSX.Element {
  return (
    <div className='flex flex-1 flex-col gap-1.5'>
      <div className='flex items-center justify-between gap-2 text-xs font-medium'>
        <span className='shrink-0 whitespace-nowrap text-muted-foreground'>{title}</span>
        <span className='truncate text-foreground'>{source}</span>
      </div>
      <div className='relative aspect-[4/3] flex-1 overflow-hidden rounded-chrome border border-border bg-muted'>
        <img
          data-testid='mini-tool-reference-preview'
          src={corsUrl(url)}
          alt=''
          className='absolute inset-0 h-full w-full object-contain'
        />
      </div>
      <p className='text-xs text-muted-foreground'>{note}</p>
    </div>
  );
}

/**
 * Seconds as `m:ss.s`.
 * @param seconds - The time.
 * @returns The text.
 */
function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * The parameter panel of one mini-tool (inner#888 §7.6): the tool's controls,
 * its slots and prompt, and a footer with the cost and Run.
 * @param props - Component props.
 * @returns The panel.
 */
export const MiniToolPanel = React.memo(function MiniToolPanel(props: MiniToolPanelProps): React.JSX.Element {
  const {
    spec,
    modelControls,
    modelEntry,
    params,
    onParams,
    sizeTiers,
    slots,
    slotCaps,
    pickingSlot,
    onPickSlot,
    onClearSlot,
    prompt,
    onPrompt,
    creditText,
    refusal,
    onRun,
    onClose,
  } = props;
  const t = useTranslation();
  const blocked = BLOCKING_REFUSALS.has(refusal);
  // A prompt that may stay empty is an addition, drawn last across the panel;
  // one that holds Run back is the tool's main input, drawn before the params.
  const promptFirst = spec.prompt?.defaultText === undefined;
  const promptBox = spec.prompt !== undefined ? (
    <Textarea
      data-testid='mini-tool-prompt'
      value={prompt}
      placeholder={t(spec.prompt.placeholderKey)}
      onChange={(event) => onPrompt(event.target.value)}
      rows={3}
      className='resize-none text-sm'
    />
  ) : null;
  const columns = spec.panel?.columns;
  const filledRule = spec.panel?.whenSlotFilled;
  const hidden = new Set(hiddenParams(spec, slots));
  const reference = filledRule === undefined ? undefined : picksOf(slots[filledRule.slot])[0];
  const referenceShown = filledRule !== undefined && reference !== undefined ? { key: filledRule.slot, url: reference.url } : undefined;
  const visibleControls = (modelControls ?? []).filter((control) => !controlParams(control).some((key) => hidden.has(key)));
  const leftKeys = new Set(columns?.left ?? []);
  const leftControls = visibleControls.filter((control) => controlParams(control).some((key) => leftKeys.has(key)));
  const rightControls = visibleControls.filter((control) => !leftControls.includes(control));
  /**
   * The model's controls, drawn on the source.
   * @param controls - Which of them.
   * @param className - In a column, `contents`: each control is spaced as one of the column's own groups.
   * @returns The block, or null when there are none.
   */
  const controlsOf = (controls: readonly ModelControl[], className?: string): React.ReactNode =>
    modelEntry !== undefined && controls.length > 0 ? (
      <ModelParamControls
        model={modelEntry}
        mode=''
        value={params}
        onChange={onParams}
        controls={controls}
        evenOptions
        {...(className !== undefined && { className })}
        {...(props.source.url !== undefined && { subjectUrl: props.source.url })}
        {...(referenceShown !== undefined && { autoNote: t('canvas.miniTool.relight.fromReference') })}
      />
    ) : null;
  const sizeTierGroups = sizeTiers.map((choice) => (
    <SizeTierGroup
      key={choice.key}
      choice={choice}
      label={t(`canvas.generatePanel.param.${choice.key}`)}
      onParams={onParams}
    />
  ));
  const tiles = spec.slots.length > 0 ? (
    <div className='flex flex-wrap gap-1.5'>
      {spec.slots.map((slot) => {
        const picks = picksOf(slots[slot.key]);
        // A required slot says so only while it holds nothing; a filled
        // tile is as wide as its empty word, so the picture is not a strip.
        const required = !slotOptional(slot, modelEntry) && picks.length === 0;
        const label = t('canvas.miniTool.panel.slot', { kind: slot.accepts, required: required ? 'yes' : 'no' });
        const testId = `mini-tool-slot-${spec.id}-${slot.key}`;
        const cap = slotCaps[slot.key];
        const room = slot.many ? cap === undefined || picks.length < cap : picks.length === 0;
        return (
          <React.Fragment key={slot.key}>
            {/* A one-item slot is one button, filled or not, so focus
                      returns to it by its test id when a pick ends. */}
            {(slot.many ? picks : []).map((value) => (
              <SlotTool
                key={value.url}
                testId={`${testId}-${value.url}`}
                thumbnailTestId={`${testId}-thumb`}
                clearTestId={`${testId}-clear`}
                Icon={SLOT_ICONS[slot.accepts]}
                onPick={() => onPickSlot(slot.key)}
                active={pickingSlot === slot.key}
                pick={slotPick(slot.accepts, value)}
                onClear={() => onClearSlot(slot.key, slot.many ? value.url : undefined)}
                disabled={false}
                clearLabel={t('canvas.miniTool.panel.clearSlot')}
                label={label}
                tip={t(slot.bannerKey)}
              />
            ))}
            {room || !slot.many ? (
              <SlotTool
                testId={testId}
                thumbnailTestId={`${testId}-thumb`}
                clearTestId={`${testId}-clear`}
                Icon={SLOT_ICONS[slot.accepts]}
                onPick={() => onPickSlot(slot.key)}
                active={pickingSlot === slot.key}
                {...(!slot.many && picks[0] !== undefined && { pick: slotPick(slot.accepts, picks[0]) })}
                onClear={() => onClearSlot(slot.key)}
                disabled={false}
                clearLabel={t('canvas.miniTool.panel.clearSlot')}
                label={label}
                tip={t(slot.bannerKey)}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  ) : null;
  const titleKey = spec.slots.find((slot) => slot.titleKey !== undefined)?.titleKey;
  const slotTiles =
    tiles === null ? null : filledRule === undefined ? (
      titleKey === undefined ? (
        tiles
      ) : (
        <div>
          <p className='mb-1.5 text-xs font-medium text-muted-foreground'>{t(titleKey)}</p>
          {tiles}
        </div>
      )
    ) : (
      <div>
        <div className='mb-1.5 flex items-center justify-between gap-2 text-xs font-medium'>
          <span className='text-muted-foreground'>{t('canvas.miniTool.relight.referenceTitle')}</span>
          <span className='truncate text-muted-foreground'>
            {t(referenceShown === undefined ? 'canvas.miniTool.relight.optional' : 'canvas.miniTool.relight.followsReference')}
          </span>
        </div>
        {tiles}
      </div>
    );
  // A model tool's slots, main prompt, sizes and controls: the whole panel, or
  // its right column; without columns every control is on the right.
  const modelBody = (
    <>
      {slotTiles}
      {promptFirst ? promptBox : null}
      {sizeTierGroups}
      {controlsOf(rightControls, columns ? 'contents' : undefined)}
    </>
  );
  // The adjust's sliders, whose Reset sits in the footer.
  const adjustParam = isModelTool(spec) ? undefined : spec.params.find((param) => param.kind === 'adjust');
  return (
    <CanvasPanel
      title={
        <span data-testid='mini-tool-panel-title' className='text-sm font-semibold'>
          {t(spec.labelKey)}
        </span>
      }
      closeLabel={t('canvas.miniTool.panel.close')}
      closeTestId='mini-tool-panel-close'
      onClose={onClose}
      // The camera sphere lays itself beside its sliders, which takes the wide panel too.
      wide={columns !== undefined || visibleControls.some((control) => control.kind === 'cameraAngle')}
      testId='mini-tool-panel'
    >
      <div className='flex flex-col gap-2.5 px-3 pb-2.5'>
        {spec.drawing !== undefined ? <DrawingControls kind={spec.drawing.kind} /> : null}
        {spec.markup === true ? <MarkControls /> : null}
        {props.expand !== undefined ? (
          <ExpandRatioGroup expand={props.expand} />
        ) : null}
        {isModelTool(spec) ? (
          columns ? (
            <div className='grid grid-cols-2 gap-5'>
              <div data-testid='mini-tool-column-left' className='flex flex-col gap-2.5'>
                {referenceShown !== undefined ? (
                  <ReferencePreview
                    url={referenceShown.url}
                    note={t('canvas.miniTool.relight.referenceNote')}
                    title={t('canvas.miniTool.relight.lightTitle')}
                    source={t('canvas.miniTool.relight.sourceFromReference')}
                  />
                ) : (
                  controlsOf(leftControls)
                )}
              </div>
              <div data-testid='mini-tool-column-right' className='flex flex-col justify-between gap-2.5'>
                {modelBody}
              </div>
            </div>
          ) : (
            modelBody
          )
        ) : (
          <>
            {slotTiles}
            {spec.params.map((param) => (
              <LocalParamControl
                key={param.key}
                param={param}
                spec={spec}
                params={params}
                onParams={onParams}
                source={props.source}
              />
            ))}
          </>
        )}
        {spec.noteKey === undefined ? null : (
          <p data-testid='mini-tool-note' className='text-xs text-muted-foreground'>
            {t(spec.noteKey)}
          </p>
        )}
        {promptFirst ? null : promptBox}
      </div>
      <div className='flex items-center justify-between gap-1.5 border-t border-border px-3 py-2'>
        <div className='flex items-center gap-3'>
          <span
            data-testid='mini-tool-credit'
            className='flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground'
          >
            <Star className='h-3.5 w-3.5' aria-hidden='true' />
            {creditText}
          </span>
          {/* The adjust's Reset clears every slider; it sits in the footer
              beside the credit, at the other end of the row from Run. */}
          {adjustParam === undefined ? null : (
            <Button
              type='button'
              variant='outline'
              size='sm'
              data-testid='mini-tool-adjust-reset'
              onClick={() => onParams({ [adjustParam.key]: defaultAdjustValue })}
              className='gap-1 text-xs'
            >
              <RotateCcw className='h-3 w-3' aria-hidden='true' />
              {t('canvas.miniTool.panel.reset')}
            </Button>
          )}
        </div>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='mini-tool-run'
          aria-label={t('canvas.miniTool.panel.run')}
          disabled={blocked}
          loading={refusal === 'exporting'}
          icon={<ArrowUp className='h-4 w-4' aria-hidden='true' />}
          onClick={onRun}
          className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover-enabled:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
        />
      </div>
    </CanvasPanel>
  );
});

interface LocalParamControlProps {
  param: MiniToolParam;
  spec: LocalToolSpec;
  params: Readonly<Record<string, unknown>>;
  onParams: (partial: Record<string, unknown>) => void;
  source: MiniToolSourceInfo;
}

interface RectSideInputProps {
  side: 'w' | 'h';
  /** The side's size in source pixels. */
  value: number;
  onCommit: (side: 'w' | 'h', value: number) => void;
}

/**
 * One side of the crop, typed as digits. The field holds what is being typed
 * and writes it when the field is left or Enter is pressed, so a side can be
 * cleared and retyped; a field left empty goes back to the side's size.
 * @param root0 - Component props.
 * @param root0.side - Which side.
 * @param root0.value - The side's size.
 * @param root0.onCommit - Receives the typed size.
 * @returns The field.
 */
function RectSideInput({ side, value, onCommit }: RectSideInputProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<string | null>(null);
  /**
   * Write what was typed, if anything, and stop holding it.
   */
  const commit = (): void => {
    if (draft !== null && draft !== '') onCommit(side, Number(draft));
    setDraft(null);
  };
  return (
    <Input
      type='text'
      inputMode='numeric'
      autoComplete='off'
      data-testid={`mini-tool-rect-${side}`}
      aria-label={side === 'w' ? 'W' : 'H'}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
      className='h-8 w-24 text-xs tabular-nums md:text-xs'
    />
  );
}

/**
 * How a number param's value reads beside its slider: signed, as a balance
 * (Center, L n, R n), or as the number and its unit.
 * @param value - The value.
 * @param param - The param.
 * @returns The reading.
 */
function numberReading(value: number, param: NumberParam): string {
  if (param.format === 'signed') return value > 0 ? `+${value}` : String(value);
  if (param.format === 'balance') return value === 0 ? 'Center' : value < 0 ? `L ${-value}` : `R ${value}`;
  return param.unit === undefined ? String(value) : `${value}${param.unit}`;
}

/**
 * The control one browser or container param calls for.
 * @param root0 - Component props.
 * @param root0.param - The param.
 * @param root0.spec - The tool.
 * @param root0.params - The draft params.
 * @param root0.onParams - Called with the changed params.
 * @param root0.source - What the source is showing.
 * @returns The control, or null when it waits on the source's size or length.
 */
function LocalParamControl({ param, spec, params, onParams, source }: LocalParamControlProps): React.JSX.Element | null {
  const t = useTranslation();
  const label = t(localParamLabelKey(param.key));
  const size =
    source.width !== undefined && source.height !== undefined ? { width: source.width, height: source.height } : null;
  switch (param.kind) {
    case 'number':
      return (
        <ParamSliderRow
          name={param.key}
          label={label}
          min={param.min}
          max={param.max}
          step={param.step}
          value={typeof params[param.key] === 'number' ? (params[param.key] as number) : param.default}
          format={(value) => numberReading(value, param)}
          onChange={onParams}
          testIdPrefix='mini-tool-param'
          className={undefined}
        />
      );
    case 'toggle': {
      const on = typeof params[param.key] === 'boolean' ? (params[param.key] as boolean) : param.default;
      return (
        <label className='flex items-center justify-between text-xs font-medium text-muted-foreground'>
          {label}
          <Switch
            data-testid={`mini-tool-param-${param.key}-switch`}
            checked={on}
            onCheckedChange={(checked) => onParams({ [param.key]: checked })}
          />
        </label>
      );
    }
    case 'eq':
      return (
        <AudioEqControl
          value={params[param.key] as EqValue | undefined}
          label={label}
          onChange={(value) => onParams({ [param.key]: value })}
        />
      );
    case 'dynamics':
      return (
        <AudioDynamicsControl
          value={params[param.key] as DynamicsValue | undefined}
          label={label}
          onChange={(value) => onParams({ [param.key]: value })}
        />
      );
    case 'enum': {
      // A rectangle locked to this choice is reshaped with it.
      const locked = spec.params.find((p) => p.kind === 'rect' && p.aspect === param.key);
      return (
        <ParamOptionGroup
          label={label}
          options={param.options.map((option) => ({
            value: option.value,
            label: option.label ?? option.value,
          }))}
          value={typeof params[param.key] === 'string' ? (params[param.key] as string) : param.default}
          onSelect={(value) => {
            const ratio = size === null ? null : aspectRatioOf(value, size);
            onParams(
              locked !== undefined && size !== null && ratio !== null
                ? { [param.key]: value, [locked.key]: rectForAspect(ratio, size) }
                : { [param.key]: value },
            );
          }}
          testIdPrefix={`mini-tool-param-${param.key}`}
        />
      );
    }
    case 'rect': {
      if (size === null) return null;
      const rect = (params[param.key] as CropRect | null | undefined) ?? { x: 0, y: 0, w: size.width, h: size.height };
      const ratio = param.aspect === undefined ? null : aspectRatioOf(params[param.aspect], size);
      /**
       * Write the rectangle after one side is typed.
       * @param side - Which side.
       * @param value - The typed size.
       * @returns Nothing.
       */
      const set = (side: 'w' | 'h', value: number): void =>
        onParams({ [param.key]: setRectSide(rect, side, value, ratio, size) });
      return (
        <div className='flex flex-col gap-1.5'>
          <span className='text-xs font-medium text-muted-foreground'>{label}</span>
          <div className='flex items-center gap-1.5'>
            <RectSideInput side='w' value={Math.round(rect.w)} onCommit={set} />
            <span className='text-xs text-muted-foreground'>×</span>
            <RectSideInput side='h' value={Math.round(rect.h)} onCommit={set} />
          </div>
        </div>
      );
    }
    case 'range': {
      const duration = source.duration;
      if (duration === undefined || duration <= 0) return null;
      const held = params[param.key] as { start: number; end: number } | null | undefined;
      const range = held ?? { start: 0, end: duration };
      const from = (range.start / duration) * 100;
      const to = (range.end / duration) * 100;
      return (
        <div className='flex flex-col gap-1.5'>
          {/* The band shows what stays: the cut-away ends dimmed, the kept span framed. */}
          <div data-testid='mini-tool-range-band' className='relative h-9 overflow-hidden rounded-chrome-sm bg-muted'>
            {source.url !== undefined && source.width !== undefined && source.height !== undefined ? (
              <FilmStrip src={source.url} duration={duration} aspect={source.width / source.height} />
            ) : spec.source === 'audio' && source.url !== undefined && waveformDrawable(source, getCachedWaveformLimits()) ? (
              <AudioWaveform src={source.url} />
            ) : null}
            <div data-part='before' className='absolute inset-y-0 left-0 bg-background/70' style={{ width: `${from}%` }} />
            <div data-part='after' className='absolute inset-y-0 right-0 bg-background/70' style={{ left: `${to}%` }} />
            <div
              data-part='kept'
              className='absolute inset-y-0 rounded-chrome-sm border border-foreground'
              style={{ left: `${from}%`, width: `${to - from}%` }}
            />
            <Slider
              data-testid='mini-tool-range'
              aria-label={label}
              min={0}
              max={duration}
              step={0.1}
              minStepsBetweenThumbs={1}
              value={[range.start, range.end]}
              onValueChange={([start, end]) => {
                if (start !== undefined && end !== undefined) onParams({ [param.key]: { start, end } });
              }}
              className='absolute inset-0 h-full py-0 text-foreground'
              trackClassName='opacity-0'
            />
          </div>
          <div className='flex justify-between text-xs tabular-nums text-muted-foreground'>
            <span>
              {clock(range.start)} – {clock(range.end)}
            </span>
            <span>{t('canvas.miniTool.panel.rangeLength', { seconds: (range.end - range.start).toFixed(1) })}</span>
          </div>
        </div>
      );
    }
    case 'adjust': {
      const value = parseAdjustValue(params[param.key]);
      return (
        <div className='flex flex-col gap-1.5'>
          {/* The height cuts a row in half, which says the list goes on below.
              The scroller runs into the panel's right gutter, so the rows end
              where Reset and the other tools' controls do and the bar shows
              in the gutter. */}
          <ScrollArea className='-mr-3' viewportClassName='max-h-72 pr-3'>
            <div className='flex flex-col gap-3'>
              {ADJUST_GROUPS.map((group) => (
                <section key={group.id} data-testid={`mini-tool-adjust-group-${group.id}`} className='flex flex-col gap-2'>
                  {/* A step smaller and dimmer than the slider labels, so a
                      group's name reads as a heading over them. */}
                  <h3 className='text-2xs font-medium text-foreground-disabled'>{t(`canvas.miniTool.adjustGroup.${group.id}`)}</h3>
                  {group.fields.map((field) => (
                    <ParamSliderRow
                      key={field}
                      name={field}
                      label={t(`canvas.miniTool.adjust.${field}`)}
                      min={ADJUST_RANGES[field].min}
                      max={ADJUST_RANGES[field].max}
                      step={1}
                      origin={0}
                      value={value[field]}
                      format={String}
                      // Each step goes into the session draft as the thumb moves,
                      // so the node's picture follows it (A2); nothing here is in
                      // the document, so no step becomes an undo entry.
                      onDraft={(next) => onParams({ [param.key]: { ...value, [field]: next } })}
                      onChange={(partial) => onParams({ [param.key]: { ...value, ...partial } })}
                      testIdPrefix='mini-tool-adjust'
                      className={undefined}
                    />
                  ))}
                </section>
              ))}
            </div>
          </ScrollArea>
        </div>
      );
    }
    case 'orient': {
      const held = (params[param.key] as typeof UPRIGHT | undefined) ?? UPRIGHT;
      // Each button is one value the orientation can take, and value names are
      // English in every language; the control's own name is the localized one.
      const buttons = [
        { id: 'left', Icon: RotateCcw, label: '−90°', next: { ...held, turns: (held.turns + 3) % 4 } },
        { id: 'right', Icon: RotateCw, label: '90°', next: { ...held, turns: (held.turns + 1) % 4 } },
        { id: 'flipX', Icon: FlipHorizontal2, label: 'Flip H', next: { ...held, flipX: !held.flipX } },
        { id: 'flipY', Icon: FlipVertical2, label: 'Flip V', next: { ...held, flipY: !held.flipY } },
      ] as const;
      return (
        <div className='grid grid-cols-4 gap-1.5'>
          {buttons.map((button) => (
            <Button
              key={button.id}
              type='button'
              variant='outline'
              size='sm'
              data-testid={`mini-tool-orient-${button.id}`}
              aria-pressed={button.id === 'flipX' ? held.flipX : button.id === 'flipY' ? held.flipY : undefined}
              onClick={() => onParams({ [param.key]: button.next })}
              className='min-w-0 gap-1 text-xs aria-pressed:border-active-border aria-pressed:bg-accent-strong aria-pressed:hover-enabled:bg-accent-strong'
            >
              <button.Icon className='h-3.5 w-3.5' aria-hidden='true' />
              {button.label}
            </Button>
          ))}
        </div>
      );
    }
    case 'cells': {
      // The tiles themselves are picked on the node (NodeGridLayer); this row
      // counts them and picks all or none.
      const shape = gridShapeOf(spec, params);
      if (shape === null) return null;
      const total = shape.rows * shape.cols;
      const picked = pickedCellsOf(spec, params)?.length ?? total;
      const all = picked === total;
      return (
        <div className='flex items-center gap-2'>
          <span data-testid='mini-tool-grid-picked' className='text-xs text-muted-foreground'>
            {t('canvas.miniTool.grid.picked', { picked, total })}
          </span>
          <Button
            type='button'
            variant='outline'
            size='sm'
            data-testid='mini-tool-grid-pick-all'
            className='ml-auto text-xs'
            onClick={() =>
              onParams({ [param.key]: all ? Array.from({ length: total }, (_, index) => index) : [] })
            }
          >
            {t(all ? 'canvas.miniTool.grid.pickNone' : 'canvas.miniTool.grid.pickAll')}
          </Button>
        </div>
      );
    }
    case 'list':
      // No tool declares a list yet; video split (inner#1306) brings its cut-point control.
      return null;
  }
}
